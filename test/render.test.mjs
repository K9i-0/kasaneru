// 書き出しのテスト。コマ番号を明るさに埋め込んだ素材を作り、出力の各コマがどのコマ由来かを明るさから判定する。
//   node --test test/
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
const BG = 16; // 背景#000000の輝度
const lumaOf = (sourceFrame) => 20 + 3 * sourceFrame;
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

before(() => {
  // src.mp4: 60コマ。コマnの輝度は 20+3n。音声は440Hzのサイン波。
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

// 出力の各コマについて、指定した範囲の平均輝度を返す。
function lumas(file, {w = 64, h = 64, crop = null} = {}) {
  const vf = (crop ? `crop=${crop},` : '') + 'extractplanes=y';
  const cw = crop ? Number(crop.split(':')[0]) : w, ch = crop ? Number(crop.split(':')[1]) : h;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', vf, '-f', 'rawvideo', '-'], {maxBuffer: 1 << 28});
  const size = cw * ch;
  return Array.from({length: raw.length / size}, (_, k) => raw.subarray(k * size, (k + 1) * size).reduce((s, x) => s + x, 0) / size);
}
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual.toFixed(1)} は ${expected} ±${tolerance} の外`);
const sourceFrame = (luma) => Math.round((luma - 20) / 3);
// 1秒ごとの音量（RMS、dB）。
function loudness(file, seconds) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], {maxBuffer: 1 << 28});
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  return Array.from({length: seconds}, (_, s) => {
    const part = samples.subarray(s * 8000, (s + 1) * 8000);
    const rms = Math.sqrt(part.reduce((a, x) => a + x * x, 0) / Math.max(1, part.length));
    return 20 * Math.log10(rms + 1e-9);
  });
}

test('クリップの位置と頭出し（from・durationInFrames・trimBefore）', () => {
  const {out} = run({composition: comp(40), layers: [{type: 'video', clips: [{src: 'src.mp4', from: 10, durationInFrames: 20, trimBefore: 5}]}]});
  const y = lumas(out);
  assert.equal(y.length, 40);
  near(y[9], BG, 1, '開始前は背景');
  assert.equal(sourceFrame(y[10]), 5, '最初のコマは素材の5コマ目');
  assert.equal(sourceFrame(y[29]), 24, '最後のコマは素材の24コマ目');
  near(y[30], BG, 1, '終了後は背景');
});

test('速度変更（playbackRate）', () => {
  const fast = lumas(run({composition: comp(20), layers: [{type: 'video', src: 'src.mp4', playbackRate: 2}]}).out);
  for (const j of [0, 5, 15]) near(sourceFrame(fast[j]), 2 * j, 1, `2倍速のコマ${j}`);
  const slow = lumas(run({composition: comp(40), layers: [{type: 'video', src: 'src.mp4', playbackRate: 0.5}]}).out);
  for (const j of [0, 10, 30]) near(sourceFrame(slow[j]), j / 2, 1, `0.5倍速のコマ${j}`);
});

test('フリーズ（freeze）とループ（loop）', () => {
  const frozen = lumas(run({composition: comp(15), layers: [{type: 'video', src: 'src.mp4', freeze: 12}]}).out);
  for (const j of [0, 7, 14]) assert.equal(sourceFrame(frozen[j]), 12, `止めたコマ${j}`);
  const looped = lumas(run({composition: comp(35), layers: [{type: 'video', src: 'src.mp4', loop: 10}]}).out);
  for (const j of [0, 9, 10, 23, 34]) assert.equal(sourceFrame(looped[j]), j % 10, `10コマでループ、コマ${j}`);
  const whole = lumas(run({composition: comp(130), layers: [{type: 'video', src: 'src.mp4', loop: true}]}).out);
  assert.equal(sourceFrame(whole[65]), 5, '素材全体（60コマ）をループ');
});

test('静止画のクリップ', () => {
  const y = lumas(run({composition: comp(10), layers: [{type: 'video', clips: [{src: 'gray.png', from: 3, durationInFrames: 4}]}]}).out);
  near(y[2], BG, 1, '前は背景');
  near(y[3], 16 + (200 / 255) * 219, 3, '画像の明るさ');
  near(y[7], BG, 1, '後は背景');
});

test('収め方（contain は余白を透明にする）', () => {
  const {out} = run({composition: comp(5, 128, 64), background: '#000000', layers: [{type: 'video', src: 'src.mp4', freeze: 40, fit: 'contain'}]});
  near(lumas(out, {crop: '24:64:2:0'})[2], BG, 1, '左の余白は背景');
  near(lumas(out, {crop: '40:64:44:0'})[2], lumaOf(40), 2, '中央は動画');
});

test('フェード（fadeIn・fadeOut）と不透明度', () => {
  const y = lumas(run({composition: comp(30), layers: [{type: 'video', src: 'src.mp4', freeze: 40, fadeIn: 10, fadeOut: 10}]}).out);
  near(y[0], BG, 4, 'フェードインの頭');
  assert.ok(y[5] > BG + 30 && y[5] < lumaOf(40) - 30, `途中は中間の明るさ（${y[5].toFixed(1)}）`);
  near(y[15], lumaOf(40), 2, '出きった状態');
  assert.ok(y[25] > BG + 20 && y[25] < lumaOf(40) - 20, `フェードアウトの途中（${y[25].toFixed(1)}）`);
  const half = lumas(run({composition: comp(3), layers: [{type: 'video', src: 'src.mp4', freeze: 40, opacity: 0.5}]}).out);
  near(half[1], (BG + lumaOf(40)) / 2, 3, '半透明');
});

test('色のフィルタ（CSSと同じ書き方）', () => {
  const still = (filter) => lumas(run({composition: comp(3), layers: [{type: 'video', src: 'src.mp4', freeze: 40, filter}]}).out)[1];
  const v = (lumaOf(40) - 16) / 219; // 素材の明るさ（0〜1）
  const toLuma = (r, g, b) => 16 + 219 * (0.2126 * Math.min(1, r) + 0.7152 * Math.min(1, g) + 0.0722 * Math.min(1, b));
  near(still('brightness(0.5)'), toLuma(v * 0.5, v * 0.5, v * 0.5), 2, '明るさ半分');
  near(still('contrast(2)'), toLuma((v - 0.5) * 2 + 0.5, (v - 0.5) * 2 + 0.5, (v - 0.5) * 2 + 0.5), 2, 'コントラスト2倍');
  near(still('invert(1)'), toLuma(1 - v, 1 - v, 1 - v), 2, '反転');
  near(still('sepia(1)'), toLuma(1.351 * v, 1.203 * v, 0.937 * v), 2, 'セピア');
  near(still('brightness(50%) invert(100%)'), toLuma(1 - v * 0.5, 1 - v * 0.5, 1 - v * 0.5), 2, '順にかける');
  near(still('opacity(0.5)'), (BG + lumaOf(40)) / 2, 3, 'opacity() は不透明度');
});

test('回転（rotate）', () => {
  // 左半分が白、右半分が黒の絵を、時計回りに90度回すと上半分が白になる。
  ff('-f', 'lavfi', '-i', 'color=black:s=64x64,format=rgb24,drawbox=x=0:y=0:w=32:h=64:color=white:t=fill', '-frames:v', '1', path.join(dir, 'half.png'));
  const {out} = run({composition: comp(3), background: '#000000', layers: [{type: 'video', src: 'half.png', rotate: 90}]});
  near(lumas(out, {crop: '40:20:12:6'})[1], 235, 4, '上は白');
  near(lumas(out, {crop: '40:20:12:38'})[1], 16, 4, '下は黒');
  const spin = run({composition: comp(11), background: '#000000', layers: [{type: 'video', src: 'half.png', rotate: {keyframes: [[0, 0], [10, 180]]}}]}).out;
  near(lumas(spin, {crop: '20:40:6:12'})[0], 235, 4, '最初は左が白');
  near(lumas(spin, {crop: '20:40:6:12'})[10], 16, 4, '180度で左が黒');
});

test('透過PNGのクリップは、透明な所で下の層が見える', () => {
  // 左半分が不透明な白、右半分が完全に透明な画像を、動画の上に重ねる。
  ff('-f', 'lavfi', '-i', "color=white:s=64x64,format=rgba,geq=r=255:g=255:b=255:a='if(lt(X,32),255,0)'", '-frames:v', '1', path.join(dir, 'alpha_half.png'));
  const {out} = run({composition: comp(10), layers: [{type: 'video', src: 'src.mp4'}, {type: 'video', src: 'alpha_half.png', fadeOut: 2}]});
  const left = lumas(out, {crop: '16:16:8:24'}), right = lumas(out, {crop: '16:16:40:24'});
  assert.ok(left[3] > 225, `不透明な所は画像の白: ${left[3]}`);
  near(right[3], lumaOf(3), 2, '透明な所は下の動画');
});

test('マスク（角丸・楕円・画像）', () => {
  const base = {composition: comp(3), background: '#000000'};
  const round = run({...base, layers: [{type: 'video', src: 'gray.png', radius: 20}]}).out;
  near(lumas(round, {crop: '4:4:0:0'})[1], BG, 3, '角は背景');
  near(lumas(round, {crop: '8:8:28:28'})[1], 16 + (200 / 255) * 219, 3, '中央は絵');
  const ellipse = run({...base, layers: [{type: 'video', src: 'gray.png', mask: 'ellipse'}]}).out;
  near(lumas(ellipse, {crop: '6:6:2:2'})[1], BG, 3, '楕円の外は背景');
  near(lumas(ellipse, {crop: '8:8:28:2'})[1], 16 + (200 / 255) * 219, 4, '上辺の中央は絵');
  const image = run({...base, layers: [{type: 'video', src: 'gray.png', mask: 'half.png'}]}).out;
  near(lumas(image, {crop: '20:40:6:12'})[1], 16 + (200 / 255) * 219, 3, 'マスクの白い所は絵');
  near(lumas(image, {crop: '20:40:38:12'})[1], BG, 3, 'マスクの黒い所は背景');
});

test('透明度のキーフレーム', () => {
  const y = lumas(run({composition: comp(21), layers: [{type: 'video', src: 'src.mp4', freeze: 40, opacity: {keyframes: [[0, 0], [10, 1], [20, 0.5]]}}]}).out);
  near(y[0], BG, 3, '0コマ目は透明');
  near(y[5], (BG + lumaOf(40)) / 2, 5, '5コマ目は半分');
  near(y[10], lumaOf(40), 3, '10コマ目は不透明');
  near(y[20], (BG + lumaOf(40)) / 2, 4, '20コマ目は半分');
});

test('合成モード（mix-blend-mode と同じ名前）', () => {
  // 下の絵（明るさv）に、同じ絵を掛け合わせる。
  const v = 200 / 255;
  const out = (blend, extra = {}) => lumas(run({composition: comp(6), background: '#000000', layers: [{type: 'video', src: 'gray.png'}, {type: 'video', clips: [{src: 'gray.png', blend, ...extra}]}]}).out);
  near(out('multiply')[1], 16 + 219 * v * v, 3, '乗算');
  near(out('screen')[1], 16 + 219 * (1 - (1 - v) * (1 - v)), 3, 'スクリーン');
  const timed = out('multiply', {from: 2, durationInFrames: 2});
  near(timed[1], 16 + 219 * v, 3, '出る前は下の絵のまま');
  near(timed[2], 16 + 219 * v * v, 3, '出ている間だけ乗算');
  near(timed[4], 16 + 219 * v, 3, '消えた後は下の絵のまま');
});

test('位置のずらし（offsetX のキーフレーム）', () => {
  const {out} = run({composition: comp(12, 128, 64), layers: [{type: 'video', src: 'src.mp4', freeze: 40, width: 64, height: 64, offsetX: {keyframes: [[0, 0], [10, 64]]}}]});
  near(lumas(out, {crop: '60:64:2:0'})[0], lumaOf(40), 2, '最初は左');
  near(lumas(out, {crop: '60:64:2:0'})[10], BG, 2, '最後は左が空く');
  near(lumas(out, {crop: '60:64:66:0'})[10], lumaOf(40), 2, '最後は右');
  near(lumas(out, {crop: '30:64:34:0'})[5], lumaOf(40), 2, '途中は真ん中');
});

test('音声の位置・長さ・ループ・速度・フェード、クリップの音声', () => {
  const placed = loudness(run({composition: comp(90), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', from: 30, durationInFrames: 30}]}).out, 3);
  assert.ok(placed[0] < -60 && placed[1] > -20 && placed[2] < -60, `1秒目だけ鳴る: ${placed.map((v) => v.toFixed(0))}`);
  const looped = loudness(run({composition: comp(150), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', loop: true}]}).out, 5);
  assert.ok(looped.every((v) => v > -20), `ループで最後まで鳴る: ${looped.map((v) => v.toFixed(0))}`);
  const fast = loudness(run({composition: comp(90), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', playbackRate: 2}]}).out, 3);
  assert.ok(fast[0] > -20 && fast[1] < -40, `2倍速で1秒に縮む: ${fast.map((v) => v.toFixed(0))}`);
  const faded = loudness(run({composition: comp(90), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', durationInFrames: 60, fadeOut: 30}]}).out, 2);
  assert.ok(faded[1] < faded[0] - 3, `後半はフェードで小さい: ${faded.map((v) => v.toFixed(1))}`);
  const fromClip = loudness(run({composition: comp(90), layers: [{type: 'video', clips: [{src: 'src.mp4', from: 30, durationInFrames: 30, volume: 1}]}]}).out, 3);
  assert.ok(fromClip[0] < -60 && fromClip[1] > -20 && fromClip[2] < -60, `volumeを書いたクリップの音が同じ位置で鳴る: ${fromClip.map((v) => v.toFixed(0))}`);
  const silent = run({composition: comp(30), layers: [{type: 'video', src: 'src.mp4'}]}).out;
  assert.ok(!execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', silent], {encoding: 'utf8'}).includes('audio'), 'volumeを書かないクリップは無音');
});

test('区間書き出し（--frames）と1コマ書き出し（still）', () => {
  // 音声つきでも1コマ書き出しができること。
  const manifest = {composition: comp(40), layers: [{type: 'video', src: 'src.mp4', volume: 1}], audio: [{src: 'tone.wav'}]};
  const part = lumas(run(manifest, ['--frames', '10-19']).out);
  assert.equal(part.length, 10);
  assert.equal(sourceFrame(part[0]), 10);
  assert.equal(sourceFrame(part[9]), 19);
  const still = run(manifest, ['still', '--frame', '25'], {ext: 'png'});
  assert.ok(existsSync(still.out));
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', still.out, '-vf', 'format=gray', '-f', 'rawvideo', '-']);
  near(raw.reduce((s, x) => s + x, 0) / raw.length, ((lumaOf(25) - 16) / 219) * 255, 3, '25コマ目の絵');
});

test('check は誤りを場所つきで挙げる', () => {
  const bad = run({composition: {width: 64, height: 64, fps: 30, durationInFrames: 0}, layers: [{type: 'video', src: 'nai.mp4', playbackRate: 0, fitt: 'cover', filter: 'glow(2)', blend: 'nai'}, {type: 'scene', id: 'a b'}], audio: [{src: 'gray.png'}]}, ['check'], {expectFail: true, backend: 'browser'});
  assert.equal(bad.status, 1);
  const where = bad.json.errors.map((e) => e.where);
  for (const w of ['composition.durationInFrames', 'layers[0].fitt', 'layers[0].filter', 'layers[0].blend', 'layers[0].src', 'layers[0].playbackRate', 'layers[1].id', 'audio[0].src']) assert.ok(where.includes(w), `${w} を指摘する（指摘: ${where.join(', ')}）`);
  const good = run({composition: comp(10), layers: [{type: 'video', src: 'src.mp4'}]}, ['check']);
  assert.equal(good.json.ok, true);
  const refused = run({composition: comp(10), layers: [{type: 'video', src: 'nai.mp4'}]}, [], {expectFail: true});
  assert.equal(refused.status, 1, '誤りがあるmanifestは書き出さない');
});

test('inspect は尺・コマ数・先頭コマの暗さを報告する', () => {
  const {out} = run({composition: comp(30), layers: [{type: 'video', src: 'src.mp4'}], audio: [{src: 'tone.wav'}]});
  const report = JSON.parse(execFileSync('node', [CLI, 'inspect', out], {encoding: 'utf8'}));
  assert.equal(report.video.frames, 30);
  assert.equal(report.video.width, 64);
  assert.equal(report.firstFrame.dark, true, '先頭コマ（輝度20）は暗いと判定');
  assert.ok(report.warnings.some((w) => w.includes('先頭コマ')));
  assert.ok(report.audio.meanVolumeDb > -30);
});

const chrome = existsSync('/Applications/Google Chrome.app');
test('ブラウザで描く層（同じ絵のまとめ・範囲指定・不透明な層の空き区間）', {skip: !chrome && 'Chromeがない'}, () => {
  mkdirSync(path.join(dir, 'b'), {recursive: true});
  writeFileSync(path.join(dir, 'b', 'scene.mjs'), `
    const box = (color) => '<div style="position:absolute;inset:0;background:' + color + '"></div>';
    export const scenes = {
      // 10コマごとに白と灰色を行き来する。描くのは2枚だけのはず。
      flip: {render: (f) => box(Math.floor(f / 10) % 2 ? '#808080' : '#ffffff')},
      // 20〜29コマだけ出る不透明な層。
      band: {key: (f) => (f >= 20 && f < 30 ? 'on' : null), render: () => box('#ffffff')},
    };`);
  const {out, json} = run({
    composition: comp(40, 128, 64), background: '#000000', scenes: {browser: 'b/scene.mjs'},
    layers: [
      {type: 'scene', id: 'flip', scene: 'flip', region: {x: 0, y: 0, width: 64, height: 64}},
      {type: 'scene', id: 'band', scene: 'band', region: {x: 64, y: 0, width: 64, height: 64}, opaque: true},
    ],
  }, [], {backend: 'browser'});
  assert.equal(json.imagesDrawn, 3, '白・灰・帯の3枚だけ描く');
  const left = lumas(out, {crop: '60:60:2:2'}), right = lumas(out, {crop: '60:60:66:2'});
  near(left[5], 235, 2, '左: 0〜9は白');
  near(left[15], 126, 3, '左: 10〜19は灰色');
  near(left[25], 235, 2, '左: 20〜29は白（同じ絵の使い回し）');
  near(right[19], BG, 2, '右: 19コマ目は背景');
  near(right[20], 235, 3, '右: 20コマ目から帯');
  near(right[29], 235, 3, '右: 29コマ目まで帯');
  near(right[30], BG, 2, '右: 30コマ目は背景');
});

test('字幕ファイルの読み込み（SRT・ASS）', async () => {
  const {parseAss, parseSrt, toFrames} = await import('../src/subtitles.mjs');
  const srt = parseSrt('1\n00:00:01,000 --> 00:00:02,500\n<i>こんにちは</i>\n二行目\n\n2\n00:00:03.000 --> 00:00:04.000\n{\\an8}上に出す\n');
  assert.deepEqual(toFrames(srt, 30), [{from: 30, to: 75, text: 'こんにちは\n二行目'}, {from: 90, to: 120, text: '上に出す'}]);
  const ass = parseAss('[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00,0:00:03.50,Default,店長,0,0,0,,{\\b1}はい、{\\b0}どうぞ\\N次の行\nComment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,無視\n');
  assert.deepEqual(toFrames(ass, 24), [{from: 48, to: 84, text: 'はい、どうぞ\n次の行', speaker: '店長', style: 'Default'}]);
});

test('字幕の層（type: captions）', {skip: !chrome && 'Chromeがない'}, () => {
  writeFileSync(path.join(dir, 'sub.srt'), '1\n00:00:00,500 --> 00:00:01,000\n■■■■■■\n');
  const {out, json} = run({
    composition: comp(40, 320, 180), background: '#000000',
    layers: [{type: 'captions', src: 'sub.srt', style: {fontSize: 40, strokeWidth: 0, bottom: 20, color: '#ffffff'}}],
  }, [], {backend: 'browser'});
  assert.equal(json.imagesDrawn, 1);
  const y = lumas(out, {w: 320, h: 180, crop: '160:30:80:125'});
  near(y[14], BG, 2, '出る前は背景');
  assert.ok(y[15] > 120, `15コマ目から字幕（${y[15].toFixed(0)}）`);
  assert.ok(y[29] > 120, `29コマ目まで字幕（${y[29].toFixed(0)}）`);
  near(y[30], BG, 2, '消えた後は背景');
  const bad = run({composition: comp(10), layers: [{type: 'captions', style: {fontsize: 3}}]}, ['check'], {expectFail: true, backend: 'browser'});
  assert.ok(bad.json.errors.some((e) => e.where === 'layers[0].style.fontsize') && bad.json.errors.some((e) => e.where === 'layers[0]'));
});

test('例（examples/basic）が書き出せる', {skip: !chrome && 'Chromeがない'}, () => {
  const example = fileURLToPath(new URL('../examples/basic/', import.meta.url));
  execFileSync('node', [path.join(example, 'make-assets.mjs')]);
  const out = path.join(dir, 'basic.mp4');
  execFileSync('node', [CLI, 'render', path.join(example, 'manifest.json'), '-o', out]);
  const report = JSON.parse(execFileSync('node', [CLI, 'inspect', out], {encoding: 'utf8'}));
  assert.equal(report.video.frames, 210);
  assert.deepEqual(report.warnings, []);
});

test('単色のクリップ（暗転・色かぶせ）', () => {
  const y = lumas(run({composition: comp(20), layers: [{type: 'video', src: 'gray.png'}, {type: 'video', clips: [{color: '#000000', from: 10, durationInFrames: 10, fadeIn: 10}]}]}).out);
  near(y[5], 16 + (200 / 255) * 219, 3, '暗転の前');
  assert.ok(y[15] < y[5] - 40 && y[15] > BG + 20, `暗転の途中（${y[15].toFixed(0)}）`);
});

test('素材の切り出し（crop）・寄せ位置（align）・反転（flip）', () => {
  const base = {composition: comp(11), background: '#000000'};
  // half.png は左半分が白。左側32pxを切り出すと全面が白になる。
  near(lumas(run({...base, layers: [{type: 'video', src: 'half.png', crop: {x: 0, y: 0, width: 32, height: 64}, fit: 'fill'}]}).out)[1], 235, 3, '左を切り出すと白');
  const pan = lumas(run({...base, layers: [{type: 'video', src: 'half.png', crop: {x: {keyframes: [[0, 0], [10, 32]]}, y: 0, width: 32, height: 64}, fit: 'fill'}]}).out);
  near(pan[0], 235, 3, 'パンの最初は白');
  near(pan[10], 16, 3, 'パンの最後は黒');
  // 64x64 の絵を 32x64 の箱に cover で入れる。寄せ位置で見える側が変わる。
  const side = (ax) => lumas(run({...base, composition: comp(3, 32, 64), layers: [{type: 'video', src: 'half.png', align: [ax, 0.5]}]}).out, {w: 32, h: 64})[1];
  near(side(0), 235, 3, '左寄せは白い側');
  near(side(1), 16, 3, '右寄せは黒い側');
  const flipped = run({...base, layers: [{type: 'video', src: 'half.png', flip: 'h'}]}).out;
  near(lumas(flipped, {crop: '20:40:6:12'})[1], 16, 3, '左右反転で左が黒');
});

test('逆再生（reverse）と揺れ（shake）', () => {
  const y = lumas(run({composition: comp(10), layers: [{type: 'video', src: 'src.mp4', trimBefore: 20, durationInFrames: 10, reverse: true}]}).out);
  assert.equal(sourceFrame(y[0]), 29, '最初は切り出した範囲の最後');
  assert.equal(sourceFrame(y[9]), 20, '最後は切り出した範囲の最初');
  const shaken = run({composition: comp(20, 128, 64), background: '#000000', layers: [{type: 'video', src: 'gray.png', width: 64, height: 64, x: 32, y: 0, shake: {amplitude: 20, speed: 6, durationInFrames: 10, decay: false}}]}).out;
  const edge = lumas(shaken, {crop: '8:40:24:12'});
  assert.ok(Math.max(...edge.slice(0, 10)) - Math.min(...edge.slice(0, 10)) > 30, `揺れている間は端の明るさが変わる（${edge.slice(0, 10).map((v) => v.toFixed(0))}）`);
  near(edge[15], BG, 2, '揺れが終わると元の位置');
  const again = lumas(run({composition: comp(20, 128, 64), background: '#000000', layers: [{type: 'video', src: 'gray.png', width: 64, height: 64, x: 32, y: 0, shake: {amplitude: 20, speed: 6, durationInFrames: 10, decay: false}}]}).out, {crop: '8:40:24:12'});
  assert.deepEqual(again.map((v) => Math.round(v)), edge.map((v) => Math.round(v)), '何度書き出しても同じ揺れ');
});

test('クロマキー（chromaKey）と透視合成（corners）', () => {
  ff('-f', 'lavfi', '-i', 'color=c=0x00ff00:s=64x64,format=rgb24,drawbox=x=0:y=0:w=32:h=64:color=white:t=fill', '-frames:v', '1', path.join(dir, 'green.png'));
  const keyed = run({composition: comp(3), background: '#000000', layers: [{type: 'video', src: 'green.png', chromaKey: {color: '#00ff00'}}]}).out;
  near(lumas(keyed, {crop: '20:40:6:12'})[1], 235, 4, '白い側は残る');
  near(lumas(keyed, {crop: '20:40:38:12'})[1], BG, 4, '緑の側は抜けて背景');
  // 全面白の絵を、右半分の四角にはめ込む。
  ff('-f', 'lavfi', '-i', 'color=c=white:s=64x64,format=rgb24', '-frames:v', '1', path.join(dir, 'white.png'));
  const fitted = run({composition: comp(3, 128, 64), background: '#000000', layers: [{type: 'video', src: 'white.png', corners: [[70, 6], [122, 6], [70, 58], [122, 58]]}]}).out;
  near(lumas(fitted, {w: 128, h: 64, crop: '40:40:76:12'})[1], 235, 4, '四隅の内側は絵');
  near(lumas(fitted, {w: 128, h: 64, crop: '56:56:4:4'})[1], BG, 3, '外側は背景');
});

test('調整レイヤー（adjust）', () => {
  const v = 16 + (200 / 255) * 219;
  const tint = run({composition: comp(10, 128, 64), layers: [{type: 'video', src: 'gray.png', fit: 'fill'}, {type: 'adjust', region: {x: 64, y: 0, width: 64, height: 64}, filter: 'brightness(0.5)', from: 2, durationInFrames: 4}]}).out;
  const left = lumas(tint, {w: 128, h: 64, crop: '56:56:4:4'}), right = lumas(tint, {w: 128, h: 64, crop: '56:56:68:4'});
  near(left[3], v, 3, '範囲の外はそのまま');
  near(right[3], 16 + (200 / 255) * 0.5 * 219, 3, '範囲の中だけ暗い');
  near(right[1], v, 3, '始まる前はそのまま');
  near(right[7], v, 3, '終わった後はそのまま');
  // ぼかし: 白黒の境目がなだらかになる。
  const blurred = run({composition: comp(3), layers: [{type: 'video', src: 'half.png'}, {type: 'adjust', filter: 'blur(6px)'}]}).out;
  const mid = lumas(blurred, {crop: '2:40:31:12'})[1];
  assert.ok(mid > 60 && mid < 200, `境目が中間の明るさ（${mid.toFixed(0)}）`);
  const vig = run({composition: comp(3), layers: [{type: 'video', src: 'gray.png'}, {type: 'adjust', vignette: 0.8, grain: 0.2}]}).out;
  assert.ok(lumas(vig, {crop: '6:6:0:0'})[1] < lumas(vig, {crop: '8:8:28:28'})[1] - 15, 'ビネットで隅が暗い');
});

test('順に並べる（sequence）と長さの自動計算', () => {
  // 60コマの素材を2本。2本目は頭を30コマ飛ばす。重なり10コマ。全体の長さは書かない。
  const {out, json} = run({composition: {width: 64, height: 64, fps: FPS}, layers: [{type: 'video', sequence: true, overlap: 10, clips: [{src: 'src.mp4'}, {src: 'src.mp4', trimBefore: 30, fadeIn: 10}]}]});
  assert.equal(json.frames, 80, '60 + 30 - 10');
  const y = lumas(out);
  assert.equal(sourceFrame(y[40]), 40, '1本目');
  assert.equal(sourceFrame(y[70]), 50, '2本目は 70-50+30');
});

test('自動ダッキング（duck）・音程（pitch）', () => {
  const ducked = loudness(run({
    composition: comp(150), layers: [{type: 'video', src: 'gray.png'}],
    audio: [{src: 'tone.wav', loop: true, volume: 1, duck: {by: 'voice', to: 0.1, attack: 0, release: 0, lead: 0, tail: 0}}, {src: 'tone.wav', from: 60, durationInFrames: 30, volume: 0.0001, group: 'voice'}],
  }).out, 5);
  assert.ok(ducked[2] < ducked[0] - 15, `声のある2秒目だけ下がる: ${ducked.map((v) => v.toFixed(0))}`);
  near(ducked[4], ducked[0], 1.5, '声が終わると戻る');
  const high = run({composition: comp(60), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', pitch: 12}]}).out;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', high, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], {maxBuffer: 1 << 26});
  const s = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4).subarray(2000, 10000);
  let crossings = 0;
  for (let i = 1; i < s.length; i++) if (s[i - 1] <= 0 && s[i] > 0) crossings++;
  near(crossings, 880, 40, '1オクターブ上（440Hz → 880Hz）');
  assert.ok(loudness(high, 2)[1] > -20, '長さは変わらない（2秒目も鳴っている）');
});

const cli = (...args) => execFileSync('node', [CLI, ...args], {encoding: 'utf8'});

test('props の差し替え（--props・--set）', {skip: !chrome && 'Chromeがない'}, () => {
  mkdirSync(path.join(dir, 'p'), {recursive: true});
  writeFileSync(path.join(dir, 'p', 'scene.mjs'), `export const scenes = {box: {render: (f, props) => '<div style="position:absolute;inset:0;background:' + props.look.color + '"></div>'}};`);
  const manifest = {composition: comp(3), scenes: {browser: 'p/scene.mjs'}, layers: [{type: 'scene', id: 'box', scene: 'box'}], props: {look: {color: '#000000', other: 1}}};
  near(lumas(run(manifest, [], {backend: 'browser'}).out)[1], 16, 2, '元は黒');
  near(lumas(run(manifest, ['--set', 'look.color=#ffffff'], {backend: 'browser'}).out)[1], 235, 2, '--set で白');
  near(lumas(run(manifest, ['--props', '{"look":{"color":"#808080"}}'], {backend: 'browser'}).out)[1], 126, 3, '--props で灰色');
});

test('出力形式（mov・webm・gif）', () => {
  const manifest = {composition: comp(12), layers: [{type: 'video', src: 'src.mp4', volume: 1}]};
  for (const [ext, codec] of [['mov', 'prores'], ['webm', 'vp9'], ['gif', 'gif']]) {
    const {out} = run(manifest, [], {ext});
    const info = JSON.parse(cli('inspect', out));
    assert.equal(info.video.codec, codec, ext);
    assert.equal(info.video.frames, 12, `${ext} のコマ数`);
  }
});

test('コマ一覧（sheet）', () => {
  const {out, file} = run({composition: comp(40), layers: [{type: 'video', clips: [{src: 'src.mp4', from: 10, durationInFrames: 20}]}]});
  const byList = JSON.parse(cli('sheet', out, '--frames', '0,10,29', '-o', path.join(dir, 'sheet1.png')));
  assert.deepEqual(byList.frames, [0, 10, 29]);
  const byManifest = JSON.parse(cli('sheet', out, '--manifest', file, '--backend', 'none', '-o', path.join(dir, 'sheet2.png')));
  assert.deepEqual(byManifest.frames, [0, 10, 29, 39], 'クリップの出入りと全体の最初・最後');
  assert.ok(existsSync(path.join(dir, 'sheet2.png')));
});

test('字幕のSRT書き出し（srt）', () => {
  const manifest = {composition: comp(90), layers: [{type: 'video', src: 'gray.png'}, {type: 'captions', items: [{from: 45, to: 75, text: '二つ目'}, {from: 0, to: 30, text: '一つ目\n二行'}]}], props: {lines: [{startFrame: 15, endFrame: 45, text: '別の場所'}]}};
  const a = run(manifest, ['srt'], {ext: 'srt'});
  assert.equal(readFileSync(a.out, 'utf8'), '1\n00:00:00,000 --> 00:00:01,000\n一つ目\n二行\n\n2\n00:00:01,500 --> 00:00:02,500\n二つ目\n');
  const b = run(manifest, ['srt', '--key', 'props.lines'], {ext: 'srt'});
  assert.equal(readFileSync(b.out, 'utf8'), '1\n00:00:00,500 --> 00:00:01,500\n別の場所\n');
});

test('素材を調べる（probe・envelope）', async () => {
  const info = JSON.parse(cli('probe', path.join(dir, 'src.mp4'), '--fps', '24'));
  assert.equal(info.durationInFrames, 48);
  assert.equal(info.width, 64);
  assert.equal(info.hasAudio, true);
  // 前半だけ鳴る音: 無音1秒を後ろに足す。
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', 'apad=pad_dur=1', path.join(dir, 'half.wav'));
  const env = JSON.parse(cli('envelope', path.join(dir, 'half.wav'), '--fps', '10'));
  assert.equal(env.length, 20);
  assert.ok(env[3] > 0.05 && env[15] < 0.001, `前半は鳴り、後半は無音: ${env[3]}, ${env[15]}`);
  const {mediaFrames} = await import('../src/resolve.mjs');
  assert.equal(mediaFrames(path.join(dir, 'src.mp4'), 30), 60);
});

test('壊れた1コマの検出（inspect --deep）', () => {
  // 静止した絵の途中に、1コマだけ真っ白を挟む。
  ff('-f', 'lavfi', '-i', `color=c=gray:s=64x64:r=${FPS}:d=1,format=yuv420p,geq=lum='if(eq(N,14),235,90)':cb=128:cr=128`, '-c:v', 'libx264', '-qp', '0', path.join(dir, 'glitch.mp4'));
  const bad = JSON.parse(cli('inspect', path.join(dir, 'glitch.mp4'), '--deep'));
  assert.deepEqual(bad.suspectFrames, [14]);
  assert.ok(bad.warnings.some((w) => w.includes('14')));
  const fine = JSON.parse(cli('inspect', path.join(dir, 'src.mp4'), '--deep'));
  assert.deepEqual(fine.suspectFrames, [], 'なめらかに変わる動画は挙げない');
});

test('アニメーション関数（random・noise・typewriter・easing）', async () => {
  const {clamp, easings, interpolate, noise, random, typewriter} = await import('../src/anim.mjs');
  assert.equal(random('a'), random('a'));
  assert.notEqual(random('a'), random('b'));
  assert.ok(random(1) >= 0 && random(1) < 1);
  assert.ok(Math.abs(noise('s', 3.5)) <= 1);
  assert.equal(noise('s', 2), random('s:2') * 2 - 1, '整数の位置では乱数そのもの');
  assert.equal(typewriter('こんにちは', 15, 30, 4), 'こん');
  assert.equal(clamp(1.5), 1);
  assert.equal(easings.outBack(1), 1);
  assert.equal(interpolate(5, [0, 10], [0, 100], 'inQuad'), 25);
});

test('フォントファイルの読み込み（fonts）', {skip: !chrome && 'Chromeがない'}, () => {
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
  assert.ok(Math.abs(withFont - fallback) > 3, `読み込んだフォントで描かれる（${withFont.toFixed(1)} と ${fallback.toFixed(1)}）`);
});

test('読めない画像があると書き出さない（<img>・背景画像・SVG内の画像・時間切れ）', {skip: !chrome && 'Chromeがない'}, async () => {
  mkdirSync(path.join(dir, 'img'), {recursive: true});
  ff('-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', path.join(dir, 'img', 'ok.png'));
  // つないでも返事をしないサーバー（読み込みが終わらない画像）。
  const {createServer} = await import('node:net');
  const sockets = [];
  const hang = createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
  try {
  const svg = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 10 10%22%3E%3Crect width=%2210%22 height=%2210%22/%3E%3C/svg%3E';
  writeFileSync(path.join(dir, 'img', 'scene.mjs'), `
    const wrap = (inner) => '<div style="position:absolute;inset:0;background:#fff">' + inner + '</div>';
    export const scenes = {
      // 毎コマ絵が変わる層に、ない画像が居座る。
      missing: {render: (f) => wrap('<img src="nai.png"><span>' + f + '</span>')},
      rooted: {render: () => wrap('<img src="/images/a.png">')},
      css: {render: () => wrap('<div style="width:9px;height:9px;background-image:url(nai_bg.png)"></div><svg><image href="nai_svg.png" width="9" height="9"/></svg>')},
      slow: {render: (f) => wrap('<img src="http://127.0.0.1:${hang.address().port}/slow.png"><span>' + f + '</span>')},
      // 読める画像、srcのない<img>、大きさ指定のないSVGは、失敗にしない。
      fine: {render: () => wrap('<img src="ok.png"><img><img src="${svg}">')},
    };`);
  const render = (scene, extra = [], options = {}) => run({composition: comp(4), scenes: {browser: 'img/scene.mjs'}, layers: [{type: 'scene', id: 'a', scene}]}, extra, {backend: 'browser', ...options});
  const missing = render('missing', [], {expectFail: true});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /scene「a」 コマ0: 素材を読めません: file:\/\/.*img\/nai\.png（4枚の絵で発生）/);
  assert.ok(!existsSync(missing.out), '動画は作らない');
  assert.match(render('rooted', [], {expectFail: true}).stderr, /file:\/\/\/images\/a\.png/, '/ 始まりのパスはディスクの根を指すので読めない');
  const css = render('css', [], {expectFail: true});
  assert.match(css.stderr, /nai_bg\.png/);
  assert.match(css.stderr, /nai_svg\.png/);
  process.env.KASANERU_IMAGE_TIMEOUT_MS = '400';
  // 時間切れを待つのは1ページにつき1回だけ（12コマを1ページで描いても、12回は待たない）。
  const started = performance.now();
  const slow = run({composition: comp(12), scenes: {browser: 'img/scene.mjs'}, layers: [{type: 'scene', id: 'a', scene: 'slow'}]}, ['--concurrency', '1'], {backend: 'browser', expectFail: true});
  assert.match(slow.stderr, /読み込みが0\.4秒で終わりません: http:.*slow\.png（12枚の絵で発生）/);
  assert.ok(performance.now() - started < 4000, `時間切れした画像を毎コマ待ち直さない（${((performance.now() - started) / 1000).toFixed(1)}秒）`);
  assert.deepEqual(render('fine').json.warnings, []);
  const allowed = render('missing', ['--allow-missing-assets']);
  assert.ok(allowed.json.warnings.some((w) => w.message.includes('nai.png')), '--allow-missing-assets なら注意にして書き出す');
  } finally {
    delete process.env.KASANERU_IMAGE_TIMEOUT_MS;
    for (const socket of sockets) socket.destroy();
    hang.close();
  }
});

test('音量のキーフレーム（動画全体のコマ番号・点が多いとき・{keyframes, easing}）', async () => {
  const video = [{type: 'video', src: 'gray.png'}];
  // from: 30 のトラックでも、キーフレームのコマは動画の頭から数える。
  const basis = loudness(run({composition: comp(90), layers: video, audio: [{src: 'tone.wav', from: 30, durationInFrames: 60, volume: [[0, 0], [59, 0], [60, 1]]}]}).out, 3);
  assert.ok(basis[1] < -60 && basis[2] > -20, `30〜59コマは無音、60コマから鳴る: ${basis.map((v) => v.toFixed(0))}`);
  // コマごとに1点（ffmpegの式は、先頭から入れ子にすると100点ほどで深さの上限に当たる）。
  const many = Array.from({length: 600}, (_, f) => [f, f < 300 ? (f % 2 ? 0.001 : 0.002) : (f % 2 ? 0.9 : 1)]);
  const stepped = loudness(run({composition: comp(600), layers: video, audio: [{src: 'tone.wav', loop: true, volume: many}]}).out, 20);
  assert.ok(stepped[5] < -60 && stepped[15] > -25, `600点: 前半は小さく、後半は大きい: ${stepped[5].toFixed(0)}, ${stepped[15].toFixed(0)}`);
  const eased = loudness(run({composition: comp(60), layers: video, audio: [{src: 'tone.wav', volume: {keyframes: [[0, 0], [60, 1]], easing: 'inCubic'}}]}).out, 2);
  assert.ok(eased[0] < eased[1] - 10, `{keyframes, easing} でも書ける: ${eased.map((v) => v.toFixed(0))}`);
  const {keyframeExpr, thinKeyframes} = await import('../src/ffmpeg.mjs');
  assert.deepEqual(thinKeyframes([[0, 0], [10, 1], [20, 2], [30, 3], [40, 3], [50, 3], [60, 0]]), [[0, 0], [30, 3], [50, 3], [60, 0]], '直線上の点は省く');
  assert.equal(keyframeExpr([[5, 2]]), '2');
});

test('モノラルの音声は左右へ1倍で入る（ffmpegの -ac 2 より3dB大きい）', () => {
  // 左チャンネルだけの音量（RMS、dB）。モノラルへ混ぜ直すと、混ぜ方の係数が結果に入ってしまう。
  const level = (file) => {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-t', '0.9', '-af', 'pan=mono|c0=c0', '-ar', '8000', '-f', 'f32le', '-'], {maxBuffer: 1 << 28});
    const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    return 20 * Math.log10(Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length) + 1e-9);
  };
  const source = level(path.join(dir, 'tone.wav'));
  const same = level(run({composition: comp(30), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav'}]}).out);
  near(same, source, 0.3, '各チャンネルが元のモノラルと同じ大きさ');
  const matched = level(run({composition: comp(30), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'tone.wav', volume: 0.7071}]}).out);
  near(matched, source - 3.01, 0.3, 'volumeに0.7071を掛けると -ac 2 と同じ');
});

test('音声のビットレート（--audio-bitrate）', () => {
  ff('-f', 'lavfi', '-i', 'anoisesrc=d=4:c=pink:a=0.5', '-ac', '2', path.join(dir, 'noise.wav'));
  const manifest = {composition: comp(120), layers: [{type: 'video', src: 'gray.png'}], audio: [{src: 'noise.wav'}]};
  const rate = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=bit_rate', '-of', 'csv=p=0', file], {encoding: 'utf8'}));
  const standard = rate(run(manifest).out), low = rate(run(manifest, ['--audio-bitrate', '64k']).out);
  assert.ok(standard > 150000 && low < 90000, `既定は192k、指定で64k: ${standard}, ${low}`);
  assert.equal(run(manifest, ['--audio-bitrate', 'takai'], {expectFail: true}).status, 2);
});

test('先頭・最後の1コマだけ違う絵（inspect --deep の edgeFrames）', () => {
  const make = (name, expr) => ff('-f', 'lavfi', '-i', `color=c=gray:s=64x64:r=${FPS}:d=1,format=yuv420p,geq=lum='${expr}':cb=128:cr=128`, '-c:v', 'libx264', '-qp', '0', path.join(dir, name));
  make('edge_last.mp4', 'if(eq(N,29),235,90)');
  make('edge_first.mp4', 'if(eq(N,0),235,90)');
  const last = JSON.parse(cli('inspect', path.join(dir, 'edge_last.mp4'), '--deep'));
  assert.deepEqual([last.suspectFrames, last.edgeFrames], [[], [29]]);
  assert.ok(last.warnings.some((w) => w.includes('29') && w.includes('確かめる')));
  assert.deepEqual(JSON.parse(cli('inspect', path.join(dir, 'edge_first.mp4'), '--deep')).edgeFrames, [0]);
  assert.deepEqual(JSON.parse(cli('inspect', path.join(dir, 'src.mp4'), '--deep')).edgeFrames, [], 'なめらかに変わる動画は挙げない');
  assert.deepEqual(JSON.parse(cli('inspect', path.join(dir, 'glitch.mp4'), '--deep')).edgeFrames, []);
});

test('ページ内スクリプトのシーンでも、ない素材は失敗、ページ内のエラーは注意', {skip: !chrome && 'Chromeがない'}, () => {
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
  assert.match(bad.stderr, /scene「pg」: 素材を読めません: .*nai_page\.png/);
  const messages = run(manifest, ['--allow-missing-assets'], {backend: 'browser'}).json.warnings.map((w) => w.message).join('\n');
  assert.match(messages, /nai_page\.png/);
  assert.match(messages, /ページ内でエラーが起きました: .*atokara/);
});
