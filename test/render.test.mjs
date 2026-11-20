// Render tests. Builds assets with the frame number embedded in their brightness, and tells from the brightness which source frame each output frame came from.
//   node --test test/render.test.mjs
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {before, test} from 'node:test';
import {fileURLToPath} from 'node:url';

const CLI = fileURLToPath(new URL('../bin/kasaneru.mjs', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'kasaneru-test-'));
const FPS = 30;
const BG = 16; // luma of the background #000000
const lumaOf = (sourceFrame) => 20 + 3 * sourceFrame;
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

before(() => {
  // src.mp4: 60 frames. Frame n has luma 20+3n. The audio is a 440 Hz sine wave.
  ff('-f', 'lavfi', '-i', `color=gray:s=64x64:r=${FPS}:d=2,format=yuv420p,geq=lum='20+3*N':cb=128:cr=128`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-qp', '0', '-c:a', 'aac', '-shortest', path.join(dir, 'src.mp4'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path.join(dir, 'tone.wav'));
  ff('-f', 'lavfi', '-i', 'color=c=0xC8C8C8:s=64x64,format=rgb24', '-frames:v', '1', path.join(dir, 'gray.png'));
});

let count = 0;
function run(manifest, extra = [], {expectFail = false, ext = 'mp4', backend = 'none'} = {}) {
  const id = ++count;
  const file = path.join(dir, `m${id}.json`);
  writeFileSync(file, JSON.stringify(manifest));
  const out = path.join(dir, `o${id}.${ext}`);
  const sub = ['check', 'still', 'srt'].includes(extra[0]) ? extra[0] : 'render';
  const r = spawnSync('node', [CLI, sub, file, ...(sub === 'check' ? [] : ['-o', out]), '--backend', backend, ...extra.slice(sub === 'render' ? 0 : 1)], {encoding: 'utf8'});
  if (!expectFail && r.status !== 0) throw new Error(`kasaneru failed:\n${r.stderr}\n${r.stdout}`);
  return {out, file, status: r.status, stdout: r.stdout, stderr: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })()};
}
const comp = (frames, w = 64, h = 64) => ({width: w, height: h, fps: FPS, durationInFrames: frames});

// Returns the mean luma of the given area for each output frame.
function lumas(file, {w = 64, h = 64, crop = null} = {}) {
  const vf = (crop ? `crop=${crop},` : '') + 'extractplanes=y';
  const cw = crop ? Number(crop.split(':')[0]) : w, ch = crop ? Number(crop.split(':')[1]) : h;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', vf, '-f', 'rawvideo', '-'], {maxBuffer: 1 << 28});
  const size = cw * ch;
  return Array.from({length: raw.length / size}, (_, k) => raw.subarray(k * size, (k + 1) * size).reduce((s, x) => s + x, 0) / size);
}
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual.toFixed(1)} is outside ${expected} ±${tolerance}`);
const sourceFrame = (luma) => Math.round((luma - 20) / 3);
// Volume per second (RMS, dB).
function loudness(file, seconds) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], {maxBuffer: 1 << 28});
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  return Array.from({length: seconds}, (_, s) => {
    const part = samples.subarray(s * 8000, (s + 1) * 8000);
    const rms = Math.sqrt(part.reduce((a, x) => a + x * x, 0) / Math.max(1, part.length));
    return 20 * Math.log10(rms + 1e-9);
  });
}

test('clip position and trim (from, durationInFrames, trimBefore)', () => {
  const {out} = run({composition: comp(40), layers: [{type: 'video', clips: [{src: 'src.mp4', from: 10, durationInFrames: 20, trimBefore: 5}]}]});
  const y = lumas(out);
  assert.equal(y.length, 40);
  near(y[9], BG, 1, 'background before the start');
  assert.equal(sourceFrame(y[10]), 5, 'the first frame is source frame 5');
  assert.equal(sourceFrame(y[29]), 24, 'the last frame is source frame 24');
  near(y[30], BG, 1, 'background after the end');
});

test('speed change (playbackRate)', () => {
  const fast = lumas(run({composition: comp(20), layers: [{type: 'video', src: 'src.mp4', playbackRate: 2}]}).out);
  for (const j of [0, 5, 15]) near(sourceFrame(fast[j]), 2 * j, 1, `frame ${j} at 2x`);
  const slow = lumas(run({composition: comp(40), layers: [{type: 'video', src: 'src.mp4', playbackRate: 0.5}]}).out);
  for (const j of [0, 10, 30]) near(sourceFrame(slow[j]), j / 2, 1, `frame ${j} at 0.5x`);
});

test('freeze and loop', () => {
  const frozen = lumas(run({composition: comp(15), layers: [{type: 'video', src: 'src.mp4', freeze: 12}]}).out);
  for (const j of [0, 7, 14]) assert.equal(sourceFrame(frozen[j]), 12, `frozen, frame ${j}`);
  const looped = lumas(run({composition: comp(35), layers: [{type: 'video', src: 'src.mp4', loop: 10}]}).out);
  for (const j of [0, 9, 10, 23, 34]) assert.equal(sourceFrame(looped[j]), j % 10, `10-frame loop, frame ${j}`);
  const whole = lumas(run({composition: comp(130), layers: [{type: 'video', src: 'src.mp4', loop: true}]}).out);
  assert.equal(sourceFrame(whole[65]), 5, 'loop of the whole asset (60 frames)');
});

test('still image clip', () => {
  const y = lumas(run({composition: comp(10), layers: [{type: 'video', clips: [{src: 'gray.png', from: 3, durationInFrames: 4}]}]}).out);
  near(y[2], BG, 1, 'background before');
  near(y[3], 16 + (200 / 255) * 219, 3, 'brightness of the image');
  near(y[7], BG, 1, 'background after');
});

test('fit (contain makes the margins transparent)', () => {
  const {out} = run({composition: comp(5, 128, 64), background: '#000000', layers: [{type: 'video', src: 'src.mp4', freeze: 40, fit: 'contain'}]});
  near(lumas(out, {crop: '24:64:2:0'})[2], BG, 1, 'the left margin is background');
  near(lumas(out, {crop: '40:64:44:0'})[2], lumaOf(40), 2, 'the center is the video');
});

test('fades (fadeIn, fadeOut) and opacity', () => {
  const y = lumas(run({composition: comp(30), layers: [{type: 'video', src: 'src.mp4', freeze: 40, fadeIn: 10, fadeOut: 10}]}).out);
  near(y[0], BG, 4, 'start of the fade-in');
  assert.ok(y[5] > BG + 30 && y[5] < lumaOf(40) - 30, `intermediate brightness partway (${y[5].toFixed(1)})`);
  near(y[15], lumaOf(40), 2, 'fully shown');
  assert.ok(y[25] > BG + 20 && y[25] < lumaOf(40) - 20, `partway through the fade-out (${y[25].toFixed(1)})`);
  const half = lumas(run({composition: comp(3), layers: [{type: 'video', src: 'src.mp4', freeze: 40, opacity: 0.5}]}).out);
  near(half[1], (BG + lumaOf(40)) / 2, 3, 'half transparent');
});

test('color filters (same syntax as CSS)', () => {
  const still = (filter) => lumas(run({composition: comp(3), layers: [{type: 'video', src: 'src.mp4', freeze: 40, filter}]}).out)[1];
  const v = (lumaOf(40) - 16) / 219; // brightness of the asset (0–1)
  const toLuma = (r, g, b) => 16 + 219 * (0.2126 * Math.min(1, r) + 0.7152 * Math.min(1, g) + 0.0722 * Math.min(1, b));
  near(still('brightness(0.5)'), toLuma(v * 0.5, v * 0.5, v * 0.5), 2, 'half brightness');
  near(still('contrast(2)'), toLuma((v - 0.5) * 2 + 0.5, (v - 0.5) * 2 + 0.5, (v - 0.5) * 2 + 0.5), 2, 'double contrast');
  near(still('invert(1)'), toLuma(1 - v, 1 - v, 1 - v), 2, 'invert');
  near(still('sepia(1)'), toLuma(1.351 * v, 1.203 * v, 0.937 * v), 2, 'sepia');
  near(still('brightness(50%) invert(100%)'), toLuma(1 - v * 0.5, 1 - v * 0.5, 1 - v * 0.5), 2, 'applied in order');
  near(still('opacity(0.5)'), (BG + lumaOf(40)) / 2, 3, 'opacity() is opacity');
});

test('rotation (rotate)', () => {
  // Rotating a picture whose left half is white and right half is black 90 degrees clockwise makes the top half white.
  ff('-f', 'lavfi', '-i', 'color=black:s=64x64,format=rgb24,drawbox=x=0:y=0:w=32:h=64:color=white:t=fill', '-frames:v', '1', path.join(dir, 'half.png'));
  const {out} = run({composition: comp(3), background: '#000000', layers: [{type: 'video', src: 'half.png', rotate: 90}]});
  near(lumas(out, {crop: '40:20:12:6'})[1], 235, 4, 'the top is white');
  near(lumas(out, {crop: '40:20:12:38'})[1], 16, 4, 'the bottom is black');
  const spin = run({composition: comp(11), background: '#000000', layers: [{type: 'video', src: 'half.png', rotate: {keyframes: [[0, 0], [10, 180]]}}]}).out;
  near(lumas(spin, {crop: '20:40:6:12'})[0], 235, 4, 'the left is white at first');
  near(lumas(spin, {crop: '20:40:6:12'})[10], 16, 4, 'the left is black at 180 degrees');
});

test('a transparent PNG clip shows the layer below through its transparent areas', () => {
  // Overlay an image whose left half is opaque white and right half is fully transparent on a video.
  ff('-f', 'lavfi', '-i', "color=white:s=64x64,format=rgba,geq=r=255:g=255:b=255:a='if(lt(X,32),255,0)'", '-frames:v', '1', path.join(dir, 'alpha_half.png'));
  const {out} = run({composition: comp(10), layers: [{type: 'video', src: 'src.mp4'}, {type: 'video', src: 'alpha_half.png', fadeOut: 2}]});
  const left = lumas(out, {crop: '16:16:8:24'}), right = lumas(out, {crop: '16:16:40:24'});
  assert.ok(left[3] > 225, `the opaque area is the white of the image: ${left[3]}`);
  near(right[3], lumaOf(3), 2, 'the transparent area is the video below');
});

test('masks (rounded corners, ellipse, image)', () => {
  const base = {composition: comp(3), background: '#000000'};
  const round = run({...base, layers: [{type: 'video', src: 'gray.png', radius: 20}]}).out;
  near(lumas(round, {crop: '4:4:0:0'})[1], BG, 3, 'the corner is background');
  near(lumas(round, {crop: '8:8:28:28'})[1], 16 + (200 / 255) * 219, 3, 'the center is the picture');
  const ellipse = run({...base, layers: [{type: 'video', src: 'gray.png', mask: 'ellipse'}]}).out;
  near(lumas(ellipse, {crop: '6:6:2:2'})[1], BG, 3, 'outside the ellipse is background');
  near(lumas(ellipse, {crop: '8:8:28:2'})[1], 16 + (200 / 255) * 219, 4, 'the middle of the top edge is the picture');
  const image = run({...base, layers: [{type: 'video', src: 'gray.png', mask: 'half.png'}]}).out;
  near(lumas(image, {crop: '20:40:6:12'})[1], 16 + (200 / 255) * 219, 3, 'white areas of the mask are the picture');
  near(lumas(image, {crop: '20:40:38:12'})[1], BG, 3, 'black areas of the mask are background');
});

test('opacity keyframes', () => {
  const y = lumas(run({composition: comp(21), layers: [{type: 'video', src: 'src.mp4', freeze: 40, opacity: {keyframes: [[0, 0], [10, 1], [20, 0.5]]}}]}).out);
  near(y[0], BG, 3, 'frame 0 is transparent');
  near(y[5], (BG + lumaOf(40)) / 2, 5, 'frame 5 is half');
  near(y[10], lumaOf(40), 3, 'frame 10 is opaque');
  near(y[20], (BG + lumaOf(40)) / 2, 4, 'frame 20 is half');
});

test('blend modes (same names as mix-blend-mode)', () => {
  // Blend the picture below (brightness v) with the same picture.
  const v = 200 / 255;
  const out = (blend, extra = {}) => lumas(run({composition: comp(6), background: '#000000', layers: [{type: 'video', src: 'gray.png'}, {type: 'video', clips: [{src: 'gray.png', blend, ...extra}]}]}).out);
  near(out('multiply')[1], 16 + 219 * v * v, 3, 'multiply');
  near(out('screen')[1], 16 + 219 * (1 - (1 - v) * (1 - v)), 3, 'screen');
  const timed = out('multiply', {from: 2, durationInFrames: 2});
  near(timed[1], 16 + 219 * v, 3, 'the picture below is unchanged before it appears');
  near(timed[2], 16 + 219 * v * v, 3, 'multiplied only while it is shown');
  near(timed[4], 16 + 219 * v, 3, 'the picture below is unchanged after it disappears');
});

test('position offset (offsetX keyframes)', () => {
  const {out} = run({composition: comp(12, 128, 64), layers: [{type: 'video', src: 'src.mp4', freeze: 40, width: 64, height: 64, offsetX: {keyframes: [[0, 0], [10, 64]]}}]});
  near(lumas(out, {crop: '60:64:2:0'})[0], lumaOf(40), 2, 'on the left at first');
  near(lumas(out, {crop: '60:64:2:0'})[10], BG, 2, 'the left is empty at the end');
  near(lumas(out, {crop: '60:64:66:0'})[10], lumaOf(40), 2, 'on the right at the end');
  near(lumas(out, {crop: '30:64:34:0'})[5], lumaOf(40), 2, 'in the middle partway');
});

test('audio position, length, loop, speed, fades, and clip audio', () => {
  const placed = loudness(run({composition: comp(90), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', from: 30, durationInFrames: 30}]}).out, 3);
  assert.ok(placed[0] < -60 && placed[1] > -20 && placed[2] < -60, `plays only during second 1: ${placed.map((v) => v.toFixed(0))}`);
  const looped = loudness(run({composition: comp(150), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', loop: true}]}).out, 5);
  assert.ok(looped.every((v) => v > -20), `loops and plays to the end: ${looped.map((v) => v.toFixed(0))}`);
  const fast = loudness(run({composition: comp(90), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', playbackRate: 2}]}).out, 3);
  assert.ok(fast[0] > -20 && fast[1] < -40, `shrinks to 1 second at 2x: ${fast.map((v) => v.toFixed(0))}`);
  const faded = loudness(run({composition: comp(90), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', durationInFrames: 60, fadeOut: 30}]}).out, 2);
  assert.ok(faded[1] < faded[0] - 3, `the second half is quieter because of the fade: ${faded.map((v) => v.toFixed(1))}`);
  const fromClip = loudness(run({composition: comp(90), layers: [{type: 'video', clips: [{src: 'src.mp4', from: 30, durationInFrames: 30, volume: 1}]}]}).out, 3);
  assert.ok(fromClip[0] < -60 && fromClip[1] > -20 && fromClip[2] < -60, `the audio of a clip with volume plays at the same position: ${fromClip.map((v) => v.toFixed(0))}`);
  const silent = run({composition: comp(30), layers: [{type: 'video', src: 'src.mp4'}]}).out;
  assert.ok(!execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', silent], {encoding: 'utf8'}).includes('audio'), 'a clip without volume is silent');
});

test('partial render (--frames) and single-frame render (still)', () => {
  // A single frame can be rendered even with audio.
  const manifest = {composition: comp(40), layers: [{type: 'video', src: 'src.mp4', volume: 1}], audio: [{src: 'tone.wav'}]};
  const part = lumas(run(manifest, ['--frames', '10-19']).out);
  assert.equal(part.length, 10);
  assert.equal(sourceFrame(part[0]), 10);
  assert.equal(sourceFrame(part[9]), 19);
  const still = run(manifest, ['still', '--frame', '25'], {ext: 'png'});
  assert.ok(existsSync(still.out));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', still.out, '-vf', 'format=gray', '-f', 'rawvideo', '-']);
  near(raw.reduce((s, x) => s + x, 0) / raw.length, ((lumaOf(25) - 16) / 219) * 255, 3, 'the picture at frame 25');
});

test('check lists errors with their locations', () => {
  const bad = run({composition: {width: 64, height: 64, fps: 30, durationInFrames: 0}, layers: [{type: 'video', src: 'nai.mp4', playbackRate: 0, fitt: 'cover', filter: 'glow(2)', blend: 'nai'}, {type: 'scene', id: 'a b'}], audio: [{src: 'gray.png'}]}, ['check'], {expectFail: true, backend: 'browser'});
  assert.equal(bad.status, 1);
  const where = bad.json.errors.map((e) => e.where);
  for (const w of ['composition.durationInFrames', 'layers[0].fitt', 'layers[0].filter', 'layers[0].blend', 'layers[0].src', 'layers[0].playbackRate', 'layers[1].id', 'audio[0].src']) assert.ok(where.includes(w), `reports ${w} (reported: ${where.join(', ')})`);
  const good = run({composition: comp(10), layers: [{type: 'video', src: 'src.mp4'}]}, ['check']);
  assert.equal(good.json.ok, true);
  const refused = run({composition: comp(10), layers: [{type: 'video', src: 'nai.mp4'}]}, [], {expectFail: true});
  assert.equal(refused.status, 1, 'a manifest with errors is not rendered');
});

test('inspect reports duration, frame count, and a dark first frame', () => {
  const {out} = run({composition: comp(30), layers: [{type: 'video', src: 'src.mp4'}], audio: [{src: 'tone.wav'}]});
  const report = JSON.parse(execFileSync('node', [CLI, 'inspect', out], {encoding: 'utf8'}));
  assert.equal(report.video.frames, 30);
  assert.equal(report.video.width, 64);
  assert.equal(report.firstFrame.dark, true, 'the first frame (luma 20) is judged dark');
  assert.ok(report.warnings.some((w) => w.includes('first frame is dark')));
  assert.ok(report.audio.meanVolumeDb > -30);
});

const chrome = existsSync('/Applications/Google Chrome.app');
test('browser-drawn layers (identical pictures drawn once, region, gaps in an opaque layer)', {skip: !chrome && 'Chrome not found'}, () => {
  mkdirSync(path.join(dir, 'b'), {recursive: true});
  writeFileSync(path.join(dir, 'b', 'scene.mjs'), `
    const box = (color) => '<div style="position:absolute;inset:0;background:' + color + '"></div>';
    export const scenes = {
      // Alternates between white and gray every 10 frames. Only 2 pictures should be drawn.
      flip: {render: (f) => box(Math.floor(f / 10) % 2 ? '#808080' : '#ffffff')},
      // An opaque layer shown only for frames 20-29.
      band: {key: (f) => (f >= 20 && f < 30 ? 'on' : null), render: () => box('#ffffff')},
    };`);
  const {out, json} = run({
    composition: comp(40, 128, 64), background: '#000000', scenes: {browser: 'b/scene.mjs'},
    layers: [
      {type: 'scene', id: 'flip', scene: 'flip', region: {x: 0, y: 0, width: 64, height: 64}},
      {type: 'scene', id: 'band', scene: 'band', region: {x: 64, y: 0, width: 64, height: 64}, opaque: true},
    ],
  }, [], {backend: 'browser'});
  assert.equal(json.imagesDrawn, 3, 'only 3 pictures are drawn: white, gray, and the bar');
  const left = lumas(out, {crop: '60:60:2:2'}), right = lumas(out, {crop: '60:60:66:2'});
  near(left[5], 235, 2, 'left: white for 0-9');
  near(left[15], 126, 3, 'left: gray for 10-19');
  near(left[25], 235, 2, 'left: white for 20-29 (the same picture reused)');
  near(right[19], BG, 2, 'right: frame 19 is background');
  near(right[20], 235, 3, 'right: the bar starts at frame 20');
  near(right[29], 235, 3, 'right: the bar lasts through frame 29');
  near(right[30], BG, 2, 'right: frame 30 is background');
});

test('reading subtitle files (SRT, ASS)', async () => {
  const {parseAss, parseSrt, toFrames} = await import('../src/subtitles.mjs');
  // The subtitle text is Japanese on purpose: it checks that non-ASCII text survives reading.
  const srt = parseSrt('1\n00:00:01,000 --> 00:00:02,500\n<i>こんにちは</i>\n二行目\n\n2\n00:00:03.000 --> 00:00:04.000\n{\\an8}上に出す\n');
  assert.deepEqual(toFrames(srt, 30), [{from: 30, to: 75, text: 'こんにちは\n二行目'}, {from: 90, to: 120, text: '上に出す'}]);
  const ass = parseAss('[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00,0:00:03.50,Default,店長,0,0,0,,{\\b1}はい、{\\b0}どうぞ\\N次の行\nComment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,無視\n');
  assert.deepEqual(toFrames(ass, 24), [{from: 48, to: 84, text: 'はい、どうぞ\n次の行', speaker: '店長', style: 'Default'}]);
});

test('captions layer (type: captions)', {skip: !chrome && 'Chrome not found'}, () => {
  writeFileSync(path.join(dir, 'sub.srt'), '1\n00:00:00,500 --> 00:00:01,000\n■■■■■■\n');
  const {out, json} = run({
    composition: comp(40, 320, 180), background: '#000000',
    layers: [{type: 'captions', src: 'sub.srt', style: {fontSize: 40, strokeWidth: 0, bottom: 20, color: '#ffffff'}}],
  }, [], {backend: 'browser'});
  assert.equal(json.imagesDrawn, 1);
  const y = lumas(out, {w: 320, h: 180, crop: '160:30:80:125'});
  near(y[14], BG, 2, 'background before it appears');
  assert.ok(y[15] > 120, `captions from frame 15 (${y[15].toFixed(0)})`);
  assert.ok(y[29] > 120, `captions through frame 29 (${y[29].toFixed(0)})`);
  near(y[30], BG, 2, 'background after it disappears');
  const bad = run({composition: comp(10), layers: [{type: 'captions', style: {fontsize: 3}}]}, ['check'], {expectFail: true, backend: 'browser'});
  assert.ok(bad.json.errors.some((e) => e.where === 'layers[0].style.fontsize') && bad.json.errors.some((e) => e.where === 'layers[0]'));
});

test('the example (examples/basic) renders', {skip: !chrome && 'Chrome not found'}, () => {
  const example = fileURLToPath(new URL('../examples/basic/', import.meta.url));
  execFileSync('node', [path.join(example, 'make-assets.mjs')]);
  const out = path.join(dir, 'basic.mp4');
  execFileSync('node', [CLI, 'render', path.join(example, 'manifest.json'), '-o', out]);
  const report = JSON.parse(execFileSync('node', [CLI, 'inspect', out], {encoding: 'utf8'}));
  assert.equal(report.video.frames, 210);
  assert.deepEqual(report.warnings, []);
});

test('solid color clips (blackouts, color overlays)', () => {
  const y = lumas(run({composition: comp(20), layers: [{type: 'video', src: 'gray.png'}, {type: 'video', clips: [{color: '#000000', from: 10, durationInFrames: 10, fadeIn: 10}]}]}).out);
  near(y[5], 16 + (200 / 255) * 219, 3, 'before the blackout');
  assert.ok(y[15] < y[5] - 40 && y[15] > BG + 20, `partway through the blackout (${y[15].toFixed(0)})`);
});

test('crop, anchor position (align), and flip', () => {
  const base = {composition: comp(11), background: '#000000'};
  // half.png is white on its left half. Cropping the left 32 px makes the whole picture white.
  near(lumas(run({...base, layers: [{type: 'video', src: 'half.png', crop: {x: 0, y: 0, width: 32, height: 64}, fit: 'fill'}]}).out)[1], 235, 3, 'cropping the left gives white');
  const pan = lumas(run({...base, layers: [{type: 'video', src: 'half.png', crop: {x: {keyframes: [[0, 0], [10, 32]]}, y: 0, width: 32, height: 64}, fit: 'fill'}]}).out);
  near(pan[0], 235, 3, 'the pan starts white');
  near(pan[10], 16, 3, 'the pan ends black');
  // Put a 64x64 picture into a 32x64 box with cover. The anchor position changes which side is visible.
  const side = (ax) => lumas(run({...base, composition: comp(3, 32, 64), layers: [{type: 'video', src: 'half.png', align: [ax, 0.5]}]}).out, {w: 32, h: 64})[1];
  near(side(0), 235, 3, 'anchored left shows the white side');
  near(side(1), 16, 3, 'anchored right shows the black side');
  const flipped = run({...base, layers: [{type: 'video', src: 'half.png', flip: 'h'}]}).out;
  near(lumas(flipped, {crop: '20:40:6:12'})[1], 16, 3, 'a horizontal flip makes the left black');
});

test('reverse playback (reverse) and shake', () => {
  const y = lumas(run({composition: comp(10), layers: [{type: 'video', src: 'src.mp4', trimBefore: 20, durationInFrames: 10, reverse: true}]}).out);
  assert.equal(sourceFrame(y[0]), 29, 'starts at the end of the cut range');
  assert.equal(sourceFrame(y[9]), 20, 'ends at the start of the cut range');
  const shaken = run({composition: comp(20, 128, 64), background: '#000000', layers: [{type: 'video', src: 'gray.png', width: 64, height: 64, x: 32, y: 0, shake: {amplitude: 20, speed: 6, durationInFrames: 10, decay: false}}]}).out;
  const edge = lumas(shaken, {crop: '8:40:24:12'});
  assert.ok(Math.max(...edge.slice(0, 10)) - Math.min(...edge.slice(0, 10)) > 30, `the edge brightness changes while shaking (${edge.slice(0, 10).map((v) => v.toFixed(0))})`);
  near(edge[15], BG, 2, 'back in place once the shake ends');
  const again = lumas(run({composition: comp(20, 128, 64), background: '#000000', layers: [{type: 'video', src: 'gray.png', width: 64, height: 64, x: 32, y: 0, shake: {amplitude: 20, speed: 6, durationInFrames: 10, decay: false}}]}).out, {crop: '8:40:24:12'});
  assert.deepEqual(again.map((v) => Math.round(v)), edge.map((v) => Math.round(v)), 'every render produces the same shake');
});

test('chroma key (chromaKey) and perspective compositing (corners)', () => {
  ff('-f', 'lavfi', '-i', 'color=c=0x00ff00:s=64x64,format=rgb24,drawbox=x=0:y=0:w=32:h=64:color=white:t=fill', '-frames:v', '1', path.join(dir, 'green.png'));
  const keyed = run({composition: comp(3), background: '#000000', layers: [{type: 'video', src: 'green.png', chromaKey: {color: '#00ff00'}}]}).out;
  near(lumas(keyed, {crop: '20:40:6:12'})[1], 235, 4, 'the white side stays');
  near(lumas(keyed, {crop: '20:40:38:12'})[1], BG, 4, 'the green side is keyed out to background');
  // Fit an all-white picture into a quad on the right half.
  ff('-f', 'lavfi', '-i', 'color=c=white:s=64x64,format=rgb24', '-frames:v', '1', path.join(dir, 'white.png'));
  const fitted = run({composition: comp(3, 128, 64), background: '#000000', layers: [{type: 'video', src: 'white.png', corners: [[70, 6], [122, 6], [70, 58], [122, 58]]}]}).out;
  near(lumas(fitted, {w: 128, h: 64, crop: '40:40:76:12'})[1], 235, 4, 'inside the four corners is the picture');
  near(lumas(fitted, {w: 128, h: 64, crop: '56:56:4:4'})[1], BG, 3, 'outside is background');
});

test('adjustment layer (adjust)', () => {
  const v = 16 + (200 / 255) * 219;
  const tint = run({composition: comp(10, 128, 64), layers: [{type: 'video', src: 'gray.png', fit: 'fill'}, {type: 'adjust', region: {x: 64, y: 0, width: 64, height: 64}, filter: 'brightness(0.5)', from: 2, durationInFrames: 4}]}).out;
  const left = lumas(tint, {w: 128, h: 64, crop: '56:56:4:4'}), right = lumas(tint, {w: 128, h: 64, crop: '56:56:68:4'});
  near(left[3], v, 3, 'unchanged outside the region');
  near(right[3], 16 + (200 / 255) * 0.5 * 219, 3, 'darker only inside the region');
  near(right[1], v, 3, 'unchanged before it starts');
  near(right[7], v, 3, 'unchanged after it ends');
  // Blur: the boundary between black and white becomes gradual.
  const blurred = run({composition: comp(3), layers: [{type: 'video', src: 'half.png'}, {type: 'adjust', filter: 'blur(6px)'}]}).out;
  const mid = lumas(blurred, {crop: '2:40:31:12'})[1];
  assert.ok(mid > 60 && mid < 200, `the boundary has intermediate brightness (${mid.toFixed(0)})`);
  const vig = run({composition: comp(3), layers: [{type: 'video', src: 'gray.png'}, {type: 'adjust', vignette: 0.8, grain: 0.2}]}).out;
  assert.ok(lumas(vig, {crop: '6:6:0:0'})[1] < lumas(vig, {crop: '8:8:28:28'})[1] - 15, 'the vignette darkens the corners');
});

test('sequencing (sequence) and automatic length calculation', () => {
  // Two clips of the 60-frame asset. The second skips its first 30 frames. Overlap of 10 frames. The total length is not written.
  const {out, json} = run({composition: {width: 64, height: 64, fps: FPS}, layers: [{type: 'video', sequence: true, overlap: 10, clips: [{src: 'src.mp4'}, {src: 'src.mp4', trimBefore: 30, fadeIn: 10}]}]});
  assert.equal(json.frames, 80, '60 + 30 - 10');
  const y = lumas(out);
  assert.equal(sourceFrame(y[40]), 40, 'first clip');
  assert.equal(sourceFrame(y[70]), 50, 'second clip is 70-50+30');
});

test('automatic ducking (duck) and pitch', () => {
  const ducked = loudness(run({
    composition: comp(150), layers: [{type: 'video', src: 'gray.png'}],
    audio: [{src: 'tone.wav', loop: true, volume: 1, duck: {by: 'voice', to: 0.1, attack: 0, release: 0, lead: 0, tail: 0}}, {src: 'tone.wav', from: 60, durationInFrames: 30, volume: 0.0001, group: 'voice'}],
  }).out, 5);
  assert.ok(ducked[2] < ducked[0] - 15, `lowered only during second 2, where the voice is: ${ducked.map((v) => v.toFixed(0))}`);
  near(ducked[4], ducked[0], 1.5, 'returns once the voice ends');
  const high = run({composition: comp(60), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', pitch: 12}]}).out;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', high, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], {maxBuffer: 1 << 26});
  const s = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4).subarray(2000, 10000);
  let crossings = 0;
  for (let i = 1; i < s.length; i++) if (s[i - 1] <= 0 && s[i] > 0) crossings++;
  near(crossings, 880, 40, 'one octave up (440 Hz → 880 Hz)');
  assert.ok(loudness(high, 2)[1] > -20, 'the length is unchanged (still playing in second 2)');
});

const cli = (...args) => execFileSync('node', [CLI, ...args], {encoding: 'utf8'});

test('props overrides (--props, --set)', {skip: !chrome && 'Chrome not found'}, () => {
  mkdirSync(path.join(dir, 'p'), {recursive: true});
  writeFileSync(path.join(dir, 'p', 'scene.mjs'), `export const scenes = {box: {render: (f, props) => '<div style="position:absolute;inset:0;background:' + props.look.color + '"></div>'}};`);
  const manifest = {composition: comp(3), scenes: {browser: 'p/scene.mjs'}, layers: [{type: 'scene', id: 'box', scene: 'box'}], props: {look: {color: '#000000', other: 1}}};
  near(lumas(run(manifest, [], {backend: 'browser'}).out)[1], 16, 2, 'black originally');
  near(lumas(run(manifest, ['--set', 'look.color=#ffffff'], {backend: 'browser'}).out)[1], 235, 2, 'white with --set');
  near(lumas(run(manifest, ['--props', '{"look":{"color":"#808080"}}'], {backend: 'browser'}).out)[1], 126, 3, 'gray with --props');
});

test('output formats (mov, webm, gif)', () => {
  const manifest = {composition: comp(12), layers: [{type: 'video', src: 'src.mp4', volume: 1}]};
  for (const [ext, codec] of [['mov', 'prores'], ['webm', 'vp9'], ['gif', 'gif']]) {
    const {out} = run(manifest, [], {ext});
    const info = JSON.parse(cli('inspect', out));
    assert.equal(info.video.codec, codec, ext);
    assert.equal(info.video.frames, 12, `${ext} frame count`);
  }
});

test('contact sheet (sheet)', () => {
  const {out, file} = run({composition: comp(40), layers: [{type: 'video', clips: [{src: 'src.mp4', from: 10, durationInFrames: 20}]}]});
  const byList = JSON.parse(cli('sheet', out, '--frames', '0,10,29', '-o', path.join(dir, 'sheet1.png')));
  assert.deepEqual(byList.frames, [0, 10, 29]);
  const byManifest = JSON.parse(cli('sheet', out, '--manifest', file, '--backend', 'none', '-o', path.join(dir, 'sheet2.png')));
  assert.deepEqual(byManifest.frames, [0, 10, 29, 39], 'where the clip enters and leaves, and the first and last frames of the whole');
  assert.ok(existsSync(path.join(dir, 'sheet2.png')));
});

test('writing captions as SRT (srt)', () => {
  // The caption text is Japanese on purpose: it checks that non-ASCII text survives writing.
  const manifest = {composition: comp(90), layers: [{type: 'video', src: 'gray.png'}, {type: 'captions', items: [{from: 45, to: 75, text: '二つ目'}, {from: 0, to: 30, text: '一つ目\n二行'}]}], props: {lines: [{startFrame: 15, endFrame: 45, text: '別の場所'}]}};
  const a = run(manifest, ['srt'], {ext: 'srt'});
  assert.equal(readFileSync(a.out, 'utf8'), '1\n00:00:00,000 --> 00:00:01,000\n一つ目\n二行\n\n2\n00:00:01,500 --> 00:00:02,500\n二つ目\n');
  const b = run(manifest, ['srt', '--key', 'props.lines'], {ext: 'srt'});
  assert.equal(readFileSync(b.out, 'utf8'), '1\n00:00:00,500 --> 00:00:01,500\n別の場所\n');
});

test('probing assets (probe, envelope)', async () => {
  const info = JSON.parse(cli('probe', path.join(dir, 'src.mp4'), '--fps', '24'));
  assert.equal(info.durationInFrames, 48);
  assert.equal(info.width, 64);
  assert.equal(info.hasAudio, true);
  // A sound that plays only in the first half: append 1 second of silence.
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', 'apad=pad_dur=1', path.join(dir, 'half.wav'));
  const env = JSON.parse(cli('envelope', path.join(dir, 'half.wav'), '--fps', '10'));
  assert.equal(env.length, 20);
  assert.ok(env[3] > 0.05 && env[15] < 0.001, `plays in the first half, silent in the second: ${env[3]}, ${env[15]}`);
  const {mediaFrames} = await import('../src/resolve.mjs');
  assert.equal(mediaFrames(path.join(dir, 'src.mp4'), 30), 60);
});

test('detecting a single broken frame (inspect --deep)', () => {
  // Insert a single blank white frame in the middle of a still picture.
  ff('-f', 'lavfi', '-i', `color=c=gray:s=64x64:r=${FPS}:d=1,format=yuv420p,geq=lum='if(eq(N,14),235,90)':cb=128:cr=128`, '-c:v', 'libx264', '-qp', '0', path.join(dir, 'glitch.mp4'));
  const bad = JSON.parse(cli('inspect', path.join(dir, 'glitch.mp4'), '--deep'));
  assert.deepEqual(bad.suspectFrames, [14]);
  assert.ok(bad.warnings.some((w) => w.includes('14')));
  const fine = JSON.parse(cli('inspect', path.join(dir, 'src.mp4'), '--deep'));
  assert.deepEqual(fine.suspectFrames, [], 'a smoothly changing video is not listed');
});

test('animation functions (random, noise, typewriter, easing)', async () => {
  const {clamp, easings, interpolate, noise, random, typewriter} = await import('../src/anim.mjs');
  assert.equal(random('a'), random('a'));
  assert.notEqual(random('a'), random('b'));
  assert.ok(random(1) >= 0 && random(1) < 1);
  assert.ok(Math.abs(noise('s', 3.5)) <= 1);
  assert.equal(noise('s', 2), random('s:2') * 2 - 1, 'at integer positions it is the random number itself');
  assert.equal(typewriter('Hello', 15, 30, 4), 'He');
  assert.equal(clamp(1.5), 1);
  assert.equal(easings.outBack(1), 1);
  assert.equal(interpolate(5, [0, 10], [0, 100], 'inQuad'), 25);
});

test('loading font files (fonts)', {skip: !chrome && 'Chrome not found'}, () => {
  const font = '/System/Library/Fonts/Supplemental/Arial Black.ttf';
  if (!existsSync(font)) return;
  mkdirSync(path.join(dir, 'f'), {recursive: true});
  writeFileSync(path.join(dir, 'f', 'scene.mjs'), `export const scenes = {t: {render: (f, props) => '<div style="position:absolute;left:0;top:0;font:60px ' + props.family + ';color:#fff;white-space:nowrap">WWWWWW</div>'}};`);
  const width = (family, fonts) => {
    const y = lumas(run({composition: comp(2, 640, 96), background: '#000000', scenes: {browser: 'f/scene.mjs'}, fonts, layers: [{type: 'scene', id: 't', scene: 't'}], props: {family}}, [], {backend: 'browser'}).out, {w: 640, h: 96});
    return y[0];
  };
  const withFont = width("'Test Black', monospace", [{family: 'Test Black', file: font}]);
  const fallback = width("'Test Black', monospace", []);
  assert.ok(Math.abs(withFont - fallback) > 3, `drawn with the loaded font (${withFont.toFixed(1)} vs ${fallback.toFixed(1)})`);
});

test('missing images stop the render (<img>, background image, image inside SVG, timeout)', {skip: !chrome && 'Chrome not found'}, async () => {
  mkdirSync(path.join(dir, 'img'), {recursive: true});
  ff('-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', path.join(dir, 'img', 'ok.png'));
  // A server that accepts the connection but never answers (an image that never finishes loading).
  const {createServer} = await import('node:net');
  const sockets = [];
  const hang = createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
  try {
  const svg = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 10 10%22%3E%3Crect width=%2210%22 height=%2210%22/%3E%3C/svg%3E';
  writeFileSync(path.join(dir, 'img', 'scene.mjs'), `
    const wrap = (inner) => '<div style="position:absolute;inset:0;background:#fff">' + inner + '</div>';
    export const scenes = {
      // A missing image sits in a layer whose picture changes every frame.
      missing: {render: (f) => wrap('<img src="nai.png"><span>' + f + '</span>')},
      rooted: {render: () => wrap('<img src="/images/a.png">')},
      css: {render: () => wrap('<div style="width:9px;height:9px;background-image:url(nai_bg.png)"></div><svg><image href="nai_svg.png" width="9" height="9"/></svg>')},
      slow: {render: (f) => wrap('<img src="http://127.0.0.1:${hang.address().port}/slow.png"><span>' + f + '</span>')},
      // A loadable image, an <img> without src, and an SVG without a size are not failures.
      fine: {render: () => wrap('<img src="ok.png"><img><img src="${svg}">')},
    };`);
  const render = (scene, extra = [], options = {}) => run({composition: comp(4), scenes: {browser: 'img/scene.mjs'}, layers: [{type: 'scene', id: 'a', scene}]}, extra, {backend: 'browser', ...options});
  const missing = render('missing', [], {expectFail: true});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /scene "a" frame 0: Cannot load asset: file:\/\/.*img\/nai\.png \(in 4 pictures\)/);
  assert.ok(!existsSync(missing.out), 'no video is made');
  assert.match(render('rooted', [], {expectFail: true}).stderr, /file:\/\/\/images\/a\.png/, 'a path starting with / points at the root of the disk and cannot be loaded');
  const css = render('css', [], {expectFail: true});
  assert.match(css.stderr, /nai_bg\.png/);
  assert.match(css.stderr, /nai_svg\.png/);
  process.env.KASANERU_IMAGE_TIMEOUT_MS = '400';
  // The timeout is waited for only once per page (drawing 12 frames on one page does not wait 12 times).
  const started = performance.now();
  const slow = run({composition: comp(12), scenes: {browser: 'img/scene.mjs'}, layers: [{type: 'scene', id: 'a', scene: 'slow'}]}, ['--concurrency', '1'], {backend: 'browser', expectFail: true});
  assert.match(slow.stderr, /did not finish loading within 0\.4 seconds: http:.*slow\.png \(in 12 pictures\)/);
  assert.ok(performance.now() - started < 4000, `a timed-out image is not waited for again on every frame (${((performance.now() - started) / 1000).toFixed(1)}s)`);
  assert.deepEqual(render('fine').json.warnings, []);
  const allowed = render('missing', ['--allow-missing-assets']);
  assert.ok(allowed.json.warnings.some((w) => w.message.includes('nai.png')), 'with --allow-missing-assets it becomes a warning and the video is rendered');
  } finally {
    delete process.env.KASANERU_IMAGE_TIMEOUT_MS;
    for (const socket of sockets) socket.destroy();
    hang.close();
  }
});

test('volume keyframes (frame numbers of the whole video, many points, {keyframes, easing})', async () => {
  const video = [{type: 'video', src: 'gray.png'}];
  // Even on a track with from: 30, keyframe frames count from the start of the video.
  const basis = loudness(run({composition: comp(90), layers: video, audio: [{src: 'tone.wav', from: 30, durationInFrames: 60, volume: [[0, 0], [59, 0], [60, 1]]}]}).out, 3);
  assert.ok(basis[1] < -60 && basis[2] > -20, `silent for frames 30-59, plays from frame 60: ${basis.map((v) => v.toFixed(0))}`);
  // One point per frame (nesting an ffmpeg expression in order from the first keyframe hits the depth limit at around 100 points).
  const many = Array.from({length: 600}, (_, f) => [f, f < 300 ? (f % 2 ? 0.001 : 0.002) : (f % 2 ? 0.9 : 1)]);
  const stepped = loudness(run({composition: comp(600), layers: video, audio: [{src: 'tone.wav', loop: true, volume: many}]}).out, 20);
  assert.ok(stepped[5] < -60 && stepped[15] > -25, `600 points: quiet in the first half, loud in the second: ${stepped[5].toFixed(0)}, ${stepped[15].toFixed(0)}`);
  const eased = loudness(run({composition: comp(60), layers: video, audio: [{src: 'tone.wav', volume: {keyframes: [[0, 0], [60, 1]], easing: 'inCubic'}}]}).out, 2);
  assert.ok(eased[0] < eased[1] - 10, `{keyframes, easing} also works: ${eased.map((v) => v.toFixed(0))}`);
  const {keyframeExpr, thinKeyframes} = await import('../src/ffmpeg.mjs');
  assert.deepEqual(thinKeyframes([[0, 0], [10, 1], [20, 2], [30, 3], [40, 3], [50, 3], [60, 0]]), [[0, 0], [30, 3], [50, 3], [60, 0]], 'points on a straight line are dropped');
  assert.equal(keyframeExpr([[5, 2]]), '2');
});

test('mono audio goes to left and right at 1x each (3 dB louder than ffmpeg -ac 2)', () => {
  // Volume of the left channel only (RMS, dB). Mixing back down to mono would bring the mixing coefficients into the result.
  const level = (file) => {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-t', '0.9', '-af', 'pan=mono|c0=c0', '-ar', '8000', '-f', 'f32le', '-'], {maxBuffer: 1 << 28});
    const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    return 20 * Math.log10(Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length) + 1e-9);
  };
  const source = level(path.join(dir, 'tone.wav'));
  const same = level(run({composition: comp(30), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav'}]}).out);
  near(same, source, 0.3, 'each channel is as loud as the original mono');
  const matched = level(run({composition: comp(30), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', volume: 0.7071}]}).out);
  near(matched, source - 3.01, 0.3, 'multiplying volume by 0.7071 matches -ac 2');
});

test('audio bitrate (--audio-bitrate)', () => {
  ff('-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink:a=0.5', '-ac', '2', path.join(dir, 'noise.wav'));
  const manifest = {composition: comp(120), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'noise.wav'}]};
  const rate = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0', file], {encoding: 'utf8'}));
  const standard = rate(run(manifest).out), low = rate(run(manifest, ['--audio-bitrate', '64k']).out);
  assert.ok(standard > 150000 && low < 90000, `192k by default, 64k when specified: ${standard}, ${low}`);
  assert.equal(run(manifest, ['--audio-bitrate', 'takai'], {expectFail: true}).status, 2);
});

test('a first or last frame with a different picture (edgeFrames in inspect --deep)', () => {
  const make = (name, expr) => ff('-f', 'lavfi', '-i', `color=c=gray:s=64x64:r=${FPS}:d=1,format=yuv420p,geq=lum='${expr}':cb=128:cr=128`, '-c:v', 'libx264', '-qp', '0', path.join(dir, name));
  make('edge_last.mp4', 'if(eq(N,29),235,90)');
  make('edge_first.mp4', 'if(eq(N,0),235,90)');
  const last = JSON.parse(cli('inspect', path.join(dir, 'edge_last.mp4'), '--deep'));
  assert.deepEqual([last.suspectFrames, last.edgeFrames], [[], [29]]);
  assert.ok(last.warnings.some((w) => w.includes('29') && w.includes('Check by eye')));
  assert.deepEqual(JSON.parse(cli('inspect', path.join(dir, 'edge_first.mp4'), '--deep')).edgeFrames, [0]);
  assert.deepEqual(JSON.parse(cli('inspect', path.join(dir, 'src.mp4'), '--deep')).edgeFrames, [], 'a smoothly changing video is not listed');
  assert.deepEqual(JSON.parse(cli('inspect', path.join(dir, 'glitch.mp4'), '--deep')).edgeFrames, []);
});

test('in-page script scenes: a missing asset fails, an in-page error is a warning', {skip: !chrome && 'Chrome not found'}, () => {
  mkdirSync(path.join(dir, 'pg'), {recursive: true});
  writeFileSync(path.join(dir, 'pg', 'page.mjs'), `export const scenes = {p: {
    async setup(ctx) {
      const img = new Image();
      img.src = ctx.assets + 'nai_page.png';
      await new Promise((r) => { img.onload = img.onerror = r; });
      setTimeout(() => { throw new Error('atokara'); }, 0);
      await new Promise((r) => setTimeout(r, 50));
    },
    draw() {},
  }};`);
  const manifest = {composition: comp(3), scenes: {page: 'pg/page.mjs'}, layers: [{type: 'scene', id: 'pg', scene: 'p', page: true}]};
  const bad = run(manifest, [], {backend: 'browser', expectFail: true});
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /scene "pg": Cannot load asset: .*nai_page\.png/);
  const messages = run(manifest, ['--allow-missing-assets'], {backend: 'browser'}).json.warnings.map((w) => w.message).join('\n');
  assert.match(messages, /nai_page\.png/);
  assert.match(messages, /Error in the page: .*atokara/);
});
