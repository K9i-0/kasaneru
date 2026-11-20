// 書き出した動画の点検。尺・コマ数・音量と、先頭コマが暗くないかを調べる。
import {execFileSync, spawnSync} from 'node:child_process';

// 1コマだけ壊れた絵（真っ白・背景色だけ・崩れ）を探す。
// 前後のコマは似ているのに、そのコマだけ両方と大きく違うものを挙げる。カットやフェードは対象にならない。
// 先頭と最後のコマは片側としか比べられない。隣のコマと大きく違い、その先は静かなときだけ、弱い扱い（edges）で挙げる。
// 先頭や最後の1コマ手前でのカットと区別できないので、「疑い」ではなく「見て確かめる」対象。
export function scanFrames(file) {
  const w = 64, h = 36, size = w * h;
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'], {maxBuffer: 1 << 30}).stdout;
  const n = Math.floor(raw.length / size);
  const diff = (a, b) => { let s = 0; for (let i = 0; i < size; i++) s += Math.abs(raw[a * size + i] - raw[b * size + i]); return s / size; };
  const suspects = [];
  for (let k = 1; k < n - 1; k++) {
    const around = diff(k - 1, k + 1);
    if (around < 6 && diff(k - 1, k) > Math.max(18, around * 4) && diff(k, k + 1) > Math.max(18, around * 4)) suspects.push(k);
  }
  const edges = [];
  if (n >= 3) {
    const lone = (edge, next, after) => { const calm = diff(next, after); return calm < 6 && diff(edge, next) > Math.max(18, calm * 4); };
    // 隣のコマが「1コマだけ壊れている疑い」のときは、端ではなくそちらが原因。
    if (lone(0, 1, 2) && !suspects.includes(1)) edges.push(0);
    if (lone(n - 1, n - 2, n - 3) && !suspects.includes(n - 2)) edges.push(n - 1);
  }
  return {suspects, edges};
}
export const suspectFrames = (file) => scanFrames(file).suspects;

export function inspectVideo(file, {deep = false} = {}) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-count_frames', '-of', 'json', file], {encoding: 'utf8'}));
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const warnings = [];
  const result = {file, durationSeconds: +Number(info.format.duration).toFixed(3)};
  if (v) {
    const [num, den] = v.r_frame_rate.split('/').map(Number);
    result.video = {codec: v.codec_name, width: v.width, height: v.height, fps: +(num / den).toFixed(3), frames: Number(v.nb_read_frames ?? v.nb_frames), pixelFormat: v.pix_fmt, colorSpace: v.color_space ?? null};
    // 先頭コマの明るさ（0〜255）。SNSでは先頭コマがサムネイルになるので、暗いと損をする。
    const stats = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=64:64,format=gray', '-f', 'rawvideo', '-'], {maxBuffer: 1 << 20}).stdout;
    const mean = stats.length ? stats.reduce((s, x) => s + x, 0) / stats.length : 0;
    result.firstFrame = {meanLuma: +mean.toFixed(1), dark: mean < 40};
    if (mean < 40) warnings.push(`先頭コマが暗い（明るさ ${mean.toFixed(0)} / 255）。フレーム0から見せ場の絵にする`);
  } else {
    warnings.push('映像がありません');
  }
  if (a) {
    const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], {encoding: 'utf8'}).stderr;
    const mean = Number(/mean_volume: ([-\d.]+)/.exec(log)?.[1]);
    const max = Number(/max_volume: ([-\d.]+)/.exec(log)?.[1]);
    result.audio = {codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels, meanVolumeDb: mean, maxVolumeDb: max};
    if (max >= -0.1) warnings.push(`音が振り切れている可能性があります（最大 ${max} dB）。master.limiter を検討する`);
    if (mean < -40) warnings.push(`音がほぼ無音です（平均 ${mean} dB）`);
  }
  if (deep && v) {
    const scan = scanFrames(file);
    result.suspectFrames = scan.suspects;
    result.edgeFrames = scan.edges;
    if (scan.suspects.length > 0) warnings.push(`1コマだけ壊れている疑いのコマ: ${scan.suspects.join(', ')}`);
    if (scan.edges.length > 0) warnings.push(`先頭か最後の1コマだけ、隣のコマと大きく違います（コマ ${scan.edges.join(', ')}）。意図した絵か見て確かめる（片側としか比べられないので、カットとは区別できない）`);
  }
  result.warnings = warnings;
  return result;
}
