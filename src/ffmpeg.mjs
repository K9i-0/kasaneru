// manifestからffmpegのフィルタを組み立てる。
// 合成はYUV 4:2:0（BT.709・リミテッドレンジ）で行う。色変換の行列は入力ごとに明示する。
import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {interpolate} from './anim.mjs';
import {cubeLut, parseFilter} from './cssfilter.mjs';

const SAMPLE_RATE = 48000;
// swscaleの既定の丸めでは、色行列の変換（BT.601→BT.709）で輝度が2段ずれる。正確な丸めを必ず指定する。
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

// 色空間のタグがない動画は、慣例どおり高さ720未満をBT.601、それ以上をBT.709として読む。
function inputMatrix(file) {
  const v = probe(file).find((s) => s.codec_type === 'video');
  const tagged = {bt709: 'bt709', bt470bg: 'bt601', smpte170m: 'bt601'}[v?.color_space];
  return tagged ?? ((v?.height ?? 0) >= 720 ? 'bt709' : 'bt601');
}

// 透過つきの素材（透過PNG・WebP、アルファつきの動画）かどうか。
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

// [[frame, value], ...] を、変数nについてのffmpegの式にする。範囲外は端の値で止まる。
// 区間を半分ずつに分けて if を入れ子にする。先頭から順に入れ子にすると、ffmpegの式は100点ほどで深さの上限に当たる。
export function keyframeExpr(keyframes, easing = 'linear', n = 'n') {
  const ease = EASINGS[easing];
  if (!ease) throw new Error(`unknown easing: ${easing}`);
  if (keyframes.length === 1) return String(keyframes[0][1]);
  // lo〜hi番目の区間（区間iは keyframes[i] から keyframes[i+1] まで）を受け持つ式。
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

// 直線でつなぐキーフレームから、前後の点を結ぶ直線の上にある点を省く（結果は変わらない）。
// コマごとに1点のような細かいキーフレームでも、ffmpegへ渡す式が長くなりすぎないようにする。
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

// CSSのmix-blend-modeの名前 → ffmpegのblendの名前
export const BLEND_MODES = {
  multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', difference: 'difference', exclusion: 'exclusion',
  'hard-light': 'hardlight', 'soft-light': 'softlight', 'color-dodge': 'dodge', 'color-burn': 'burn', 'plus-lighter': 'addition',
};

const isKeyframed = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 速度変更。atempoは1回あたり0.5〜2倍なので、範囲外は重ねがけする。
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
  // コマの区間を時刻の条件にする。境界は半コマ手前に置き、丸め誤差で1コマずれないようにする。
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

  // srcを今の絵の上に重ねる。位置が動くものは4:4:4で重ねる（4:2:0のままだと位置が2px単位に丸められる）。
  // blendを指定すると、CSSのmix-blend-modeと同じく、下の絵とsRGBのまま掛け合わせてから重ねる。
  const overlay = (src, x, y, {moving = false, enable = null, eof = 'repeat', blend = null} = {}) => {
    const n = next();
    const opts = `x=${x}:y=${y}:eof_action=${eof}${enable ? `:enable='${enable}'` : ''}`;
    if (blend) {
      const k = ++uid;
      graph.push(
        // 1. srcを、全体と同じ大きさ・長さの透明な絵の上に置く（出ていない時間は透明になる）。
        `color=black@0:s=${W}x${H}:r=${fps}:d=${sec(N)},format=yuva420p[bt${k}]`,
        `[bt${k}][${src}]overlay=${opts}:format=auto,format=yuva420p,split[bs${k}][ba${k}]`,
        // 2. 下の絵とsrcをRGBにして掛け合わせる。
        `[${cur}]split[bc${k}][bd${k}]`,
        `[bc${k}]scale=${FROM_WORK},format=gbrp[bx${k}]`,
        `[bs${k}]scale=${FROM_WORK},format=gbrp[by${k}]`,
        `[bx${k}][by${k}]blend=all_mode=${BLEND_MODES[blend]}:shortest=0:repeatlast=1,scale=${TO_WORK},format=yuv420p[bm${k}]`,
        // 3. 掛け合わせた結果を、srcの形（アルファ）で切り抜いて下の絵に重ねる。
        `[ba${k}]alphaextract[bk${k}]`,
        `[bm${k}][bk${k}]alphamerge[bo${k}]`,
        `[bd${k}][bo${k}]overlay=x=0:y=0:eof_action=repeat:format=yuv420[${n}]`,
      );
    } else if (moving) graph.push(`[${cur}]format=yuv444p[m${n}]`, `[m${n}][${src}]overlay=${opts}:format=yuv444,format=yuv420p[${n}]`);
    else graph.push(`[${cur}][${src}]overlay=${opts}:format=yuv420[${n}]`);
    cur = n;
  };

  // 形のマスク（角丸・楕円）を白黒の絵として1枚作る。
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
        // color を書いたクリップは、その色で塗った絵を素材にする（暗転・帯・色かぶせ）。
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

        // フィルタを順につなぐ。入力が2本要るフィルタ（マスク）の手前でいったん区切る。
        let head = `[${i}:v]`;
        let chain = [`fps=${fps}`];
        const cut = () => {
          const label = `c${++uid}`;
          graph.push(`${head}${chain.join(',')}[${label}]`);
          head = `[${label}]`;
          chain = [];
          return label;
        };

        // 時間の扱い: 素材をコンポジションのfpsにそろえ、頭を切り、（止める・繰り返す・速度を変える）、表示する長さに切る。
        if (freeze !== undefined) {
          chain.push(`trim=start_frame=${freeze}:end_frame=${freeze + 1}`, 'setpts=PTS-STARTPTS', 'loop=loop=-1:size=1:start=0');
        } else {
          if (trim > 0) chain.push(`trim=start_frame=${trim}`, 'setpts=PTS-STARTPTS');
          if (loopFrames) chain.push(`trim=end_frame=${loopFrames}`, `loop=loop=-1:size=${loopFrames}:start=0`);
          if (rate !== 1) chain.push(`setpts=PTS/${rate}`, `fps=${fps}`);
          // 逆再生は、表示する長さぶんを切り出してから逆順にする。
          if (clip.reverse) chain.push(`trim=end_frame=${dur}`, 'reverse');
        }
        // 素材の一部を切り出す（縦動画化のパンなど）。位置はキーフレームにできる。
        if (crop) {
          const cv = (v) => (isKeyframed(v) ? `'${keyframeExpr(v.keyframes, v.easing, 'n')}'` : v ?? 0);
          chain.push(`crop=${crop.width}:${crop.height}:${cv(crop.x)}:${cv(crop.y)}`);
        }
        // 最後のコマを伸ばしてから1コマ長めに切り、表示区間はoverlayのenableで決める。
        // ちょうどの長さで切ると、overlayが入力の終わりを先に検知して最終コマを落とすことがある。素材が短いときは最後のコマで止まる。
        chain.push('tpad=stop_mode=clone:stop_duration=2', `trim=end_frame=${dur + 1}`, 'setpts=PTS-STARTPTS');

        let alpha = false;
        const needAlpha = () => { if (!alpha) { chain.push('format=yuva420p'); alpha = true; } };
        const fitted = (fw, fh, extra = '') => {
          if (fit === 'fill') return [`scale=${fw}:${fh}${extra}`];
          if (fit === 'contain') return [`scale=${fw}:${fh}:force_original_aspect_ratio=decrease${extra}`];
          return [`scale=${fw}:${fh}:force_original_aspect_ratio=increase${extra}`, `crop=${fw}:${fh}:(iw-${fw})*${align[0]}:(ih-${fh})*${align[1]}`];
        };
        // 色のフィルタは3D LUTにして、sRGBのままかける。
        let lut = null;
        if (css.color) {
          lut = path.join(workDir, `lut_${createHash('sha1').update(get('filter')).digest('hex').slice(0, 10)}.cube`);
          writeFileSync(lut, cubeLut(css.color));
        }

        if (blur) {
          // 強いぼかしは細部が残らないので、縮小してからぼかし、拡大して戻す。
          // CSSのblurと同じく、端は外側の透明と混ざって薄くなる。
          // overlayはRGBで乗算済みアルファを正しく合成しないので、ぼかした後に通常のアルファへ戻す。
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
          // 素材が透過つきなら、そのアルファを保つ（題字などの透過PNGを重ねる）。
          const srcAlpha = !solid && inputHasAlpha(file);
          chain.push(...fitted(w, h, `:${convert}`), srcAlpha ? 'format=yuva420p' : 'format=yuv420p');
          if (srcAlpha) alpha = true;
          if (fit === 'contain') {
            // 余白は透明にして、下の層が見えるようにする。
            needAlpha();
            chain.push(`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
          }
          if (isKeyframed(zoom)) {
            // 動く拡大。zoompanは切り出し位置が整数に丸められて揺れるので、2倍に拡大してから切り出す。
            const z = keyframeExpr(zoom.keyframes, zoom.easing, 'on');
            chain.push(`scale=${w * 2}:${h * 2}:flags=bicubic`, `zoompan=z='${z}':x='iw*${ox}*(1-1/(${z}))':y='ih*${oy}*(1-1/(${z}))':d=1:s=${w}x${h}:fps=${fps}`);
          } else if (zoom !== 1) {
            const zw = Math.round(w * zoom), zh = Math.round(h * zoom);
            chain.push(`scale=${zw}:${zh}`, `crop=${w}:${h}:${Math.round((zw - w) * ox)}:${Math.round((zh - h) * oy)}`);
          }
          if (flip.includes('h')) chain.push('hflip');
          if (flip.includes('v')) chain.push('vflip');
          if (key) {
            // 指定した色に近い所を透明にする（グリーンバックなど）。
            chain.push(`chromakey=${key.color.replace('#', '0x')}:${key.similarity ?? 0.15}:${key.blend ?? 0.05}`, 'format=yuva420p');
            alpha = true;
          }
          if (lut) chain.push(`scale=${FROM_WORK}`, `format=${alpha ? 'gbrap' : 'gbrp'}`, `lut3d=file='${lut}':interp=tetrahedral`, `scale=${TO_WORK}`, `format=${alpha ? 'yuva420p' : 'yuv420p'}`);
        }
        if (isKeyframed(rotate) || rotate !== 0) {
          // 箱の中心で回す（時計回りが正）。はみ出した分は切れ、空いた所は透明になる。
          needAlpha();
          const deg = isKeyframed(rotate) ? keyframeExpr(rotate.keyframes, rotate.easing, 'n') : rotate;
          chain.push(`rotate=a='(${deg})*PI/180':c=none:ow=iw:oh=ih`);
        }
        if (corners) {
          // 四隅（左上・右上・左下・右下）の行き先を全体の座標で指定して、絵をはめ込む（画面の差し替えなど）。
          needAlpha();
          // perspectiveは絵の外側を端の色で埋めるので、絵のまわりに透明の縁を付けてから変形する。
          // 縁の分だけ四隅を外へ広げ、絵そのものの角が指定の位置に来るようにする。
          const B = 4;
          const widen = ([tl, tr, bl, br]) => {
            const out = (p, hx, vy) => [p[0] - (hx[0] - p[0]) * (B / w) - (vy[0] - p[0]) * (B / h), p[1] - (hx[1] - p[1]) * (B / w) - (vy[1] - p[1]) * (B / h)];
            return [out(tl, tr, bl), out(tr, tl, br), out(bl, br, tl), out(br, bl, tr)].map(([px2, py2]) => [px2 + B, py2 + B]);
          };
          const frames = (isKeyframed(corners) ? corners.keyframes : [[0, corners], [1, corners]]).map(([f, c]) => [f, widen(c)]);
          const coord = (ci, axis) => (isKeyframed(corners) ? keyframeExpr(frames.map(([f, c]) => [f, c[ci][axis]]), corners.easing, 'on') : frames[0][1][ci][axis].toFixed(3));
          const pts = [0, 1, 2, 3].map((ci) => `x${ci}='${coord(ci, 0)}':y${ci}='${coord(ci, 1)}'`).join(':');
          // 絵は全体の大きさ（層の箱は使わない）。縁を付けて変形し、縁を落とす。
          chain.push(`pad=${w + 2 * B}:${h + 2 * B}:${B}:${B}:color=black@0`, `perspective=${pts}:sense=destination:eval=frame`, `crop=${W}:${H}:${B}:${B}`);
        }
        if (radius > 0 || mask) {
          // マスク: 角丸（radius）、楕円（mask: "ellipse"）、白黒の画像（mask: ファイル。白い所が残る）。
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
            // 透明度のキーフレームは、コマごとの値を「その時刻にフィルタの設定を変える命令」にして渡す。
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
        // 開始位置はコマ数から正確に計算する（秒へ丸めた値を足すと、切り捨てで1コマ早まることがある）。
        chain.push(`setpts='round(PTS+${from}/(${fps}*TB))'`);
        const label = cut();

        // 位置のずらし（揺れ・パン）。キーフレームはクリップの先頭からのコマ数で書く。
        const local = `(t*${fps}-${from})`;
        // 揺れ: 周期の違う正弦波を2つ足した動き。乱数ではないので、何度書き出しても同じ絵になる。
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
        // 透視合成したクリップは全体の大きさになっているので、左上に置く。
        const px = corners ? 0 : x, py = corners ? 0 : y;
        overlay(label, pos(px, offsetX, 'x'), pos(py, offsetY, 'y'), {
          moving: isKeyframed(offsetX) || isKeyframed(offsetY) || Boolean(shake),
          enable: whole ? null : during(from, from + dur),
          eof: 'pass',
          blend,
        });

        // volumeを書いたクリップは、その動画の音声も同じタイミングで鳴らす。
        if (clip.volume !== undefined && freeze === undefined && !image && probe(file).some((s) => s.codec_type === 'audio')) {
          clipAudio.push({src: clip.src, from, durationInFrames: dur, trimBefore: trim, playbackRate: rate, loop: clip.loop, reverse: clip.reverse, volume: clip.volume, fadeIn: clip.audioFadeIn, fadeOut: clip.audioFadeOut});
        }
      }
    } else if (layer.type === 'adjust') {
      // 調整レイヤー: ここまでに重ねた絵（全体か region の範囲）に、ぼかし・色・ビネット・粒子をかける。
      const r = layer.region ?? {x: 0, y: 0, width: W, height: H};
      const from = layer.from ?? 0, dur = layer.durationInFrames ?? N - from;
      const css = parseFilter(layer.filter ?? '');
      const k = ++uid;
      const fx = [`crop=${r.width}:${r.height}:${r.x}:${r.y}`];
      if (css.blur) {
        // 端が暗くならないよう、範囲の外側も含めてぼかしてから切り出す。
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
      if (scene.mode === 'sequence') {
        i = addInput('-framerate', String(fps), '-i', scene.pattern);
      } else {
        if (scene.segments.length === 0) continue;
        // 層ごとに入力は1本。絵の切り替え時刻をconcatの一覧で指定する。
        const size = layer.canvas ?? layer.region;
        const lines = ['ffconcat version 1.0'];
        // 表示時間は「次の絵の開始時刻 − この絵の開始時刻」をマイクロ秒で出す。
        // 各区間の長さを個別に丸めて足すと誤差がたまり、切り替わりが1コマ遅れることがある。
        const us = (frame) => Math.round((frame * 1e6) / fps);
        const entry = (file, from, to) => lines.push(`file '${file}'`, `option framerate ${fps}`, `duration ${((us(to) - us(from)) / 1e6).toFixed(6)}`);
        if (layer.opaque) {
          // 不透明な層（JPEG）は透明の絵を挟めないので、何も描かない区間は前の絵を出したまま重ね合わせを止める。
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
        i = addInput('-f', 'concat', '-safe', '0', '-i', list);
      }
      // regionを指定した層は、その範囲だけの小さな絵になっている。
      // canvasを指定した層は好きな大きさの絵で、x・yで置く。xとyはキーフレームにでき、その場合はffmpegが絵を動かす。
      const pos = (v, fallback) => (v === undefined ? fallback : isKeyframed(v) ? `'${keyframeExpr(v.keyframes, v.easing, `(t*${fps})`)}'` : v);
      const moving = isKeyframed(layer.x) || isKeyframed(layer.y);
      // 絵の切り替わりがまばらな入力をそのまま重ねると、ffmpegの同期処理が下の層を1コマ遅らせることがある。
      // fpsで一定間隔のコマ列にしてから重ねる。
      graph.push(`[${i}:v]fps=${fps},scale=${TO_WORK},format=${layer.opaque ? 'yuv420p' : moving ? 'yuva444p' : 'yuva420p'}[s${i}]`);
      overlay(`s${i}`, pos(layer.x, layer.region?.x ?? 0), pos(layer.y, layer.region?.y ?? 0), {moving, enable, blend: layer.blend});
    }
  }

  // 音声: トラックごとに切り出し・速度・フェード・開始位置・音量を付け、最後に足し合わせる。
  // 1コマだけ書き出すときやGIFでは音声を組まない（つながらない枝が残るとffmpegが止まる）。
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
      // 音程を半音単位で変える。再生速度を変えてから、同じ比で長さを戻す。
      const ratio = 2 ** (track.pitch / 12);
      chain.push(`asetrate=${Math.round(SAMPLE_RATE * ratio)}`, `aresample=${SAMPLE_RATE}`, ...atempoChain(1 / ratio));
    }
    chain.push(channels === 1 ? 'pan=stereo|c0=c0|c1=c0' : 'aformat=channel_layouts=stereo');
    if (track.fadeIn) chain.push(`afade=t=in:st=0:d=${sec(track.fadeIn)}`);
    if (track.fadeOut && length !== undefined) chain.push(`afade=t=out:st=${sec(length - track.fadeOut)}:d=${sec(track.fadeOut)}`);
    if (from > 0) chain.push(`adelay=${Math.round((from / fps) * SAMPLE_RATE)}S:all=1`);
    const volume = track.volume ?? 1;
    // キーフレームは [[コマ, 値], ...] と {keyframes, easing} のどちらでも書ける。コマは動画全体のコマ番号（adelayの後に評価する）。
    const points = Array.isArray(volume) ? volume : volume?.keyframes;
    const easing = (!Array.isArray(volume) && volume?.easing) || 'linear';
    if (points) chain.push(`volume=volume='${keyframeExpr(easing === 'linear' ? thinKeyframes(points) : points, easing, `(t*${fps})`)}':eval=frame`);
    else if (volume !== 1) chain.push(`volume=${volume}`);
    graph.push(`[${i}:a]${chain.join(',')}[a${i}]`);
    mixed.push(`[a${i}]`);
  }
  // 仕上げ: 音量を1より上げたトラックがあると合計が振り切れるので、必要ならリミッターとラウドネス調整を最後にかける。
  const m = manifest.master ?? {};
  const master = (m.limiter ? `,alimiter=limit=${m.limiter}:level=disabled` : '')
    + (m.loudnorm ? `,loudnorm=I=${m.loudnorm.i ?? -16}:TP=${m.loudnorm.tp ?? -1.5}:LRA=${m.loudnorm.lra ?? 11},aresample=${SAMPLE_RATE}` : '');
  const withAudio = mixed.length > 0 && !still && format !== 'gif';
  if (withAudio) {
    const cut = range ? `,atrim=start=${sec(range[0])}:end=${sec(range[1] + 1)},asetpts=PTS-STARTPTS` : '';
    graph.push(`${mixed.join('')}amix=inputs=${mixed.length}:normalize=0:duration=longest,apad=whole_dur=${sec(N)},atrim=duration=${sec(N)}${master}${cut}[aout]`);
  }

  // 一部のコマだけを書き出すとき。
  let frames = N;
  if (range) {
    graph.push(`[${cur}]trim=start_frame=${range[0]}:end_frame=${range[1] + 1},setpts=PTS-STARTPTS[vcut]`);
    cur = 'vcut';
    frames = range[1] - range[0] + 1;
  }

  if (format === 'gif' && !still) {
    // GIFは256色なので、全体から色の表を作ってから減色する。
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
    // 編集ソフトへ渡す用（ProRes 422 HQ、音声は無圧縮）。
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
