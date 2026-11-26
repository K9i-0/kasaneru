#!/usr/bin/env node
// kasaneru: renders a video from a manifest.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
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
  kasaneru --help | --version
  kasaneru render <manifest.json> -o <out.mp4|.mov|.webm|.gif>   Render
        [--backend browser|flutter|none] [--frames A-B] [--concurrency N] [--props <file|json>] [--set a.b=value]...
        [--encoder libx264|h264_videotoolbox] [--crf N] [--audio-bitrate 192k] [--every-frame] [--keep-work] [--work <dir>]
        [--allow-missing-assets]
  kasaneru still <manifest.json> --frame N -o <out.png>          Render a single frame
  kasaneru check <manifest.json>                                 List the errors in the manifest (without rendering)
  kasaneru inspect <video> [--deep]                              Inspect a rendered video (--deep also looks for broken frames)
  kasaneru sheet <video> -o <sheet.png>                          Make a contact sheet of frames for review
        [--frames 0,120,240 | --every N | --manifest <manifest.json>] [--cols N]
  kasaneru srt <manifest.json> -o <out.srt> [--key props.captions]   Write the captions as SRT
  kasaneru captions <file.srt|.ass> --fps N                      Convert a subtitle file to JSON [{from, to, text}]
  kasaneru probe <file> [--fps N]                                Report the length and dimensions of an asset
  kasaneru envelope <audio> --fps N                              Output the per-frame volume as JSON (for lip sync)`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      help: {type: 'boolean', short: 'h', default: false},
      version: {type: 'boolean', short: 'v', default: false},
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
} catch (e) {
  // An unknown option or a missing value: say which, then show the usage (not a stack trace).
  console.error(`${e.message}\n\n${USAGE}`);
  process.exit(2);
}
const {values: opt, positionals} = parsed;
if (opt.help) { console.log(USAGE); process.exit(0); }
if (opt.version) {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  process.exit(0);
}
const [command, target] = positionals;
const fail = (message, code = 2) => { console.error(message); process.exit(code); };
const print = (value) => console.log(JSON.stringify(value, null, 2));
const COMMANDS = ['render', 'still', 'check', 'inspect', 'sheet', 'srt', 'captions', 'probe', 'envelope'];
if (!COMMANDS.includes(command) || !target) fail(USAGE);
if (!['browser', 'flutter', 'none'].includes(opt.backend)) fail('--backend must be one of browser / flutter / none');
const needFps = () => { const fps = Number(opt.fps); if (!(fps > 0)) fail('--fps is required: pass the fps of the composition'); return fps; };
// Options that take a number: say which one is wrong here instead of letting ffmpeg or the backend fail on it later.
const needNumber = (name, {integer = false, min = 0, max = Infinity} = {}) => {
  if (opt[name] === undefined) return undefined;
  const v = Number(opt[name]);
  if (opt[name].trim() === '' || !Number.isFinite(v) || (integer && !Number.isInteger(v)) || v < min || v > max) {
    fail(`--${name} must be ${integer ? 'an integer' : 'a number'} ${max === Infinity ? `of ${min} or more` : `from ${min} to ${max}`}: ${opt[name]}`);
  }
  return v;
};
const concurrency = needNumber('concurrency', {integer: true, min: 1});
const crf = needNumber('crf', {min: 0, max: 51});
const cols = needNumber('cols', {integer: true, min: 1});
const every = needNumber('every', {integer: true, min: 1});
// Everything except reading a subtitle file runs ffmpeg or ffprobe. Without them, say so (not a spawn ENOENT stack trace).
if (command !== 'captions') {
  const absent = ['ffmpeg', 'ffprobe'].filter((tool) => spawnSync(tool, ['-version'], {stdio: 'ignore'}).error);
  if (absent.length > 0) fail(`${absent.join(' and ')} not found. Install ffmpeg (it includes ffprobe) and make sure it is on the PATH.`, 1);
}
const needFile = (p) => { const full = path.resolve(p); if (!existsSync(full)) fail(`File not found: ${full}`, 1); return full; };

// Read the manifest, apply the props overrides (--props / --set), and validate it.
function loadManifest(file) {
  const manifestPath = needFile(file);
  const manifestDir = path.dirname(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`Cannot read the manifest: ${manifestPath}\n${e.message}`);
  }
  if (opt.props) {
    // Make variants from the same manifest (different wording, different framing, and so on).
    const text = existsSync(opt.props) ? readFileSync(opt.props, 'utf8') : opt.props;
    try { manifest.props = merge(manifest.props ?? {}, JSON.parse(text)); } catch (e) { fail(`Cannot read --props: ${e.message}`); }
  }
  for (const pair of opt.set ?? []) {
    const eq = pair.indexOf('=');
    if (eq < 1) fail(`--set takes path=value (example: --set title=Hello): ${pair}`);
    const keys = pair.slice(0, eq).split('.');
    let value = pair.slice(eq + 1);
    try { value = JSON.parse(value); } catch { /* use it as a string */ }
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
// Resolve omissions and shorthands (sequencing, automatic length calculation, ducking) into concrete values, and replace captions layers with the built-in scene.
function prepare({manifest, manifestDir, problems}) {
  if (problems.errors.length > 0) {
    console.error(formatProblems(problems));
    fail(`The manifest has ${problems.errors.length} error(s). Fix them and try again.`, 1);
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
  if (opt.frames) {
    if (!/^\d+(,\d+)*$/.test(opt.frames)) fail(`--frames takes frame numbers separated by commas (example: 0,120,240): ${opt.frames}`);
    frames = opt.frames.split(',').map(Number);
  }
  else if (opt.manifest) frames = boundaryFrames(prepare(loadManifest(opt.manifest)));
  else {
    const step = every ?? Math.max(1, Math.floor(total / 12));
    frames = Array.from({length: Math.ceil(total / step)}, (_, i) => i * step);
  }
  frames = [...new Set(frames.filter((f) => Number.isInteger(f) && f >= 0 && f < total))].sort((a, b) => a - b);
  mkdirSync(path.dirname(path.resolve(opt.out)), {recursive: true});
  print(contactSheet(video, frames, path.resolve(opt.out), {cols}));
  process.exit(0);
}

const loaded = loadManifest(target);
if (command === 'check') {
  const {problems} = loaded;
  if (problems.errors.length === 0) {
    // Even a well-formed manifest can fail to resolve, for example when the length of an asset cannot be read.
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
  if (items.length === 0) fail('No captions found. If there is no captions layer, point at their location, as in --key props.captions', 1);
  writeFileSync(path.resolve(opt.out), toSrt(items, manifest.composition.fps));
  print({out: path.resolve(opt.out), captions: items.length});
  process.exit(0);
}

const N = manifest.composition.durationInFrames;
const still = command === 'still';
let range = null;
if (still) {
  const f = Number(opt.frame);
  if (!Number.isInteger(f) || f < 0 || f >= N) fail(`--frame must be an integer from 0 to ${N - 1}`);
  range = [f, f];
} else if (opt.frames) {
  const m = /^(\d+)-(\d+)$/.exec(opt.frames);
  if (!m || Number(m[1]) > Number(m[2]) || Number(m[2]) >= N) fail(`--frames takes A-B (0 to ${N - 1}, A <= B)`);
  range = [Number(m[1]), Number(m[2])];
}
if (!opt.out) fail(USAGE);
const out = path.resolve(opt.out);
const format = still ? 'png' : path.extname(out).slice(1).toLowerCase();
if (!still && !['mp4', 'mov', 'webm', 'gif'].includes(format)) fail('The output must be one of .mp4 / .mov / .webm / .gif');
if (opt['audio-bitrate'] !== undefined && !/^\d+(\.\d+)?[kM]?$/.test(opt['audio-bitrate'])) fail('--audio-bitrate is written like 192k or 256000');

// The working folder is emptied before the render and deleted after it, so only ever use a folder kasaneru made itself
// (it leaves a marker file in it) or an empty one. Never delete a folder that already holds someone's files.
const workDir = path.resolve(opt.work ?? out.replace(/\.[^.]+$/, '') + '.work');
const WORK_MARKER = '.kasaneru-work';
if (existsSync(workDir)) {
  const ours = statSync(workDir).isDirectory() && (existsSync(path.join(workDir, WORK_MARKER)) || readdirSync(workDir).length === 0);
  if (!ours) {
    fail(`The working folder already exists and was not made by kasaneru, so it is left alone: ${workDir}\n`
      + `kasaneru deletes its working folder. ${opt.work ? 'Pass a new or empty folder to --work.' : 'Pass --work <dir> with a new or empty folder, or move that folder away.'}`, 1);
  }
  rmSync(workDir, {recursive: true, force: true});
}
mkdirSync(workDir, {recursive: true});
writeFileSync(path.join(workDir, WORK_MARKER), '');
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
    concurrency,
  });
  scenes = result.scenes;
  backendTimings = result.timings;
  problems.warnings.push(...(result.warnings ?? []));
  // If an image could not be loaded, the video would be finished with part of the picture missing. By default, do not render.
  const missing = result.missing ?? [];
  if (missing.length > 0 && !opt['allow-missing-assets']) {
    console.error(formatProblems({errors: missing, warnings: []}));
    if (!opt['keep-work']) rmSync(workDir, {recursive: true, force: true});
    fail(`${missing.length} scene asset(s) could not be loaded. Fix the paths and try again (or pass --allow-missing-assets to render anyway).`, 1);
  }
  problems.warnings.push(...missing);
}
const t1 = performance.now();
const args = buildFfmpegArgs({manifest, manifestDir, scenes, out, encoder: opt.encoder, crf, audioBitrate: opt['audio-bitrate'], workDir, range, still, format});
try {
  await runFfmpeg(args);
} catch (e) {
  // ffmpeg has already printed what went wrong. The working folder is kept so that the filter can be looked at.
  fail(`${e.message}\nThe working folder was kept: ${workDir}`, 1);
}
const t2 = performance.now();
// Delete the working folder unless it is wanted for inspection (--keep-work).
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
