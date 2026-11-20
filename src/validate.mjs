// manifestの検証。書き出す前に、間違いを場所つきで全部挙げる。
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
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(`${where}.${k}`, `知らない項目です。使える項目: ${allowed.join(', ')}`);
  };
  const file = (p, where) => {
    if (typeof p !== 'string') { err(where, 'ファイルのパス（文字列）が必要です'); return null; }
    const full = path.resolve(manifestDir, p);
    if (!existsSync(full)) { err(where, `ファイルがありません: ${full}`); return null; }
    return full;
  };
  const keyframes = (v, where, {intFrames = true} = {}) => {
    const list = Array.isArray(v) ? v : v?.keyframes;
    if (!Array.isArray(list) || list.length < 2) return err(where, 'キーフレームは [[コマ, 値], ...] を2つ以上書きます');
    list.forEach((k, i) => {
      if (!Array.isArray(k) || k.length !== 2 || !isNum(k[0]) || !isNum(k[1]) || (intFrames && !isInt(k[0]))) err(`${where}[${i}]`, '[コマ（整数）, 値] の形で書きます');
      else if (i > 0 && k[0] <= list[i - 1][0]) err(`${where}[${i}]`, 'コマは前のキーフレームより後にします');
    });
    if (!Array.isArray(v) && v.easing !== undefined && !easingNames.includes(v.easing)) err(`${where}.easing`, `使えるのは ${easingNames.join(', ')} です`);
  };
  const numOrKeyframes = (v, where) => { if (!isNum(v)) keyframes(v, where); };
  const blendMode = (v, where) => { if (v !== undefined && !BLEND_MODES[v]) err(where, `使えるのは ${Object.keys(BLEND_MODES).join(', ')} です`); };

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return {errors: [{where: '', message: 'manifestはオブジェクトで書きます'}], warnings};
  keys(manifest, TOP, 'manifest');

  const c = manifest.composition ?? {};
  for (const k of ['width', 'height']) if (!isInt(c[k]) || c[k] <= 0) err(`composition.${k}`, '正の整数が必要です');
  // durationInFrames は省ける（いちばん遅く終わるクリップ・音声に合わせる）。
  if (c.durationInFrames !== undefined && (!isInt(c.durationInFrames) || c.durationInFrames <= 0)) err('composition.durationInFrames', '正の整数が必要です（省くと自動で決まります）');
  if (!isNum(c.fps) || c.fps <= 0) err('composition.fps', '正の数が必要です');
  if (isInt(c.width) && isInt(c.height) && (c.width % 2 || c.height % 2)) err('composition', '幅と高さは偶数にします（H.264の制約）');
  const N = c.durationInFrames;
  if (manifest.background !== undefined && !/^#[0-9a-fA-F]{6}$/.test(manifest.background)) err('background', '#RRGGBB の形で書きます');

  const frame = (v, where, {min = 0} = {}) => { if (!isInt(v) || v < min) err(where, `${min}以上の整数（コマ数）が必要です`); };
  const timing = (o, where) => {
    if (o.from !== undefined) frame(o.from, `${where}.from`);
    if (o.durationInFrames !== undefined) frame(o.durationInFrames, `${where}.durationInFrames`, {min: 1});
    if (o.trimBefore !== undefined) frame(o.trimBefore, `${where}.trimBefore`);
    if (o.playbackRate !== undefined && (!isNum(o.playbackRate) || o.playbackRate <= 0)) err(`${where}.playbackRate`, '0より大きい数が必要です');
    if (o.loop !== undefined && o.loop !== true && o.loop !== false && !(isInt(o.loop) && o.loop > 0)) err(`${where}.loop`, 'true か、繰り返す長さ（コマ数）を書きます');
    if (isInt(o.from) && isInt(N) && o.from >= N) warn(where, `開始（${o.from}）が全体の長さ（${N}）以降なので、出ません`);
    if (isInt(o.from ?? 0) && isInt(o.durationInFrames) && isInt(N) && (o.from ?? 0) + o.durationInFrames > N) warn(where, `終わり（${(o.from ?? 0) + o.durationInFrames}）が全体の長さ（${N}）を超えています。超えた分は切れます`);
  };

  const visual = (o, where) => {
    for (const k of ['x', 'y', 'width', 'height']) if (o[k] !== undefined && !isInt(o[k])) err(`${where}.${k}`, '整数（px）が必要です');
    for (const k of ['width', 'height']) if (isInt(o[k]) && o[k] % 2) err(`${where}.${k}`, '偶数にします');
    if (o.fit !== undefined && !['cover', 'fill', 'contain'].includes(o.fit)) err(`${where}.fit`, 'cover / fill / contain のどれかです');
    if (o.blur !== undefined && (!isNum(o.blur) || o.blur < 0)) err(`${where}.blur`, '0以上の数が必要です');
    if (o.opacity !== undefined) {
      if (isNum(o.opacity)) { if (o.opacity < 0 || o.opacity > 1) err(`${where}.opacity`, '0〜1の数が必要です'); }
      else keyframes(o.opacity, `${where}.opacity`);
    }
    if (o.rotate !== undefined) numOrKeyframes(o.rotate, `${where}.rotate`);
    if (o.radius !== undefined && (!isNum(o.radius) || o.radius < 0)) err(`${where}.radius`, '0以上の数（px）が必要です');
    if (o.mask !== undefined && o.mask !== 'ellipse') file(o.mask, `${where}.mask`);
    blendMode(o.blend, `${where}.blend`);
    if (o.filter !== undefined) {
      try { parseFilter(o.filter); } catch (e) { err(`${where}.filter`, e.message); }
    }
    if (o.align !== undefined && !(Array.isArray(o.align) && o.align.length === 2 && o.align.every((v) => isNum(v) && v >= 0 && v <= 1))) err(`${where}.align`, '[横, 縦] を0〜1で書きます（0.5が中央）');
    if (o.flip !== undefined && !['h', 'v', 'hv', 'vh'].includes(o.flip)) err(`${where}.flip`, 'h（左右）/ v（上下）/ hv のどれかです');
    if (o.chromaKey !== undefined) {
      if (typeof o.chromaKey !== 'object' || !/^#[0-9a-fA-F]{6}$/.test(o.chromaKey.color ?? '')) err(`${where}.chromaKey`, '{color: "#RRGGBB", similarity, blend} で書きます');
      else keys(o.chromaKey, ['color', 'similarity', 'blend'], `${where}.chromaKey`);
    }
    if (o.corners !== undefined) {
      const four = (c) => Array.isArray(c) && c.length === 4 && c.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum));
      const list = Array.isArray(o.corners) ? [[0, o.corners]] : o.corners?.keyframes;
      if (!Array.isArray(list) || !list.every((k) => Array.isArray(k) && isInt(k[0]) && four(k[1]))) err(`${where}.corners`, '四隅 [[x,y]×4]（左上・右上・左下・右下）か、{keyframes: [[コマ, 四隅], ...]} で書きます');
      if (o.blur) err(`${where}.corners`, 'ぼかしと透視合成は同時に使えません');
      if (o.width !== undefined || o.height !== undefined || o.x !== undefined || o.y !== undefined) err(`${where}.corners`, '透視合成する層には x・y・width・height を書きません（四隅で位置が決まります）');
    }
    if (o.fit === 'contain' && o.scale !== undefined && !isNum(o.scale)) err(`${where}.scale`, 'contain と動く拡大は同時に使えません');
    if (o.blend && (o.offsetX !== undefined && !isNum(o.offsetX) || o.offsetY !== undefined && !isNum(o.offsetY))) err(`${where}.blend`, '合成モードと動く位置は同時に使えません');
    if (o.scale !== undefined) numOrKeyframes(o.scale, `${where}.scale`);
    if (o.scale !== undefined && o.blur && !isNum(o.scale)) err(`${where}.scale`, 'ぼかしと動く拡大は同時に使えません');
    for (const k of ['offsetX', 'offsetY']) if (o[k] !== undefined) numOrKeyframes(o[k], `${where}.${k}`);
    if (o.origin !== undefined && !(Array.isArray(o.origin) && o.origin.length === 2 && o.origin.every(isNum))) err(`${where}.origin`, '[横, 縦] を0〜1で書きます');
  };

  const sceneIds = new Set();
  if (!Array.isArray(manifest.layers) || manifest.layers.length === 0) err('layers', '層を1つ以上書きます');
  (Array.isArray(manifest.layers) ? manifest.layers : []).forEach((layer, li) => {
    const where = `layers[${li}]`;
    if (layer?.type === 'video') {
      keys(layer, VIDEO_LAYER, where);
      visual(layer, where);
      if (layer.clips !== undefined && (layer.src !== undefined || layer.color !== undefined)) err(where, 'clips と src / color は片方だけ書きます');
      if (layer.overlap !== undefined && (!isInt(layer.overlap) || layer.overlap < 0)) err(`${where}.overlap`, '0以上の整数（コマ数）が必要です');
      const clips = layer.clips ?? [layer];
      if (!Array.isArray(clips) || clips.length === 0) return err(`${where}.clips`, 'クリップを1つ以上書きます');
      clips.forEach((clip, ci) => {
        const cw = layer.clips ? `${where}.clips[${ci}]` : where;
        if (layer.clips) keys(clip, CLIP, cw);
        if ((clip.src === undefined) === (clip.color === undefined)) err(cw, 'src（動画・静止画）か color（単色）のどちらか片方を書きます');
        else if (clip.color !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(clip.color)) err(`${cw}.color`, '#RRGGBB の形で書きます'); }
        else file(clip.src, `${cw}.src`);
        if (clip.crop !== undefined) {
          const c2 = clip.crop;
          if (typeof c2 !== 'object' || !isInt(c2.width) || !isInt(c2.height)) err(`${cw}.crop`, '{x, y, width, height}（素材のpx）で書きます');
          else for (const k of ['x', 'y']) if (c2[k] !== undefined) numOrKeyframes(c2[k], `${cw}.crop.${k}`);
        }
        if (clip.shake !== undefined) {
          if (typeof clip.shake !== 'object') err(`${cw}.shake`, '{amplitude, speed, from, durationInFrames, seed, decay} で書きます');
          else keys(clip.shake, ['amplitude', 'speed', 'from', 'durationInFrames', 'seed', 'decay'], `${cw}.shake`);
          if (clip.blend ?? layer.blend) err(`${cw}.shake`, '合成モードと揺れは同時に使えません');
        }
        if (clip.reverse !== undefined && typeof clip.reverse !== 'boolean') err(`${cw}.reverse`, 'true か false です');
        if (clip.reverse && (clip.loop || clip.freeze !== undefined)) err(`${cw}.reverse`, '逆再生は loop・freeze と同時に使えません');
        timing(clip, cw);
        if (layer.clips) visual(clip, cw);
        if (clip.freeze !== undefined) frame(clip.freeze, `${cw}.freeze`);
        if (clip.freeze !== undefined && (clip.loop || (clip.playbackRate ?? 1) !== 1)) err(cw, 'freeze は loop・playbackRate と同時に使えません');
        for (const k of ['fadeIn', 'fadeOut', 'audioFadeIn', 'audioFadeOut']) if (clip[k] !== undefined) frame(clip[k], `${cw}.${k}`);
        if (clip.volume !== undefined) numOrKeyframes(clip.volume, `${cw}.volume`);
      });
    } else if (layer?.type === 'scene') {
      keys(layer, SCENE_LAYER, where);
      if (typeof layer.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(layer.id)) err(`${where}.id`, '英数字・_・- の名前が必要です');
      else if (sceneIds.has(layer.id)) err(`${where}.id`, `id「${layer.id}」が重複しています`);
      else sceneIds.add(layer.id);
      if (typeof layer.scene !== 'string') err(`${where}.scene`, 'シーンの名前が必要です');
      for (const k of ['region', 'canvas']) {
        const r = layer[k];
        if (r === undefined) continue;
        const need = k === 'region' ? ['x', 'y', 'width', 'height'] : ['width', 'height'];
        if (typeof r !== 'object' || need.some((n) => !isInt(r[n]))) err(`${where}.${k}`, `${need.join(', ')} を整数で書きます`);
      }
      for (const k of ['x', 'y']) if (layer[k] !== undefined && !isInt(layer[k])) keyframes(layer[k], `${where}.${k}`);
      blendMode(layer.blend, `${where}.blend`);
      if (layer.blend && (layer.x !== undefined && !isInt(layer.x) || layer.y !== undefined && !isInt(layer.y))) err(`${where}.blend`, '合成モードと動く位置は同時に使えません');
      const kind = layer.page ? 'page' : backend === 'flutter' ? 'flutter' : 'browser';
      if (backend !== 'none') {
        if (layer.page && backend === 'flutter') err(where, 'page のシーンは browser でしか描けません');
        const ref = manifest.scenes?.[kind];
        if (!ref) err('scenes', `scenes.${kind} がありません（${where} が使います）`);
        else if (kind !== 'flutter' || ref.endsWith('.dart')) file(ref, `scenes.${kind}`);
      }
    } else if (layer?.type === 'adjust') {
      keys(layer, ADJUST_LAYER, where);
      timing(layer, where);
      const r = layer.region;
      if (r !== undefined && (typeof r !== 'object' || ['x', 'y', 'width', 'height'].some((n) => !isInt(r[n])))) err(`${where}.region`, 'x, y, width, height を整数で書きます');
      else if (r && (r.width % 2 || r.height % 2 || r.x % 2 || r.y % 2)) err(`${where}.region`, '位置と大きさは偶数にします');
      if (layer.filter !== undefined) { try { parseFilter(layer.filter); } catch (e) { err(`${where}.filter`, e.message); } }
      for (const k of ['vignette', 'grain']) if (layer[k] !== undefined && (!isNum(layer[k]) || layer[k] < 0 || layer[k] > 1)) err(`${where}.${k}`, '0〜1の数が必要です');
      if (layer.filter === undefined && !layer.vignette && !layer.grain) err(where, 'filter / vignette / grain のどれかを書きます');
    } else if (layer?.type === 'captions') {
      keys(layer, ['type', 'id', 'src', 'items', 'style'], where);
      if (backend === 'flutter') err(where, 'captions の層は browser でしか描けません');
      if ((layer.src === undefined) === (layer.items === undefined)) err(where, 'src（.srt / .ass）か items のどちらか片方を書きます');
      if (layer.src !== undefined) {
        const full = file(layer.src, `${where}.src`);
        if (full && !/\.(srt|ass|ssa)$/i.test(full)) err(`${where}.src`, '.srt か .ass / .ssa を使います');
      }
      if (layer.items !== undefined) {
        if (!Array.isArray(layer.items)) err(`${where}.items`, '[{from, to, text}] の配列で書きます');
        else layer.items.forEach((c, ci) => { if (!isInt(c?.from) || !isInt(c?.to) || c.to <= c.from || typeof c.text !== 'string') err(`${where}.items[${ci}]`, 'from・to（コマ数、from < to）と text が必要です'); });
      }
      if (layer.style !== undefined) keys(layer.style, CAPTION_STYLE, `${where}.style`);
      if (layer.id !== undefined) {
        if (sceneIds.has(layer.id)) err(`${where}.id`, `id「${layer.id}」が重複しています`);
        sceneIds.add(layer.id);
      }
    } else {
      err(`${where}.type`, 'video / scene / captions / adjust のどれかを書きます');
    }
  });

  const audio = manifest.audio === undefined ? [] : Array.isArray(manifest.audio) ? manifest.audio : [manifest.audio];
  audio.forEach((track, ai) => {
    const where = `audio[${ai}]`;
    keys(track, AUDIO, where);
    const full = file(track.src, `${where}.src`);
    if (full && !probe(full).some((s) => s.codec_type === 'audio')) err(`${where}.src`, '音声が入っていません');
    timing(track, where);
    if (track.volume !== undefined) numOrKeyframes(track.volume, `${where}.volume`);
    for (const k of ['fadeIn', 'fadeOut']) if (track[k] !== undefined) frame(track[k], `${where}.${k}`);
    if (track.fadeOut && track.durationInFrames === undefined && !track.loop) err(`${where}.fadeOut`, 'fadeOut には durationInFrames が必要です');
    if (track.pitch !== undefined && !isNum(track.pitch)) err(`${where}.pitch`, '半音の数（例: -4）が必要です');
    if (track.group !== undefined && typeof track.group !== 'string') err(`${where}.group`, 'グループの名前（文字列）が必要です');
    if (track.duck !== undefined) {
      if (typeof track.duck !== 'object' || track.duck.by === undefined) err(`${where}.duck`, '{by: グループ名, to, attack, release, lead, tail} で書きます');
      else {
        keys(track.duck, ['by', 'to', 'attack', 'release', 'lead', 'tail'], `${where}.duck`);
        const groups = [track.duck.by].flat();
        if (!audio.some((o) => o !== track && groups.includes(o.group))) warn(`${where}.duck`, `グループ「${groups.join(', ')}」のトラックがないので、音量は下がりません`);
      }
      if (track.volume !== undefined && !isNum(track.volume)) err(`${where}.duck`, 'duck と音量のキーフレームは同時に使えません');
    }
  });

  if (manifest.master !== undefined) {
    keys(manifest.master, ['limiter', 'loudnorm'], 'master');
    if (manifest.master.limiter !== undefined && !(isNum(manifest.master.limiter) && manifest.master.limiter > 0 && manifest.master.limiter <= 1)) err('master.limiter', '0より大きく1以下の数が必要です');
  }
  if (manifest.assets !== undefined) file(manifest.assets, 'assets');
  (manifest.fonts ?? []).forEach((f, i) => {
    if (typeof f?.family !== 'string') err(`fonts[${i}].family`, 'フォントの名前が必要です');
    file(f?.file, `fonts[${i}].file`);
  });
  return {errors, warnings};
}

export function formatProblems({errors, warnings}) {
  return [...errors.map((e) => `誤り  ${e.where}: ${e.message}`), ...warnings.map((w) => `注意  ${w.where}: ${w.message}`)].join('\n');
}
