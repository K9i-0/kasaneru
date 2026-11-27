// Inspection of a rendered video. Reports duration, frame count, and volume, and whether the first frame is dark.
import {execFileSync, spawnSync} from 'node:child_process';

// Looks for single frames with a broken picture (blank white, background color only, garbled).
// Lists frames that differ greatly from both neighbors while the neighbors resemble each other. Cuts and fades are not picked up.
// The first and last frames can only be compared with one neighbor. They are listed, as a weak warning (edges), only when they differ greatly from the neighbor and the frames beyond it are calm.
// This cannot be told apart from a cut one frame after the start or one frame before the end, so it is something to "check by eye" rather than a "suspect".
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
    // When the neighboring frame is itself a "single broken frame" suspect, that frame is the cause, not the edge.
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
    // Brightness of the first frame (0–255). On social media the first frame becomes the thumbnail, so a dark one is a loss.
    const stats = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=64:64,format=gray', '-f', 'rawvideo', '-'], {maxBuffer: 1 << 20}).stdout;
    const mean = stats.length ? stats.reduce((s, x) => s + x, 0) / stats.length : 0;
    result.firstFrame = {meanLuma: +mean.toFixed(1), dark: mean < 40};
    if (mean < 40) warnings.push(`The first frame is dark (brightness ${mean.toFixed(0)} / 255). Start with a strong picture from frame 0`);
  } else {
    warnings.push('There is no video stream');
  }
  if (a) {
    const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], {encoding: 'utf8'}).stderr;
    const mean = Number(/mean_volume: ([-\d.]+)/.exec(log)?.[1]);
    const max = Number(/max_volume: ([-\d.]+)/.exec(log)?.[1]);
    const aDur = Number(a.duration);
    result.audio = {
      codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels,
      ...(Number.isFinite(aDur) ? {durationSeconds: +aDur.toFixed(3)} : {}),
      meanVolumeDb: mean, maxVolumeDb: max,
    };
    const vDur = Number(v?.duration);
    if (Number.isFinite(vDur) && Number.isFinite(aDur) && Math.abs(vDur - aDur) >= 0.5) {
      warnings.push(`The audio duration (${aDur.toFixed(2)} s) does not match the video duration (${vDur.toFixed(2)} s)`);
    }
    if (max >= -0.1) warnings.push(`The audio may be clipping (max ${max} dB). Consider master.limiter`);
    if (mean < -40) warnings.push(`The audio is nearly silent (mean ${mean} dB)`);
  }
  if (deep && v) {
    const scan = scanFrames(file);
    result.suspectFrames = scan.suspects;
    result.edgeFrames = scan.edges;
    if (scan.suspects.length > 0) warnings.push(`Frames suspected of being a single broken frame: ${scan.suspects.join(', ')}`);
    if (scan.edges.length > 0) warnings.push(`The first or last frame differs greatly from its neighbor (frame ${scan.edges.join(', ')}). Check by eye that it is the intended picture (it can only be compared with one neighbor, so it cannot be told apart from a cut)`);
  }
  result.warnings = warnings;
  return result;
}
