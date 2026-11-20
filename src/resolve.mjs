// manifestの省略や便利な書き方を、書き出しの前に具体的な値へ直す。
//   - sequence: true の層は、クリップを順に並べる（from を自動で決める）
//   - composition.durationInFrames を省くと、いちばん遅く終わるクリップ・音声に合わせる
//   - audio の duck は、相手のトラックが鳴っている間だけ音量を下げるキーフレームにする
import path from 'node:path';
import {probe} from './ffmpeg.mjs';

const IMAGE = /\.(png|jpe?g|webp|bmp|gif)$/i;

// 素材の長さ（コンポジションのfpsでのコマ数）。
export function mediaFrames(file, fps, kind = 'video') {
  const stream = probe(file).find((s) => s.codec_type === kind) ?? probe(file)[0];
  const seconds = Number(stream?.duration);
  if (!Number.isFinite(seconds)) throw new Error(`長さを読めません: ${file}`);
  return Math.round(seconds * fps);
}

export function resolveManifest(source, manifestDir) {
  const manifest = structuredClone(source);
  const fps = manifest.composition.fps;
  const abs = (p) => path.resolve(manifestDir, p);
  let end = 0;

  // 表示する長さ: 書いてあればそれ、なければ素材の残り（頭を飛ばした分と速度を反映）。
  const clipLength = (clip) => {
    if (clip.durationInFrames !== undefined) return clip.durationInFrames;
    if (clip.color || IMAGE.test(clip.src) || clip.loop || clip.freeze !== undefined) return null;
    return Math.max(1, Math.round((mediaFrames(abs(clip.src), fps) - (clip.trimBefore ?? 0)) / (clip.playbackRate ?? 1)));
  };

  for (const layer of manifest.layers) {
    if (layer.type !== 'video') continue;
    const clips = layer.clips ?? [layer];
    if (layer.sequence) {
      let cursor = 0;
      for (const clip of clips) {
        if (clip.from !== undefined) cursor = clip.from;
        const length = clipLength(clip);
        if (length === null) throw new Error('sequence の層では、静止画・単色・ループ・フリーズのクリップに durationInFrames が必要です');
        clip.from = cursor;
        clip.durationInFrames = length;
        cursor += length - (layer.overlap ?? 0);
      }
    }
    for (const clip of clips) {
      const length = clipLength(clip);
      if (length !== null) end = Math.max(end, (clip.from ?? 0) + length);
    }
  }

  const tracks = manifest.audio === undefined ? [] : Array.isArray(manifest.audio) ? manifest.audio : [manifest.audio];
  manifest.audio = tracks;
  const trackLength = (t) => t.durationInFrames ?? (t.loop ? null : Math.max(1, Math.round((mediaFrames(abs(t.src), fps, 'audio') - (t.trimBefore ?? 0)) / (t.playbackRate ?? 1))));
  for (const t of tracks) {
    const length = trackLength(t);
    if (length !== null) end = Math.max(end, (t.from ?? 0) + length);
  }

  if (manifest.composition.durationInFrames === undefined) {
    if (end === 0) throw new Error('全体の長さを決められません。composition.durationInFrames を書いてください');
    manifest.composition.durationInFrames = end;
  }
  const N = manifest.composition.durationInFrames;

  // ダッキング: by に挙げたグループのトラックが鳴っている区間を集め、その間だけ音量を下げる。
  for (const t of tracks) {
    if (!t.duck) continue;
    const {by, to = 0.35, attack = 4, release = 8, lead = 3, tail = 2} = t.duck;
    const groups = Array.isArray(by) ? by : [by];
    const base = t.volume ?? 1;
    const ranges = tracks
      .filter((o) => o !== t && groups.includes(o.group))
      .map((o) => [Math.max(0, (o.from ?? 0) - lead), Math.min(N, (o.from ?? 0) + (trackLength(o) ?? N) + tail)])
      .sort((a, b) => a[0] - b[0])
      .reduce((merged, r) => {
        const last = merged[merged.length - 1];
        // 次の発話までの間が短いときは、上げ下げせずにつなぐ。
        if (last && r[0] <= last[1] + attack + release) last[1] = Math.max(last[1], r[1]);
        else merged.push([...r]);
        return merged;
      }, []);
    const points = [[0, ranges[0]?.[0] <= 0 ? base * to : base]];
    for (const [a, b] of ranges) {
      // 立ち上がり・戻りが0コマでも、段差になるよう最低1コマ空ける。
      if (a > 0) points.push([Math.max(0, a - Math.max(1, attack)), base], [a, base * to]);
      if (b < N) points.push([b, base * to], [Math.min(N, b + Math.max(1, release)), base]);
    }
    points.push([N + 1, points[points.length - 1][1]]);
    // 同じコマや戻るコマを除く（キーフレームは必ず後ろへ進む）。
    t.volume = points.filter((p, i) => i === 0 || p[0] > points[i - 1][0]);
    delete t.duck;
    delete t.group;
  }
  for (const t of tracks) delete t.group;
  return manifest;
}
