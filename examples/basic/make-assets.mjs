// この例で使う素材を、ffmpegの内蔵の絵と音から作る（外部の素材は要らない）。
//   node examples/basic/make-assets.mjs
import {execFileSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';

const dir = new URL('./assets/', import.meta.url).pathname;
mkdirSync(dir, {recursive: true});
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

ff('-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', dir + 'a.mp4');
ff('-f', 'lavfi', '-i', 'mandelbrot=s=1280x720:r=30:end_pts=120', '-t', '4', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', dir + 'b.mp4');
ff('-f', 'lavfi', '-i', 'gradients=s=640x360:c0=0x3b82f6:c1=0xf97316:x0=0:y0=0:x1=640:y1=360:d=1', '-frames:v', '1', dir + 'card.png');
ff('-f', 'lavfi', '-i', 'sine=frequency=110:duration=6,volume=0.4', dir + 'bed.wav');
console.log('assets ready:', dir);
