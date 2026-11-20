#!/usr/bin/env node
// kasaneru: manifestから動画を書き出す。
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {expandCaptions} from '../src/captions.mjs';
import {buildFfmpegArgs, runFfmpeg} from '../src/ffmpeg.mjs';
import {inspectVideo} from '../src/inspect.mjs';
import {envelope, probeMedia} from '../src/media.mjs';
import {resolveManifest} from '../src/resolve.mjs';
import {boundaryFrames, contactSheet} from '../src/sheet.mjs';
import {collectCaptions, toSrt} from '../src/srt.mjs';
import {readSubtitles, toFrames} from '../src/subtitles.mjs';
import {formatProblems, validateManifest} from '../src/validate.mjs';

const USAGE = `usage:
  kasaneru render <manifest.json> -o <out.mp4|.mov|.webm|.gif>   書き出す
        [--backend browser|flutter|none] [--frames A-B] [--concurrency N] [--props <file|json>] [--set a.b=値]...
        [--encoder libx264|h264_videotoolbox] [--crf N] [--audio-bitrate 192k] [--every-frame] [--keep-work]
        [--allow-missing-assets]
  kasaneru still <manifest.json> --frame N -o <out.png>          1コマだけ書き出す
  kasaneru check <manifest.json>                                 manifestの誤りを調べる（書き出さない）
  kasaneru inspect <video> [--deep]                              書き出した動画を点検する（--deep は壊れたコマも探す）
  kasaneru sheet <video> -o <sheet.png>                          確認用のコマ一覧を作る
        [--frames 0,120,240 | --every N | --manifest <manifest.json>] [--cols N]
  kasaneru srt <manifest.json> -o <out.srt> [--key props.captions]   字幕をSRTにする
  kasaneru captions <file.srt|.ass> --fps N                      字幕ファイルを [{from, to, text}] のJSONにする
  kasaneru probe <file> [--fps N]                                素材の長さ・大きさを調べる
  kasaneru envelope <audio> --fps N                              コマごとの音量（口パク用）をJSONにする`;

const {values: opt, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    out: {type: 'string', short: 'o'},
    backend: {type: 'string', default: 'browser'},
    'every-frame': {type: 'boolean', default: false},
    concurrency: {type: 'string', default: '4'},
    encoder: {type: 'string', default: 'libx264'},
    crf: {type: 'string', default: '18'},
    'audio-bitrate': {type: 'string'},
    'allow-missing-assets': {type: 'boolean', default: false},
    work: {type: 'string'},
    frames: {type: 'string'},
    frame: {type: 'string'},
    'keep-work': {type: 'boolean', default: false},
    fps: {type: 'string'},
    props: {type: 'string'},
    set: {type: 'string', multiple: true},
    deep: {type: 'boolean', default: false},
    every: {type: 'string'},
    manifest: {type: 'string'},
    cols: {type: 'string', default: '4'},
    key: {type: 'string'},
  },
});
const [command, target] = positionals;
const fail = (message, code = 2) => { console.error(message); process.exit(code); };
const print = (value) => console.log(JSON.stringify(value, null, 2));
const COMMANDS = ['render', 'still', 'check', 'inspect', 'sheet', 'srt', 'captions', 'probe', 'envelope'];
if (!COMMANDS.includes(command) || !target) fail(USAGE);
if (!['browser', 'flutter', 'none'].includes(opt.backend)) fail('--backend は browser / flutter / none のどれかです');
const needFps = () => { const fps = Number(opt.fps); if (!(fps > 0)) fail('--fps にコンポジションのfpsを指定します'); return fps; };
const needFile = (p) => { const full = path.resolve(p); if (!existsSync(full)) fail(`ファイルがありません: ${full}`, 1); return full; };

// manifestを読み、props の差し替え（--props / --set）を当てて、検証する。
function loadManifest(file) {
  const manifestPath = needFile(file);
  const manifestDir = path.dirname(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`manifestを読めません: ${manifestPath}\n${e.message}`);
  }
  if (opt.props) {
    // 同じmanifestから変種を作る（文言違い・画角違いなど）。
    const text = existsSync(opt.props) ? readFileSync(opt.props, 'utf8') : opt.props;
    try { manifest.props = merge(manifest.props ?? {}, JSON.parse(text)); } catch (e) { fail(`--props を読めません: ${e.message}`); }
  }
  for (const pair of opt.set ?? []) {
    const eq = pair.indexOf('=');
    if (eq < 1) fail(`--set は 場所=値 で書きます（例: --set title=こんにちは）: ${pair}`);
    const keys = pair.slice(0, eq).split('.');
    let value = pair.slice(eq + 1);
    try { value = JSON.parse(value); } catch { /* 文字列のまま使う */ }
    let node = (manifest.props ??= {});
    for (const k of keys.slice(0, -1)) node = (node[k] ??= {});
    node[keys[keys.length - 1]] = value;
  }
  const problems = validateManifest(manifest, manifestDir, {backend: opt.backend});
  return {manifest, manifestDir, problems};
}
function merge(a, b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b) || a === null || typeof a !== 'object' || Array.isArray(a)) return b;
  const out = {...a};
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? merge(a[k], v) : v;
  return out;
}
// 省略や便利な書き方（順に並べる・長さの自動計算・ダッキング）を具体的な値にし、字幕の層を組み込みのシーンに置き換える。
function prepare({manifest, manifestDir, problems}) {
  if (problems.errors.length > 0) {
    console.error(formatProblems(problems));
    fail(`manifestに誤りが ${problems.errors.length} 件あります。直してからやり直してください。`, 1);
  }
  try {
    return expandCaptions(resolveManifest(manifest, manifestDir), manifestDir);
  } catch (e) {
    return fail(e.message, 1);
  }
}

if (command === 'inspect') { print(inspectVideo(needFile(target), {deep: opt.deep})); process.exit(0); }
if (command === 'captions') { print(toFrames(readSubtitles(needFile(target)), needFps())); process.exit(0); }
if (command === 'probe') { print(probeMedia(needFile(target), opt.fps ? needFps() : undefined)); process.exit(0); }
if (command === 'envelope') { console.log(JSON.stringify(envelope(needFile(target), needFps()))); process.exit(0); }

if (command === 'sheet') {
  if (!opt.out) fail(USAGE);
  const video = needFile(target);
  const total = inspectVideo(video).video.frames;
  let frames;
  if (opt.frames) frames = opt.frames.split(',').map(Number);
  else if (opt.manifest) frames = boundaryFrames(prepare(loadManifest(opt.manifest)));
  else {
    const step = Number(opt.every) > 0 ? Number(opt.every) : Math.max(1, Math.floor(total / 12));
    frames = Array.from({length: Math.ceil(total / step)}, (_, i) => i * step);
  }
  frames = [...new Set(frames.filter((f) => Number.isInteger(f) && f >= 0 && f < total))].sort((a, b) => a - b);
  mkdirSync(path.dirname(path.resolve(opt.out)), {recursive: true});
  print(contactSheet(video, frames, path.resolve(opt.out), {cols: Number(opt.cols)}));
  process.exit(0);
}

const loaded = loadManifest(target);
if (command === 'check') {
  const {problems} = loaded;
  if (problems.errors.length === 0) {
    // 書き方は正しくても、素材の長さが読めないなどで具体化に失敗することがある。
    try { resolveManifest(loaded.manifest, loaded.manifestDir); } catch (e) { problems.errors.push({where: 'manifest', message: e.message}); }
  }
  print({ok: problems.errors.length === 0, ...problems});
  process.exit(problems.errors.length === 0 ? 0 : 1);
}
if (loaded.problems.warnings.length > 0 && loaded.problems.errors.length === 0) console.error(formatProblems(loaded.problems));
const manifest = prepare(loaded);
const {manifestDir, problems} = loaded;

if (command === 'srt') {
  if (!opt.out) fail(USAGE);
  const items = collectCaptions(manifest, opt.key);
  if (items.length === 0) fail('字幕が見つかりません。captions の層がないときは --key props.captions のように場所を指定します', 1);
  writeFileSync(path.resolve(opt.out), toSrt(items, manifest.composition.fps));
  print({out: path.resolve(opt.out), captions: items.length});
  process.exit(0);
}

const N = manifest.composition.durationInFrames;
const still = command === 'still';
let range = null;
if (still) {
  const f = Number(opt.frame);
  if (!Number.isInteger(f) || f < 0 || f >= N) fail(`--frame は 0〜${N - 1} の整数で指定します`);
  range = [f, f];
} else if (opt.frames) {
  const m = /^(\d+)-(\d+)$/.exec(opt.frames);
  if (!m || Number(m[1]) > Number(m[2]) || Number(m[2]) >= N) fail(`--frames は A-B（0〜${N - 1}、A≦B）で指定します`);
  range = [Number(m[1]), Number(m[2])];
}
if (!opt.out) fail(USAGE);
const out = path.resolve(opt.out);
const format = still ? 'png' : path.extname(out).slice(1).toLowerCase();
if (!still && !['mp4', 'mov', 'webm', 'gif'].includes(format)) fail('出力は .mp4 / .mov / .webm / .gif のどれかです');
if (opt['audio-bitrate'] !== undefined && !/^\d+(\.\d+)?[kM]?$/.test(opt['audio-bitrate'])) fail('--audio-bitrate は 192k や 256000 のように書きます');

const workDir = path.resolve(opt.work ?? out.replace(/\.[^.]+$/, '') + '.work');
rmSync(workDir, {recursive: true, force: true});
mkdirSync(workDir, {recursive: true});
mkdirSync(path.dirname(out), {recursive: true});

const t0 = performance.now();
const sceneLayers = manifest.layers.filter((l) => l.type === 'scene');
let scenes = {};
let backendTimings = {};
if (opt.backend !== 'none' && sceneLayers.length > 0) {
  const backend = await import(`../src/backends/${opt.backend}.mjs`);
  const result = await backend.renderScenes({
    manifest, manifestDir, sceneLayers, workDir, range,
    everyFrame: opt['every-frame'],
    concurrency: Number(opt.concurrency),
  });
  scenes = result.scenes;
  backendTimings = result.timings;
  problems.warnings.push(...(result.warnings ?? []));
  // 読めなかった画像があると、絵が欠けたまま完成してしまう。既定では書き出さない。
  const missing = result.missing ?? [];
  if (missing.length > 0 && !opt['allow-missing-assets']) {
    console.error(formatProblems({errors: missing, warnings: []}));
    if (!opt['keep-work']) rmSync(workDir, {recursive: true, force: true});
    fail(`シーンの素材を ${missing.length} 件読めませんでした。パスを直してからやり直してください（欠けたまま書き出すなら --allow-missing-assets）。`, 1);
  }
  problems.warnings.push(...missing);
}
const t1 = performance.now();
const args = buildFfmpegArgs({manifest, manifestDir, scenes, out, encoder: opt.encoder, crf: opt.crf, audioBitrate: opt['audio-bitrate'], workDir, range, still, format});
await runFfmpeg(args);
const t2 = performance.now();
// 作業用フォルダは、調べたいとき（--keep-work）以外は消す。
if (!opt['keep-work']) rmSync(workDir, {recursive: true, force: true});

const images = Object.values(scenes).reduce((n, s) => n + (s.mode === 'sequence' ? s.count : s.images ?? s.segments.length), 0);
print({
  out,
  backend: opt.backend,
  frames: range ? range[1] - range[0] + 1 : N,
  imagesDrawn: images,
  warnings: problems.warnings,
  seconds: {
    scenes: +((t1 - t0) / 1000).toFixed(2),
    ...backendTimings,
    ffmpeg: +((t2 - t1) / 1000).toFixed(2),
    total: +((t2 - t0) / 1000).toFixed(2),
  },
});
