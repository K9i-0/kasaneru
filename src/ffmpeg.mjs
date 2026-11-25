// Builds the ffmpeg filter from the manifest.
// Compositing is done in YUV 4:2:0 (BT.709, limited range). The color conversion matrix is stated explicitly for each input.
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {interpolate} from './anim.mjs';
import {cubeLut, parseFilter} from './cssfilter.mjs';

const SAMPLE_RATE = 48000;
// With the default rounding of swscale, the color matrix conversion (BT.601→BT.709) shifts luma by 2 levels. Always request accurate rounding.
const ACCURATE = 'accurate_rnd+full_chroma_int';
const TO_WORK = `out_color_matrix=bt709:out_range=tv:flags=bicubic+${ACCURATE}`;
const IMAGE = /\.(png|jpe?g|webp|bmp|gif)$/i;

const probeCache = new Map();
export function probe(file) {
  if (!probeCache.has(file)) {
    const json = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], {encoding: 'utf8'});
    probeCache.set(file, JSON.parse(json).streams);
  }
  return probeCache.get(file);
}

// Video without a color space tag is read, by convention, as BT.601 when the height is under 720 and as BT.709 otherwise.
function inputMatrix(file) {
  const v = probe(file).find((s) => s.codec_type === 'video');
  const tagged = {bt709: 'bt709', bt470bg: 'bt601', smpte170m: 'bt601'}[v?.color_space];
  return tagged ?? ((v?.height ?? 0) >= 720 ? 'bt709' : 'bt601');
}

// Whether the asset has transparency (transparent PNG / WebP, video with alpha).
function inputHasAlpha(file) {
  const v = probe(file).find((s) => s.codec_type === 'video');
  return /^(rgba|bgra|argb|abgr|ya\d|yuva|gbrap|pal8)/.test(v?.pix_fmt ?? '');
}

function inputRange(file) {
  const v = probe(file).find((s) => s.codec_type === 'video');
  return v?.color_range === 'pc' || /^yuvj/.test(v?.pix_fmt ?? '') ? 'pc' : 'tv';
}

const EASINGS = {
  linear: (p) => p,
  inCubic: (p) => `pow(${p},3)`,
  outCubic: (p) => `(1-pow(1-${p},3))`,
  inOutCubic: (p) => `if(lt(${p},0.5),4*pow(${p},3),1-pow(2-2*${p},3)/2)`,
};
export const easingNames = Object.keys(EASINGS);

// Turns [[frame, value], ...] into an ffmpeg expression in the variable n. Outside the range it holds the end value.
// Splits the span in halves and nests the ifs. Nesting in order from the first keyframe hits the depth limit of ffmpeg expressions at around 100 points.
export function keyframeExpr(keyframes, easing = 'linear', n = 'n') {
  const ease = EASINGS[easing];
  if (!ease) throw new Error(`unknown easing: ${easing}`);
  if (keyframes.length === 1) return String(keyframes[0][1]);
  // The expression covering segments lo to hi (segment i runs from keyframes[i] to keyframes[i+1]).
  const build = (lo, hi) => {
    if (hi - lo === 1) {
      const [f0, v0] = keyframes[lo];
      const [f1, v1] = keyframes[lo + 1];
      return `${v0}+(${v1 - v0})*(${ease(`clip((${n}-${f0})/${f1 - f0},0,1)`)})`;
    }
    const mid = (lo + hi) >> 1;
    return `if(lt(${n},${keyframes[mid][0]}),${build(lo, mid)},${build(mid, hi)})`;
  };
  return build(0, keyframes.length - 1);
}

// From keyframes joined by straight lines, drop the points that lie on the line through their neighbors (the result does not change).
// Keeps the expression passed to ffmpeg from getting too long even with dense keyframes, such as one point per frame.
export function thinKeyframes(keyframes) {
  const out = [];
  for (const k of keyframes) {
    while (out.length >= 2) {
      const [f0, v0] = out[out.length - 2], [f1, v1] = out[out.length - 1];
      const onLine = v0 + ((v1 - v0) * (k[0] - f0)) / (f1 - f0);
      if (Math.abs(onLine - k[1]) > 1e-9) break;
      out.pop();
    }
    out.push(k);
  }
  return out;
}

// CSS mix-blend-mode name → ffmpeg blend name
export const BLEND_MODES = {
  multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', difference: 'difference', exclusion: 'exclusion',
  'hard-light': 'hardlight', 'soft-light': 'softlight', 'color-dodge': 'dodge', 'color-burn': 'burn', 'plus-lighter': 'addition',
};

const isKeyframed = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Speed change. One atempo covers 0.5x to 2x, so chain several for values outside that range.
function atempoChain(rate) {
  const parts = [];
  let r = rate;
  while (r > 2) { parts.push('atempo=2'); r /= 2; }
  while (r < 0.5) { parts.push('atempo=0.5'); r /= 0.5; }
  if (Math.abs(r - 1) > 1e-9) parts.push(`atempo=${r}`);
  return parts;
}

export function buildFfmpegArgs({manifest, manifestDir, scenes, out, encoder, crf, audioBitrate, workDir, range = null, still = false, format = 'mp4'}) {
  const {width: W, height: H, fps, durationInFrames: N} = manifest.composition;
  const abs = (p) => path.resolve(manifestDir, p);
  const inputs = [];
  const graph = [];
  let inputCount = 0;
  let step = 0;
  let cur = 'b0';
  const addInput = (...args) => { inputs.push(...args); return inputCount++; };
  const next = () => `b${++step}`;
  const sec = (frames) => (frames / fps).toFixed(6);
  // Turns a span of frames into a condition on time. Boundaries sit half a frame early so that rounding error does not shift them by one frame.
  const during = (from, to) => `gte(t,${((from - 0.5) / fps).toFixed(6)})*lt(t,${((to - 0.5) / fps).toFixed(6)})`;

  const bg = (manifest.background ?? '#000000').replace('#', '0x');
  graph.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${sec(N)},format=rgb24,scale=${TO_WORK},format=yuv420p[b0]`);

  const blanks = new Map();
  const blank = (bw = W, bh = H) => {
    const name = `blank_${bw}x${bh}.png`;
    if (!blanks.has(name)) {
      const file = path.join(workDir, name);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=black@0:s=${bw}x${bh},format=rgba`, '-frames:v', '1', file]);
      blanks.set(name, file);
    }
    return blanks.get(name);
  };

  const FROM_WORK = `in_color_matrix=bt709:in_range=tv:flags=bicubic+${ACCURATE}`;
  let uid = 0;

  // Overlays src on the current picture. Anything whose position moves is overlaid in 4:4:4 (in 4:2:0 the position is rounded to 2 px steps).
  // With blend, as in CSS mix-blend-mode, src is blended with the picture below in sRGB and then overlaid.
  const overlay = (src, x, y, {moving = false, enable = null, eof = 'repeat', blend = null} = {}) => {
    const n = next();
    const opts = `x=${x}:y=${y}:eof_action=${eof}${enable ? `:enable='${enable}'` : ''}`;
    if (blend) {
      const k = ++uid;
      graph.push(
        // 1. Place src on a transparent picture of the same size and length as the whole composition (it is transparent while src is not shown).
        `color=black@0:s=${W}x${H}:r=${fps}:d=${sec(N)},format=yuva420p[bt${k}]`,
        `[bt${k}][${src}]overlay=${opts}:format=auto,format=yuva420p,split[bs${k}][ba${k}]`,
        // 2. Convert the picture below and src to RGB and blend them.
        `[${cur}]split[bc${k}][bd${k}]`,
        `[bc${k}]scale=${FROM_WORK},format=gbrp[bx${k}]`,
        `[bs${k}]scale=${FROM_WORK},format=gbrp[by${k}]`,
        `[bx${k}][by${k}]blend=all_mode=${BLEND_MODES[blend]}:shortest=0:repeatlast=1,scale=${TO_WORK},format=yuv420p[bm${k}]`,
        // 3. Cut the blended result out with the shape (alpha) of src and overlay it on the picture below.
        `[ba${k}]alphaextract[bk${k}]`,
        `[bm${k}][bk${k}]alphamerge[bo${k}]`,
        `[bd${k}][bo${k}]overlay=x=0:y=0:eof_action=repeat:format=yuv420[${n}]`,
      );
    } else if (moving) graph.push(`[${cur}]format=yuv444p[m${n}]`, `[m${n}][${src}]overlay=${opts}:format=yuv444,format=yuv420p[${n}]`);
    else graph.push(`[${cur}][${src}]overlay=${opts}:format=yuv420[${n}]`);
    cur = n;
  };

  // Makes one black-and-white picture for a shape mask (rounded corners, ellipse).
  const shapeMask = (w, h, shape, radius) => {
    const file = path.join(workDir, `mask_${createHash('sha1').update(`${w}x${h}:${shape}:${radius}`).digest('hex').slice(0, 10)}.png`);
    const expr = shape === 'ellipse'
      ? `255*clip((1-hypot((X-${(w - 1) / 2})/${w / 2},(Y-${(h - 1) / 2})/${h / 2}))*${Math.min(w, h) / 2}+0.5,0,1)`
      : `255*clip(${radius}-hypot(max(abs(X-${(w - 1) / 2})-${w / 2 - radius},0),max(abs(Y-${(h - 1) / 2})-${h / 2 - radius},0))+0.5,0,1)`;
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=black:s=${w}x${h},format=gray,geq=lum='${expr}'`, '-frames:v', '1', file]);
    return file;
  };

  const clipAudio = [];

  for (const layer of manifest.layers) {
    if (layer.type === 'video') {
      const w = layer.width ?? W, h = layer.height ?? H, x = layer.x ?? 0, y = layer.y ?? 0;
      const clips = layer.clips ?? [{...layer, type: undefined}];
      for (const clip of clips) {
        // A clip with color uses a picture filled with that color as its asset (blackouts, bars, color overlays).
        const solid = clip.color !== undefined;
        const file = solid ? null : abs(clip.src);
        const image = solid || IMAGE.test(file);
        const from = clip.from ?? 0;
        const dur = clip.durationInFrames ?? N - from;
        const trim = clip.trimBefore ?? 0;
        const rate = clip.playbackRate ?? 1;
        const loopFrames = typeof clip.loop === 'number' ? clip.loop : null;
        const loopAll = clip.loop === true;
        const freeze = clip.freeze;
        const get = (k, fallback) => clip[k] ?? layer[k] ?? fallback;
        const css = parseFilter(get('filter', ''));
        const blur = get('blur', 0) + css.blur;
        const opacity = get('opacity', 1);
        const fixedOpacity = (isKeyframed(opacity) ? 1 : opacity) * css.opacity;
        const zoom = get('scale', 1);
        const [ox, oy] = get('origin', [0.5, 0.5]);
        const fit = get('fit', 'cover');
        const offsetX = get('offsetX', 0), offsetY = get('offsetY', 0);
        const rotate = get('rotate', 0), radius = get('radius', 0), mask = get('mask'), blend = get('blend');
        const fadeIn = clip.fadeIn ?? 0, fadeOut = clip.fadeOut ?? 0;

        const inputOpts = image ? ['-loop', '1', '-framerate', String(fps)] : loopAll ? ['-stream_loop', '-1'] : [];
        const i = solid
          ? addInput('-f', 'lavfi', '-i', `color=c=${clip.color.replace('#', '0x')}:s=${get('width', W)}x${get('height', H)}:r=${fps},format=rgb24`)
          : addInput(...inputOpts, '-i', file);
        const convert = `in_color_matrix=${image ? 'bt601' : inputMatrix(file)}:in_range=${image ? 'pc' : inputRange(file)}:${TO_WORK}`;
        const crop = clip.crop, align = get('align', [0.5, 0.5]), flip = get('flip', ''), key = get('chromaKey'), corners = get('corners'), shake = clip.shake;

        // Chain the filters in order. Break the chain just before a filter that needs two inputs (the mask).
        let head = `[${i}:v]`;
        let chain = [`fps=${fps}`];
        const cut = () => {
          const label = `c${++uid}`;
          graph.push(`${head}${chain.join(',')}[${label}]`);
          head = `[${label}]`;
          chain = [];
          return label;
        };

        // Timing: bring the asset to the composition fps, trim the start, (freeze / loop / change speed), then cut to the displayed length.
        if (freeze !== undefined) {
          chain.push(`trim=start_frame=${freeze}:end_frame=${freeze + 1}`, 'setpts=PTS-STARTPTS', 'loop=loop=-1:size=1:start=0');
        } else {
          if (trim > 0) chain.push(`trim=start_frame=${trim}`, 'setpts=PTS-STARTPTS');
          if (loopFrames) chain.push(`trim=end_frame=${loopFrames}`, `loop=loop=-1:size=${loopFrames}:start=0`);
          if (rate !== 1) chain.push(`setpts=PTS/${rate}`, `fps=${fps}`);
          // For reverse playback, cut out the displayed length first and then reverse it.
          if (clip.reverse) chain.push(`trim=end_frame=${dur}`, 'reverse');
        }
        // Cut out part of the asset (such as panning when converting to vertical video). The position can be keyframed.
        if (crop) {
          const cv = (v) => (isKeyframed(v) ? `'${keyframeExpr(v.keyframes, v.easing, 'n')}'` : v ?? 0);
          chain.push(`crop=${crop.width}:${crop.height}:${cv(crop.x)}:${cv(crop.y)}`);
        }
        // Extend the last frame, cut one frame longer, and set the visible span with the enable option of overlay.
        // When cut to exactly its length, overlay can detect the end of the input first and drop the last frame. When the asset is short, it holds on its last frame.
        chain.push('tpad=stop_mode=clone:stop_duration=2', `trim=end_frame=${dur + 1}`, 'setpts=PTS-STARTPTS');

        let alpha = false;
        const needAlpha = () => { if (!alpha) { chain.push('format=yuva420p'); alpha = true; } };
        const fitted = (fw, fh, extra = '') => {
          if (fit === 'fill') return [`scale=${fw}:${fh}${extra}`];
          if (fit === 'contain') return [`scale=${fw}:${fh}:force_original_aspect_ratio=decrease${extra}`];
          return [`scale=${fw}:${fh}:force_original_aspect_ratio=increase${extra}`, `crop=${fw}:${fh}:(iw-${fw})*${align[0]}:(ih-${fh})*${align[1]}`];
        };
        // Color filters are turned into a 3D LUT and applied in sRGB.
        let lut = null;
        if (css.color) {
          lut = path.join(workDir, `lut_${createHash('sha1').update(get('filter')).digest('hex').slice(0, 10)}.cube`);
          writeFileSync(lut, cubeLut(css.color));
        }

        if (blur) {
          // A strong blur leaves no detail, so scale down, blur, and scale back up.
          // As with CSS blur, the edges mix with the transparency outside and fade.
          // overlay does not composite premultiplied alpha correctly in RGB, so convert back to straight alpha after blurring.
          const d = Math.max(1, Math.floor(blur / 4));
          const sw = Math.round(w / d), sh = Math.round(h / d);
          const sigma = blur / d;
          const pad = Math.ceil(sigma * 3);
          const z = typeof zoom === 'number' ? zoom : 1;
          chain.push(
            ...fitted(sw, sh, `:flags=area+${ACCURATE}:in_color_matrix=${image ? 'bt601' : inputMatrix(file)}:in_range=${image ? 'pc' : inputRange(file)}`), 'format=rgba',
            `pad=iw+${2 * pad}:ih+${2 * pad}:${pad}:${pad}:color=black@0`, `gblur=sigma=${sigma}`, 'unpremultiply=inplace=1',
            `scale=${Math.round((sw + 2 * pad) * d * z)}:${Math.round((sh + 2 * pad) * d * z)}:flags=bilinear`, `crop=${w}:${h}`,
            ...(lut ? [`lut3d=file='${lut}':interp=tetrahedral`] : []),
            `scale=${TO_WORK}`, 'format=yuva420p',
          );
          alpha = true;
        } else {
          // If the asset has transparency, keep its alpha (for overlaying transparent PNGs such as titles).
          const srcAlpha = !solid && inputHasAlpha(file);
          chain.push(...fitted(w, h, `:${convert}`), srcAlpha ? 'format=yuva420p' : 'format=yuv420p');
          if (srcAlpha) alpha = true;
          if (fit === 'contain') {
            // Make the margins transparent so that the layers below show through.
            needAlpha();
            chain.push(`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
          }
          if (isKeyframed(zoom)) {
            // Keyframed scale. zoompan rounds the crop position to integers and jitters, so scale up 2x before cropping.
            const z = keyframeExpr(zoom.keyframes, zoom.easing, 'on');
            chain.push(`scale=${w * 2}:${h * 2}:flags=bicubic`, `zoompan=z='${z}':x='iw*${ox}*(1-1/(${z}))':y='ih*${oy}*(1-1/(${z}))':d=1:s=${w}x${h}:fps=${fps}`);
          } else if (zoom !== 1) {
            const zw = Math.round(w * zoom), zh = Math.round(h * zoom);
            chain.push(`scale=${zw}:${zh}`, `crop=${w}:${h}:${Math.round((zw - w) * ox)}:${Math.round((zh - h) * oy)}`);
          }
          if (flip.includes('h')) chain.push('hflip');
          if (flip.includes('v')) chain.push('vflip');
          if (key) {
            // Make areas close to the given color transparent (green screen and the like).
            chain.push(`chromakey=${key.color.replace('#', '0x')}:${key.similarity ?? 0.15}:${key.blend ?? 0.05}`, 'format=yuva420p');
            alpha = true;
          }
          if (lut) chain.push(`scale=${FROM_WORK}`, `format=${alpha ? 'gbrap' : 'gbrp'}`, `lut3d=file='${lut}':interp=tetrahedral`, `scale=${TO_WORK}`, `format=${alpha ? 'yuva420p' : 'yuv420p'}`);
        }
        if (isKeyframed(rotate) || rotate !== 0) {
          // Rotate around the center of the box (clockwise is positive). Anything that sticks out is cropped, and the uncovered areas are transparent.
          needAlpha();
          const deg = isKeyframed(rotate) ? keyframeExpr(rotate.keyframes, rotate.easing, 'n') : rotate;
          chain.push(`rotate=a='(${deg})*PI/180':c=none:ow=iw:oh=ih`);
        }
        if (corners) {
          // Fit the picture in by giving the destinations of its four corners (top-left, top-right, bottom-left, bottom-right) in composition coordinates (screen replacement and the like).
          needAlpha();
          // perspective fills the outside of the picture with the edge color, so add a transparent border around the picture before transforming.
          // Push the four corners outward by the border so that the corners of the picture itself land on the given positions.
          const B = 4;
          const widen = ([tl, tr, bl, br]) => {
            const out = (p, hx, vy) => [p[0] - (hx[0] - p[0]) * (B / w) - (vy[0] - p[0]) * (B / h), p[1] - (hx[1] - p[1]) * (B / w) - (vy[1] - p[1]) * (B / h)];
            return [out(tl, tr, bl), out(tr, tl, br), out(bl, br, tl), out(br, bl, tr)].map(([px2, py2]) => [px2 + B, py2 + B]);
          };
          const frames = (isKeyframed(corners) ? corners.keyframes : [[0, corners], [1, corners]]).map(([f, c]) => [f, widen(c)]);
          const coord = (ci, axis) => (isKeyframed(corners) ? keyframeExpr(frames.map(([f, c]) => [f, c[ci][axis]]), corners.easing, 'on') : frames[0][1][ci][axis].toFixed(3));
          const pts = [0, 1, 2, 3].map((ci) => `x${ci}='${coord(ci, 0)}':y${ci}='${coord(ci, 1)}'`).join(':');
          // The picture is the size of the whole composition (the layer box is not used). Add the border, transform, then drop the border.
          chain.push(`pad=${w + 2 * B}:${h + 2 * B}:${B}:${B}:color=black@0`, `perspective=${pts}:sense=destination:eval=frame`, `crop=${W}:${H}:${B}:${B}`);
        }
        if (radius > 0 || mask) {
          // Mask: rounded corners (radius), ellipse (mask: "ellipse"), or a black-and-white image (mask: file; white areas are kept).
          needAlpha();
          const maskFile = mask && mask !== 'ellipse' ? abs(mask) : shapeMask(w, h, mask === 'ellipse' ? 'ellipse' : 'round', Math.min(radius, w / 2, h / 2));
          const mi = addInput('-loop', '1', '-framerate', String(fps), '-i', maskFile);
          const mk = `k${++uid}`;
          graph.push(`[${mi}:v]scale=${w}:${h}:flags=bicubic,format=gray[${mk}]`);
          const a = cut();
          head = `[${a}][${mk}]`;
          chain = ['alphamerge=shortest=1'];
        }
        if (fixedOpacity < 1 || isKeyframed(opacity) || fadeIn > 0 || fadeOut > 0) {
          needAlpha();
          if (isKeyframed(opacity)) {
            // Opacity keyframes are passed as per-frame values, each turned into a "command that changes the filter setting at that time".
            const name = `colorchannelmixer@op${++uid}`;
            const frames = opacity.keyframes.map((k) => k[0]), values = opacity.keyframes.map((k) => k[1]);
            const lines = [];
            let last = null;
            for (let f = 0; f <= dur; f++) {
              const v = (interpolate(f, frames, values, opacity.easing ?? 'linear') * css.opacity).toFixed(4);
              if (v !== last) lines.push(`${Math.max(0, (f - 0.5) / fps).toFixed(6)} ${name} aa ${v};`);
              last = v;
            }
            const cmd = path.join(workDir, `opacity_${uid}.cmd`);
            writeFileSync(cmd, lines.join('\n') + '\n');
            chain.push(`sendcmd=f='${cmd}'`, `${name}=aa=${lines.length ? lines[0].split(' ')[3].replace(';', '') : 1}`);
          } else if (fixedOpacity < 1) {
            chain.push(`colorchannelmixer=aa=${fixedOpacity}`);
          }
          if (fadeIn > 0) chain.push(`fade=t=in:st=0:d=${sec(fadeIn)}:alpha=1`);
          if (fadeOut > 0) chain.push(`fade=t=out:st=${sec(dur - fadeOut)}:d=${sec(fadeOut)}:alpha=1`);
        }
        // Compute the start position exactly from the frame count (adding a value rounded to seconds can come out one frame early because of truncation).
        chain.push(`setpts='round(PTS+${from}/(${fps}*TB))'`);
        const label = cut();

        // Position offset (shakes, pans). Keyframes are written in frames from the start of the clip.
        const local = `(t*${fps}-${from})`;
        // Shake: the sum of two sine waves with different periods. No random numbers, so every render produces the same picture.
        const shakeExpr = (axis) => {
          if (!shake) return null;
          const {amplitude = 8, speed = 12, seed = 1, from: sf = 0, durationInFrames: sd = dur, decay = true} = shake;
          const w = (2 * Math.PI * speed) / fps, k = axis === 'x' ? 1 : 1.37;
          const l = `(${local}-${sf})`;
          const env = decay ? `*(1-clip(${l}/${sd},0,1))` : '';
          return `between(${l},0,${sd})*${amplitude}*(sin(${l}*${(w * k).toFixed(5)}+${seed * (axis === 'x' ? 1.7 : 4.1)})+sin(${l}*${(w * k * 1.93).toFixed(5)}+${seed * 2.3}))/2${env}`;
        };
        const pos = (base, offset, axis) => {
          const parts = [String(base)];
          if (isKeyframed(offset)) parts.push(`(${keyframeExpr(offset.keyframes, offset.easing, local)})`);
          else if (offset) parts.push(String(offset));
          const sh = shakeExpr(axis);
          if (sh) parts.push(sh);
          return parts.length === 1 ? base : `'${parts.join('+')}'`;
        };
        const whole = from === 0 && dur >= N;
        // A clip with perspective compositing is already the size of the whole composition, so place it at the top-left.
        const px = corners ? 0 : x, py = corners ? 0 : y;
        overlay(label, pos(px, offsetX, 'x'), pos(py, offsetY, 'y'), {
          moving: isKeyframed(offsetX) || isKeyframed(offsetY) || Boolean(shake),
          enable: whole ? null : during(from, from + dur),
          eof: 'pass',
          blend,
        });

        // A clip with volume also plays the audio of that video at the same position.
        if (clip.volume !== undefined && freeze === undefined && !image && probe(file).some((s) => s.codec_type === 'audio')) {
          clipAudio.push({src: clip.src, from, durationInFrames: dur, trimBefore: trim, playbackRate: rate, loop: clip.loop, reverse: clip.reverse, volume: clip.volume, fadeIn: clip.audioFadeIn, fadeOut: clip.audioFadeOut});
        }
      }
    } else if (layer.type === 'adjust') {
      // Adjustment layer: applies blur, color, vignette, and grain to everything stacked so far (the whole frame, or the area given by region).
      const r = layer.region ?? {x: 0, y: 0, width: W, height: H};
      const from = layer.from ?? 0, dur = layer.durationInFrames ?? N - from;
      const css = parseFilter(layer.filter ?? '');
      const k = ++uid;
      const fx = [`crop=${r.width}:${r.height}:${r.x}:${r.y}`];
      if (css.blur) {
        // Blur with the area outside the region included, then crop, so that the edges do not darken.
        const m = Math.min(Math.ceil(css.blur * 2), r.x, r.y, W - r.x - r.width, H - r.y - r.height);
        fx[0] = `crop=${r.width + 2 * m}:${r.height + 2 * m}:${r.x - m}:${r.y - m}`;
        fx.push(`gblur=sigma=${css.blur}`, `crop=${r.width}:${r.height}:${m}:${m}`);
      }
      if (css.color) {
        const lut = path.join(workDir, `lut_adjust_${k}.cube`);
        writeFileSync(lut, cubeLut(css.color));
        fx.push(`scale=${FROM_WORK}`, 'format=gbrp', `lut3d=file='${lut}':interp=tetrahedral`, `scale=${TO_WORK}`, 'format=yuv420p');
      }
      if (layer.vignette) fx.push(`vignette=angle=${(layer.vignette * Math.PI / 2.2).toFixed(4)}`);
      if (layer.grain) fx.push(`noise=alls=${Math.round(layer.grain * 40)}:allf=t:all_seed=${layer.seed ?? 7}`);
      graph.push(`[${cur}]split[aj${k}][ak${k}]`, `[aj${k}]${fx.join(',')},format=yuv420p[al${k}]`);
      let src = `al${k}`;
      if (layer.radius > 0 || css.opacity < 1) {
        const parts = ['format=yuva420p'];
        if (css.opacity < 1) parts.push(`colorchannelmixer=aa=${css.opacity}`);
        graph.push(`[${src}]${parts.join(',')}[am${k}]`);
        src = `am${k}`;
        if (layer.radius > 0) {
          const mi = addInput('-loop', '1', '-framerate', String(fps), '-i', shapeMask(r.width, r.height, 'round', Math.min(layer.radius, r.width / 2, r.height / 2)));
          graph.push(`[${mi}:v]format=gray[an${k}]`, `[${src}][an${k}]alphamerge=shortest=1[ao${k}]`);
          src = `ao${k}`;
        }
      }
      const base = cur;
      cur = `ak${k}`;
      void base;
      overlay(src, r.x, r.y, {enable: from === 0 && dur >= N ? null : during(from, from + dur)});
    } else if (layer.type === 'scene') {
      const scene = scenes[layer.id];
      if (!scene) continue;
      let i;
      let enable = null;
      // The pictures of one scene input do not all have the same pixel format: a capture with no transparent pixel can come out as RGB,
      // while one with transparency (and the transparent blank used for gaps) is RGBA. By default ffmpeg rebuilds the whole filter graph
      // whenever the format of an input changes. That drops the last picture before each change (a black frame at the end of a --frames
      // range, a black still) and, with many audio inputs in the same graph, can deadlock the render. -reinit_filter 0 keeps the graph,
      // and scale, which converts each frame by its own format, must be the first filter so that every picture is read correctly.
      const sceneInput = ['-reinit_filter', '0'];
      if (scene.mode === 'sequence') {
        i = addInput(...sceneInput, '-framerate', String(fps), '-i', scene.pattern);
      } else {
        if (scene.segments.length === 0) continue;
        // One input per layer. The times at which the picture changes are given in a concat list.
        const size = layer.canvas ?? layer.region;
        const lines = ['ffconcat version 1.0'];
        // Each display time is written in microseconds as "start time of the next picture − start time of this picture".
        // Rounding the length of each span separately and adding them up accumulates error, and a change can come one frame late.
        const us = (frame) => Math.round((frame * 1e6) / fps);
        const entry = (file, from, to) => lines.push(`file '${file}'`, `option framerate ${fps}`, `duration ${((us(to) - us(from)) / 1e6).toFixed(6)}`);
        if (layer.opaque) {
          // An opaque layer (JPEG) cannot have transparent pictures in between, so for spans where nothing is drawn, keep showing the previous picture and switch the overlay off.
          const ranges = [];
          scene.segments.forEach((seg, k) => {
            const start = k === 0 ? 0 : seg.start;
            const end = k === scene.segments.length - 1 ? N : scene.segments[k + 1].start;
            entry(seg.file, start, end);
            const last = ranges[ranges.length - 1];
            if (last && last[1] === seg.start) last[1] = seg.end;
            else ranges.push([seg.start, seg.end]);
          });
          if (!(ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= N)) enable = ranges.map(([a, b]) => during(a, b)).join('+');
        } else {
          let at = 0;
          for (const seg of scene.segments) {
            if (seg.start > at) entry(blank(size?.width, size?.height), at, seg.start);
            entry(seg.file, seg.start, seg.end);
            at = seg.end;
          }
          if (at < N) entry(blank(size?.width, size?.height), at, N);
        }
        const list = path.join(workDir, `${layer.id}.ffconcat`);
        writeFileSync(list, lines.join('\n') + '\n');
        i = addInput(...sceneInput, '-f', 'concat', '-safe', '0', '-i', list);
      }
      // A layer with region is a small picture covering only that area.
      // A layer with canvas is a picture of any size, placed with x and y. x and y can be keyframed, in which case ffmpeg moves the picture.
      const pos = (v, fallback) => (v === undefined ? fallback : isKeyframed(v) ? `'${keyframeExpr(v.keyframes, v.easing, `(t*${fps})`)}'` : v);
      const moving = isKeyframed(layer.x) || isKeyframed(layer.y);
      // Overlaying an input whose pictures change only sparsely as it is can make the sync logic of ffmpeg delay the layer below by one frame.
      // Convert it to a constant-interval frame sequence with fps before overlaying (after scale, which has to come first; see above).
      graph.push(`[${i}:v]scale=${TO_WORK},format=${layer.opaque ? 'yuv420p' : moving ? 'yuva444p' : 'yuva420p'},fps=${fps}[s${i}]`);
      overlay(`s${i}`, pos(layer.x, layer.region?.x ?? 0), pos(layer.y, layer.region?.y ?? 0), {moving, enable, blend: layer.blend});
    }
  }

  // Audio: each track gets its cut, speed, fades, start position, and volume, and the tracks are summed at the end.
  // No audio is built for a single frame or a GIF (a branch left unconnected makes ffmpeg stop).
  const tracks = still || format === 'gif' ? [] : [...clipAudio, ...(Array.isArray(manifest.audio) ? manifest.audio : manifest.audio ? [manifest.audio] : [])];
  const mixed = [];
  for (const track of tracks) {
    const file = abs(track.src);
    const loopAll = track.loop === true || typeof track.loop === 'number';
    const i = addInput(...(loopAll ? ['-stream_loop', '-1'] : []), '-i', file);
    const from = track.from ?? 0;
    const rate = track.playbackRate ?? 1;
    const channels = probe(file).find((s) => s.codec_type === 'audio')?.channels ?? 2;
    const chain = [`aresample=${SAMPLE_RATE}`];
    if (track.trimBefore) chain.push(`atrim=start=${sec(track.trimBefore)}`, 'asetpts=PTS-STARTPTS');
    chain.push(...atempoChain(rate));
    const length = track.durationInFrames ?? (loopAll ? N - from : undefined);
    if (length !== undefined) chain.push(`atrim=duration=${sec(length)}`);
    if (track.reverse) chain.push('areverse');
    if (track.pitch) {
      // Change pitch in semitones: change the playback speed, then restore the length by the same ratio.
      const ratio = 2 ** (track.pitch / 12);
      chain.push(`asetrate=${Math.round(SAMPLE_RATE * ratio)}`, `aresample=${SAMPLE_RATE}`, ...atempoChain(1 / ratio));
    }
    chain.push(channels === 1 ? 'pan=stereo|c0=c0|c1=c0' : 'aformat=channel_layouts=stereo');
    if (track.fadeIn) chain.push(`afade=t=in:st=0:d=${sec(track.fadeIn)}`);
    if (track.fadeOut && length !== undefined) chain.push(`afade=t=out:st=${sec(length - track.fadeOut)}:d=${sec(track.fadeOut)}`);
    if (from > 0) chain.push(`adelay=${Math.round((from / fps) * SAMPLE_RATE)}S:all=1`);
    const volume = track.volume ?? 1;
    // Keyframes can be written as [[frame, value], ...] or as {keyframes, easing}. Frames are frame numbers of the whole video (evaluated after adelay).
    const points = Array.isArray(volume) ? volume : volume?.keyframes;
    const easing = (!Array.isArray(volume) && volume?.easing) || 'linear';
    if (points) chain.push(`volume=volume='${keyframeExpr(easing === 'linear' ? thinKeyframes(points) : points, easing, `(t*${fps})`)}':eval=frame`);
    else if (volume !== 1) chain.push(`volume=${volume}`);
    graph.push(`[${i}:a]${chain.join(',')}[a${i}]`);
    mixed.push(`[a${i}]`);
  }
  // Finishing: a track with volume above 1 can push the sum into clipping, so apply the limiter and loudness normalization last if needed.
  const m = manifest.master ?? {};
  const master = (m.limiter ? `,alimiter=limit=${m.limiter}:level=disabled` : '')
    + (m.loudnorm ? `,loudnorm=I=${m.loudnorm.i ?? -16}:TP=${m.loudnorm.tp ?? -1.5}:LRA=${m.loudnorm.lra ?? 11},aresample=${SAMPLE_RATE}` : '');
  const withAudio = mixed.length > 0 && !still && format !== 'gif';
  if (withAudio) {
    const cut = range ? `,atrim=start=${sec(range[0])}:end=${sec(range[1] + 1)},asetpts=PTS-STARTPTS` : '';
    graph.push(`${mixed.join('')}amix=inputs=${mixed.length}:normalize=0:duration=longest,apad=whole_dur=${sec(N)},atrim=duration=${sec(N)}${master}${cut}[aout]`);
  }

  // When rendering only part of the frames.
  let frames = N;
  if (range) {
    graph.push(`[${cur}]trim=start_frame=${range[0]}:end_frame=${range[1] + 1},setpts=PTS-STARTPTS[vcut]`);
    cur = 'vcut';
    frames = range[1] - range[0] + 1;
  }

  if (format === 'gif' && !still) {
    // GIF has 256 colors, so build a palette from the whole video and then reduce the colors.
    graph.push(`[${cur}]split[g1][g2]`, '[g1]palettegen=stats_mode=diff[gp]', '[g2][gp]paletteuse=dither=bayer:bayer_scale=4[gout]');
    cur = 'gout';
  }

  const script = path.join(workDir, 'filter.txt');
  writeFileSync(script, graph.join(';\n'));
  const args = ['-v', 'error', '-y', ...inputs, '-/filter_complex', script, '-map', `[${cur}]`];
  if (still) {
    args.push('-frames:v', '1', '-update', '1', out);
    return args;
  }
  args.push('-frames:v', String(frames));
  const tags = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
  if (format === 'gif') {
    args.push('-loop', '0', out);
  } else if (format === 'mov') {
    // For handing off to editing software (ProRes 422 HQ, uncompressed audio).
    if (withAudio) args.push('-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE));
    args.push('-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', ...tags, out);
  } else if (format === 'webm') {
    if (withAudio) args.push('-map', '[aout]', '-c:a', 'libopus', '-b:a', audioBitrate ?? '160k');
    args.push('-c:v', 'libvpx-vp9', '-crf', String(Math.round(Number(crf) * 1.7)), '-b:v', '0', '-row-mt', '1', '-pix_fmt', 'yuv420p', ...tags, out);
  } else {
    if (withAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', audioBitrate ?? '192k', '-ar', String(SAMPLE_RATE));
    args.push('-c:v', encoder);
    if (encoder === 'libx264') args.push('-crf', String(crf), '-preset', 'medium');
    else args.push('-q:v', '60');
    args.push('-pix_fmt', 'yuv420p', ...tags, '-movflags', '+faststart', out);
  }
  return args;
}

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, {stdio: ['ignore', 'inherit', 'inherit']});
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}
