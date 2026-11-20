// 素材を調べる道具。manifestを作るスクリプトから `import {probeMedia, envelope} from 'kasaneru/media'` で使う。
import {execFileSync, spawnSync} from 'node:child_process';

// 動画・音声・画像の基本情報。fps を渡すと、その fps でのコマ数も返す。
export function probeMedia(file, fps) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {encoding: 'utf8'}));
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const seconds = Number(v?.duration ?? a?.duration ?? info.format.duration);
  const result = {file, durationSeconds: Number.isFinite(seconds) ? +seconds.toFixed(4) : null, hasVideo: Boolean(v), hasAudio: Boolean(a)};
  if (v) {
    const [num, den] = v.r_frame_rate.split('/').map(Number);
    Object.assign(result, {width: v.width, height: v.height, fps: +(num / den).toFixed(3)});
  }
  if (a) Object.assign(result, {sampleRate: Number(a.sample_rate), channels: a.channels});
  if (fps && result.durationSeconds !== null) result.durationInFrames = Math.round(result.durationSeconds * fps);
  return result;
}

// コマごとの音量（RMS、0〜1）。口パクや音に合わせた動きに使う。
export function envelope(file, fps, {digits = 4} = {}) {
  const rate = 16000;
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], {maxBuffer: 1 << 30}).stdout;
  const samples = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  const frames = Math.ceil((samples.length / rate) * fps);
  return Array.from({length: frames}, (_, f) => {
    const a = Math.floor((f * rate) / fps), b = Math.min(samples.length, Math.floor(((f + 1) * rate) / fps));
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i] * samples[i];
    return +Math.sqrt(sum / Math.max(1, b - a)).toFixed(digits);
  });
}
