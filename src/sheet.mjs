// 確認用のコマ一覧。指定したコマを1枚の画像に並べ、コマ番号を入れる。
import {execFileSync, spawnSync} from 'node:child_process';

// manifestから、目で確かめたいコマ（各クリップ・字幕・シーンの切り替わりの前後）を拾う。
export function boundaryFrames(manifest) {
  const N = manifest.composition.durationInFrames;
  const set = new Set([0, N - 1]);
  const add = (from, to) => { for (const f of [from, to - 1]) if (f >= 0 && f < N) set.add(f); };
  for (const layer of manifest.layers) {
    if (layer.type === 'video') for (const c of layer.clips ?? [layer]) add(c.from ?? 0, (c.from ?? 0) + (c.durationInFrames ?? N));
    else if (layer.builtin) for (const c of layer.builtin.items) add(c.from, c.to);
    else if (layer.type === 'adjust') add(layer.from ?? 0, (layer.from ?? 0) + (layer.durationInFrames ?? N));
  }
  return [...set].sort((a, b) => a - b);
}

export function contactSheet(video, frames, out, {cols = 4, cellWidth = 320} = {}) {
  if (frames.length === 0) throw new Error('並べるコマがありません');
  const hasText = spawnSync('ffmpeg', ['-hide_banner', '-filters'], {encoding: 'utf8'}).stdout.includes('drawtext');
  const rows = Math.ceil(frames.length / cols);
  const select = frames.map((f) => `eq(n\\,${f})`).join('+');
  const label = hasText ? `,drawtext=text='%{eif\\:n\\:d}':x=6:y=6:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4` : '';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', video, '-vf', `select='${select}'${label},scale=${cellWidth}:-2,tile=${cols}x${rows}:padding=4:color=0x202020`, '-frames:v', '1', '-fps_mode', 'passthrough', out]);
  return {out, frames, cols, rows, labeled: hasText};
}
