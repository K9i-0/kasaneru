// Manifest validation. Before rendering, list every mistake with its location.
import {existsSync} from 'node:fs';
import path from 'node:path';
import {CAPTION_STYLE} from './captions.mjs';
import {parseFilter} from './cssfilter.mjs';
import {BLEND_MODES, easingNames, probe} from './ffmpeg.mjs';

const TOP = ['composition', 'background', 'scenes', 'assets', 'fonts', 'layers', 'audio', 'master', 'props'];
const VISUAL = ['x', 'y', 'width', 'height', 'fit', 'align', 'flip', 'blur', 'opacity', 'scale', 'origin', 'offsetX', 'offsetY', 'rotate', 'radius', 'mask', 'blend', 'filter', 'chromaKey', 'corners'];
const CLIP = ['src', 'color', 'crop', 'reverse', 'shake', 'from', 'durationInFrames', 'trimBefore', 'playbackRate', 'loop', 'freeze', 'fadeIn', 'fadeOut', 'volume', 'audioFadeIn', 'audioFadeOut',
  ...VISUAL.filter((k) => !['x', 'y', 'width', 'height'].includes(k))];
const VIDEO_LAYER = ['type', 'clips', 'sequence', 'overlap', ...VISUAL, ...CLIP];
const ADJUST_LAYER = ['type', 'region', 'from', 'durationInFrames', 'filter', 'vignette', 'grain', 'seed', 'radius'];
const SCENE_LAYER = ['type', 'id', 'scene', 'region', 'canvas', 'x', 'y', 'opaque', 'page', 'blend'];
const AUDIO = ['src', 'from', 'durationInFrames', 'trimBefore', 'playbackRate', 'loop', 'reverse', 'pitch', 'volume', 'fadeIn', 'fadeOut', 'group', 'duck'];

export function validateManifest(manifest, manifestDir, {backend = 'browser'} = {}) {
  const errors = [];
  const warnings = [];
  const err = (where, message) => errors.push({where, message});
  const warn = (where, message) => warnings.push({where, message});
  const isInt = (v) => Number.isInteger(v);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const keys = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${where}.${k}`, `Unknown field. Allowed fields: ${allowed.join(', ')}`);
  };
  const file = (p, where) => {
    if (typeof p !== 'string') { err(where, 'A file path (string) is required'); return null; }
    const full = path.resolve(manifestDir, p);
    if (!existsSync(full)) { err(where, `File not found: ${full}`); return null; }
    return full;
  };
  const keyframes = (v, where, {intFrames = true} = {}) => {
    const list = Array.isArray(v) ? v : v?.keyframes;
    if (!Array.isArray(list) || list.length < 2) return err(where, 'Keyframes must be [[frame, value], ...] with at least 2 entries');
    list.forEach((k, i) => {
      if (!Array.isArray(k) || k.length !== 2 || !isNum(k[0]) || !isNum(k[1]) || (intFrames && !isInt(k[0]))) err(`${where}[${i}]`, 'Must be [frame (integer), value]');
      else if (i > 0 && k[0] <= list[i - 1][0]) err(`${where}[${i}]`, 'The frame must be later than the previous keyframe');
    });
    if (!Array.isArray(v) && v.easing !== undefined && !easingNames.includes(v.easing)) err(`${where}.easing`, `Must be one of ${easingNames.join(', ')}`);
  };
  const numOrKeyframes = (v, where) => { if (!isNum(v)) keyframes(v, where); };
  const blendMode = (v, where) => { if (v !== undefined && !BLEND_MODES[v]) err(where, `Must be one of ${Object.keys(BLEND_MODES).join(', ')}`); };

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return {errors: [{where: '', message: 'The manifest must be an object'}], warnings};
  keys(manifest, TOP, 'manifest');

  const c = manifest.composition ?? {};
  for (const k of ['width', 'height']) if (!isInt(c[k]) || c[k] <= 0) err(`composition.${k}`, 'A positive integer is required');
  // durationInFrames can be omitted (it is set to the end of the latest-ending clip or audio track).
  if (c.durationInFrames !== undefined && (!isInt(c.durationInFrames) || c.durationInFrames <= 0)) err('composition.durationInFrames', 'A positive integer is required (omit it to have it set automatically)');
  if (!isNum(c.fps) || c.fps <= 0) err('composition.fps', 'A positive number is required');
  if (isInt(c.width) && isInt(c.height) && (c.width % 2 || c.height % 2)) err('composition', 'Width and height must be even (an H.264 constraint)');
  const N = c.durationInFrames;
  if (manifest.background !== undefined && !/^#[0-9a-fA-F]{6}$/.test(manifest.background)) err('background', 'Must be in the form #RRGGBB');

  const frame = (v, where, {min = 0} = {}) => { if (!isInt(v) || v < min) err(where, `An integer of ${min} or more (in frames) is required`); };
  const timing = (o, where) => {
    if (o.from !== undefined) frame(o.from, `${where}.from`);
    if (o.durationInFrames !== undefined) frame(o.durationInFrames, `${where}.durationInFrames`, {min: 1});
    if (o.trimBefore !== undefined) frame(o.trimBefore, `${where}.trimBefore`);
    if (o.playbackRate !== undefined && (!isNum(o.playbackRate) || o.playbackRate <= 0)) err(`${where}.playbackRate`, 'A number greater than 0 is required');
    if (o.loop !== undefined && o.loop !== true && o.loop !== false && !(isInt(o.loop) && o.loop > 0)) err(`${where}.loop`, 'Must be true or the length to repeat (in frames)');
    if (isInt(o.from) && isInt(N) && o.from >= N) warn(where, `It starts (${o.from}) at or after the total length (${N}), so it never appears`);
    if (isInt(o.from ?? 0) && isInt(o.durationInFrames) && isInt(N) && (o.from ?? 0) + o.durationInFrames > N) warn(where, `It ends (${(o.from ?? 0) + o.durationInFrames}) past the total length (${N}). The excess is cut off`);
  };

  const visual = (o, where) => {
    for (const k of ['x', 'y', 'width', 'height']) if (o[k] !== undefined && !isInt(o[k])) err(`${where}.${k}`, 'An integer (px) is required');
    for (const k of ['width', 'height']) if (isInt(o[k]) && o[k] % 2) err(`${where}.${k}`, 'Must be even');
    if (o.fit !== undefined && !['cover', 'fill', 'contain'].includes(o.fit)) err(`${where}.fit`, 'Must be one of cover / fill / contain');
    if (o.blur !== undefined && (!isNum(o.blur) || o.blur < 0)) err(`${where}.blur`, 'A number of 0 or more is required');
    if (o.opacity !== undefined) {
      if (isNum(o.opacity)) { if (o.opacity < 0 || o.opacity > 1) err(`${where}.opacity`, 'A number between 0 and 1 is required'); }
      else keyframes(o.opacity, `${where}.opacity`);
    }
    if (o.rotate !== undefined) numOrKeyframes(o.rotate, `${where}.rotate`);
    if (o.radius !== undefined && (!isNum(o.radius) || o.radius < 0)) err(`${where}.radius`, 'A number of 0 or more (px) is required');
    if (o.mask !== undefined && o.mask !== 'ellipse') file(o.mask, `${where}.mask`);
    blendMode(o.blend, `${where}.blend`);
    if (o.filter !== undefined) {
      try { parseFilter(o.filter); } catch (e) { err(`${where}.filter`, e.message); }
    }
    if (o.align !== undefined && !(Array.isArray(o.align) && o.align.length === 2 && o.align.every((v) => isNum(v) && v >= 0 && v <= 1))) err(`${where}.align`, 'Must be [horizontal, vertical], each between 0 and 1 (0.5 is the center)');
    if (o.flip !== undefined && !['h', 'v', 'hv', 'vh'].includes(o.flip)) err(`${where}.flip`, 'Must be one of h (horizontal) / v (vertical) / hv');
    if (o.chromaKey !== undefined) {
      if (typeof o.chromaKey !== 'object' || !/^#[0-9a-fA-F]{6}$/.test(o.chromaKey.color ?? '')) err(`${where}.chromaKey`, 'Must be {color: "#RRGGBB", similarity, blend}');
      else keys(o.chromaKey, ['color', 'similarity', 'blend'], `${where}.chromaKey`);
    }
    if (o.corners !== undefined) {
      const four = (c) => Array.isArray(c) && c.length === 4 && c.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum));
      const list = Array.isArray(o.corners) ? [[0, o.corners]] : o.corners?.keyframes;
      if (!Array.isArray(list) || !list.every((k) => Array.isArray(k) && isInt(k[0]) && four(k[1]))) err(`${where}.corners`, 'Must be four corners [[x, y] x 4] (top-left, top-right, bottom-left, bottom-right) or {keyframes: [[frame, corners], ...]}');
      if (o.blur) err(`${where}.corners`, 'Blur and perspective compositing (corners) cannot be used together');
      if (o.width !== undefined || o.height !== undefined || o.x !== undefined || o.y !== undefined) err(`${where}.corners`, 'A layer with corners cannot have x / y / width / height (the four corners set the position)');
    }
    if (o.fit === 'contain' && o.scale !== undefined && !isNum(o.scale)) err(`${where}.scale`, 'contain and keyframed scale cannot be used together');
    if (o.blend && (o.offsetX !== undefined && !isNum(o.offsetX) || o.offsetY !== undefined && !isNum(o.offsetY))) err(`${where}.blend`, 'A blend mode and a keyframed position cannot be used together');
    if (o.scale !== undefined) numOrKeyframes(o.scale, `${where}.scale`);
    if (o.scale !== undefined && o.blur && !isNum(o.scale)) err(`${where}.scale`, 'Blur and keyframed scale cannot be used together');
    for (const k of ['offsetX', 'offsetY']) if (o[k] !== undefined) numOrKeyframes(o[k], `${where}.${k}`);
    if (o.origin !== undefined && !(Array.isArray(o.origin) && o.origin.length === 2 && o.origin.every(isNum))) err(`${where}.origin`, 'Must be [horizontal, vertical], each between 0 and 1');
  };

  const sceneIds = new Set();
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) err('layers', 'At least one layer is required');
  (Array.isArray(manifest.layers) ? manifest.layers : []).forEach((layer, li) => {
    const where = `layers[${li}]`;
    if (layer?.type === 'video') {
      keys(layer, VIDEO_LAYER, where);
      visual(layer, where);
      if (layer.clips !== undefined && (layer.src !== undefined || layer.color !== undefined)) err(where, 'Write either clips or src / color, not both');
      if (layer.overlap !== undefined && (!isInt(layer.overlap) || layer.overlap < 0)) err(`${where}.overlap`, 'An integer of 0 or more (in frames) is required');
      const clips = layer.clips ?? [layer];
      if (!Array.isArray(clips) || clips.length === 0) return err(`${where}.clips`, 'At least one clip is required');
      clips.forEach((clip, ci) => {
        const cw = layer.clips ? `${where}.clips[${ci}]` : where;
        if (layer.clips) keys(clip, CLIP, cw);
        if ((clip.src === undefined) === (clip.color === undefined)) err(cw, 'Write exactly one of src (video or still image) or color (solid color)');
        else if (clip.color !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(clip.color)) err(`${cw}.color`, 'Must be in the form #RRGGBB'); }
        else file(clip.src, `${cw}.src`);
        if (clip.crop !== undefined) {
          const c2 = clip.crop;
          if (typeof c2 !== 'object' || !isInt(c2.width) || !isInt(c2.height)) err(`${cw}.crop`, 'Must be {x, y, width, height} (in asset px)');
          else for (const k of ['x', 'y']) if (c2[k] !== undefined) numOrKeyframes(c2[k], `${cw}.crop.${k}`);
        }
        if (clip.shake !== undefined) {
          if (typeof clip.shake !== 'object') err(`${cw}.shake`, 'Must be {amplitude, speed, from, durationInFrames, seed, decay}');
          else keys(clip.shake, ['amplitude', 'speed', 'from', 'durationInFrames', 'seed', 'decay'], `${cw}.shake`);
          if (clip.blend ?? layer.blend) err(`${cw}.shake`, 'A blend mode and shake cannot be used together');
        }
        if (clip.reverse !== undefined && typeof clip.reverse !== 'boolean') err(`${cw}.reverse`, 'Must be true or false');
        if (clip.reverse && (clip.loop || clip.freeze !== undefined)) err(`${cw}.reverse`, 'reverse cannot be used together with loop or freeze');
        timing(clip, cw);
        if (layer.clips) visual(clip, cw);
        if (clip.freeze !== undefined) frame(clip.freeze, `${cw}.freeze`);
        if (clip.freeze !== undefined && (clip.loop || (clip.playbackRate ?? 1) !== 1)) err(cw, 'freeze cannot be used together with loop or playbackRate');
        for (const k of ['fadeIn', 'fadeOut', 'audioFadeIn', 'audioFadeOut']) if (clip[k] !== undefined) frame(clip[k], `${cw}.${k}`);
        if (clip.volume !== undefined) numOrKeyframes(clip.volume, `${cw}.volume`);
      });
    } else if (layer?.type === 'scene') {
      keys(layer, SCENE_LAYER, where);
      if (typeof layer.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(layer.id)) err(`${where}.id`, 'A name made of letters, digits, _ and - is required');
      else if (sceneIds.has(layer.id)) err(`${where}.id`, `Duplicate id "${layer.id}"`);
      else sceneIds.add(layer.id);
      if (typeof layer.scene !== 'string') err(`${where}.scene`, 'The name of a scene is required');
      for (const k of ['region', 'canvas']) {
        const r = layer[k];
        if (r === undefined) continue;
        const need = k === 'region' ? ['x', 'y', 'width', 'height'] : ['width', 'height'];
        if (typeof r !== 'object' || need.some((n) => !isInt(r[n]))) err(`${where}.${k}`, `${need.join(', ')} must be integers`);
      }
      for (const k of ['x', 'y']) if (layer[k] !== undefined && !isInt(layer[k])) keyframes(layer[k], `${where}.${k}`);
      blendMode(layer.blend, `${where}.blend`);
      if (layer.blend && (layer.x !== undefined && !isInt(layer.x) || layer.y !== undefined && !isInt(layer.y))) err(`${where}.blend`, 'A blend mode and a keyframed position cannot be used together');
      const kind = layer.page ? 'page' : backend === 'flutter' ? 'flutter' : 'browser';
      if (backend !== 'none') {
        if (layer.page && backend === 'flutter') err(where, 'page scenes can only be drawn by browser');
        const ref = manifest.scenes?.[kind];
        if (!ref) err('scenes', `scenes.${kind} is missing (used by ${where})`);
        else if (kind !== 'flutter' || ref.endsWith('.dart')) file(ref, `scenes.${kind}`);
      }
    } else if (layer?.type === 'adjust') {
      keys(layer, ADJUST_LAYER, where);
      timing(layer, where);
      const r = layer.region;
      if (r !== undefined && (typeof r !== 'object' || ['x', 'y', 'width', 'height'].some((n) => !isInt(r[n])))) err(`${where}.region`, 'x, y, width, height must be integers');
      else if (r && (r.width % 2 || r.height % 2 || r.x % 2 || r.y % 2)) err(`${where}.region`, 'Position and size must be even');
      if (layer.filter !== undefined) { try { parseFilter(layer.filter); } catch (e) { err(`${where}.filter`, e.message); } }
      for (const k of ['vignette', 'grain']) if (layer[k] !== undefined && (!isNum(layer[k]) || layer[k] < 0 || layer[k] > 1)) err(`${where}.${k}`, 'A number between 0 and 1 is required');
      if (layer.filter === undefined && !layer.vignette && !layer.grain) err(where, 'At least one of filter / vignette / grain is required');
    } else if (layer?.type === 'captions') {
      keys(layer, ['type', 'id', 'src', 'items', 'style'], where);
      if (backend === 'flutter') err(where, 'captions layers can only be drawn by browser');
      if ((layer.src === undefined) === (layer.items === undefined)) err(where, 'Write exactly one of src (.srt / .ass) or items');
      if (layer.src !== undefined) {
        const full = file(layer.src, `${where}.src`);
        if (full && !/\.(srt|ass|ssa)$/i.test(full)) err(`${where}.src`, 'Must be a .srt or .ass / .ssa file');
      }
      if (layer.items !== undefined) {
        if (!Array.isArray(layer.items)) err(`${where}.items`, 'Must be an array of [{from, to, text}]');
        else layer.items.forEach((c, ci) => { if (!isInt(c?.from) || !isInt(c?.to) || c.to <= c.from || typeof c.text !== 'string') err(`${where}.items[${ci}]`, 'from and to (in frames, from < to) and text are required'); });
      }
      if (layer.style !== undefined) keys(layer.style, CAPTION_STYLE, `${where}.style`);
      if (layer.id !== undefined) {
        if (sceneIds.has(layer.id)) err(`${where}.id`, `Duplicate id "${layer.id}"`);
        sceneIds.add(layer.id);
      }
    } else {
      err(`${where}.type`, 'Must be one of video / scene / captions / adjust');
    }
  });

  const audio = manifest.audio === undefined ? [] : Array.isArray(manifest.audio) ? manifest.audio : [manifest.audio];
  audio.forEach((track, ai) => {
    const where = `audio[${ai}]`;
    keys(track, AUDIO, where);
    const full = file(track.src, `${where}.src`);
    if (full && !probe(full).some((s) => s.codec_type === 'audio')) err(`${where}.src`, 'The file has no audio');
    timing(track, where);
    if (track.volume !== undefined) numOrKeyframes(track.volume, `${where}.volume`);
    for (const k of ['fadeIn', 'fadeOut']) if (track[k] !== undefined) frame(track[k], `${where}.${k}`);
    if (track.fadeOut && track.durationInFrames === undefined && !track.loop) err(`${where}.fadeOut`, 'fadeOut requires durationInFrames');
    if (track.pitch !== undefined && !isNum(track.pitch)) err(`${where}.pitch`, 'A number of semitones (example: -4) is required');
    if (track.group !== undefined && typeof track.group !== 'string') err(`${where}.group`, 'A group name (string) is required');
    if (track.duck !== undefined) {
      if (typeof track.duck !== 'object' || track.duck.by === undefined) err(`${where}.duck`, 'Must be {by: group name, to, attack, release, lead, tail}');
      else {
        keys(track.duck, ['by', 'to', 'attack', 'release', 'lead', 'tail'], `${where}.duck`);
        const groups = [track.duck.by].flat();
        if (!audio.some((o) => o !== track && groups.includes(o.group))) warn(`${where}.duck`, `No track is in group "${groups.join(', ')}", so the volume is not lowered`);
      }
      if (track.volume !== undefined && !isNum(track.volume)) err(`${where}.duck`, 'duck and volume keyframes cannot be used together');
    }
  });

  if (manifest.master !== undefined) {
    keys(manifest.master, ['limiter', 'loudnorm'], 'master');
    if (manifest.master.limiter !== undefined && !(isNum(manifest.master.limiter) && manifest.master.limiter > 0 && manifest.master.limiter <= 1)) err('master.limiter', 'A number greater than 0 and at most 1 is required');
  }
  if (manifest.assets !== undefined) file(manifest.assets, 'assets');
  (manifest.fonts ?? []).forEach((f, i) => {
    if (typeof f?.family !== 'string') err(`fonts[${i}].family`, 'A font family name is required');
    file(f?.file, `fonts[${i}].file`);
  });
  return {errors, warnings};
}

export function formatProblems({errors, warnings}) {
  return [...errors.map((e) => `error    ${e.where}: ${e.message}`), ...warnings.map((w) => `warning  ${w.where}: ${w.message}`)].join('\n');
}
