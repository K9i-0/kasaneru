// Tools for probing assets. Use from scripts that build manifests with `import {probeMedia, envelope} from 'kasaneru/media'`.
import {execFileSync, spawnSync} from 'node:child_process';

// Basic information about a video, audio file, or image. Pass fps to also get the frame count at that fps.
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

// Per-frame volume (RMS, 0–1). For lip sync and motion that follows the sound.
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
