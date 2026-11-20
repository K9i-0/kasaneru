// 描画バックエンド（ブラウザ）: シーンが返すHTMLを、画面なしのChromeで透過PNGにする。
import {mkdirSync, writeFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {captionsScene} from '../captions.mjs';
import {launchBrowser} from './launch.mjs';
import {renderPageLayers} from './browser_page.mjs';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 画像の読み込みを待つ上限。超えたら、その画像は読めなかったものとして報告する。
const IMAGE_TIMEOUT_MS = Number(process.env.KASANERU_IMAGE_TIMEOUT_MS) || 30000;

export async function renderScenes({manifest, manifestDir, sceneLayers, workDir, everyFrame, concurrency, range}) {
  // 一部のコマだけ書き出すときは、その範囲の絵だけを描く。
  const [first, last] = range ?? [0, manifest.composition.durationInFrames - 1];
  const pageLayers = sceneLayers.filter((l) => l.page);
  sceneLayers = sceneLayers.filter((l) => !l.page);
  const {width, height, durationInFrames: N} = manifest.composition;
  const scenePath = path.resolve(manifestDir, manifest.scenes?.browser ?? 'scene.mjs');
  let mod = {scenes: {}};
  if (sceneLayers.some((l) => !l.builtin)) {
    // シーンは1ファイルにまとめてから読み込む（TypeScript・JSXを使え、どこに置いても 'kasaneru/anim' を読める）。
    const {build} = await import('esbuild');
    const modulePath = path.join(workDir, 'scene.bundle.mjs');
    await build({entryPoints: [scenePath], outfile: modulePath, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'error',
      alias: {'kasaneru/anim': path.join(PACKAGE_DIR, 'src/anim.mjs')},
      nodePaths: [path.join(PACKAGE_DIR, 'node_modules')],
      define: {'import.meta.url': JSON.stringify(pathToFileURL(scenePath).href), 'process.env.NODE_ENV': '"production"'},
      banner: {js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"}});
  mod = await import(pathToFileURL(modulePath).href);
  }
  const props = manifest.props ?? {};

  // manifestの fonts に書いたフォントファイルを読み込めるようにする（システムにないフォントを使うとき）。
  const fontFaces = (manifest.fonts ?? []).map((f) => `@font-face{font-family:${JSON.stringify(f.family)};src:url(${JSON.stringify(pathToFileURL(path.resolve(manifestDir, f.file)).href)});font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'}}`).join('');
  const pageFile = path.join(workDir, 'page.html');
  writeFileSync(pageFile, `<!doctype html><html><head><meta charset="utf-8"><base href="${pathToFileURL(path.dirname(scenePath)).href}/">
<style>${fontFaces}*{box-sizing:border-box}html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:transparent}#root{position:relative;width:100%;height:100%;overflow:hidden}${mod.css ?? ''}</style>
<script>
// HTMLを丸ごと差し替えると、同じ画像でも毎コマ読み直しになる。
// 前のコマと同じ構造の部分は残し、変わった属性と文字だけを書き換える。
function kasaneruMorph(parent, next) {
  const a = [...parent.childNodes], b = [...next.childNodes];
  if (a.length !== b.length) { parent.replaceChildren(...b); return; }
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) { parent.replaceChild(y, x); continue; }
    if (x.nodeType === 3) { if (x.data !== y.data) x.data = y.data; continue; }
    if (x.nodeType !== 1) continue;
    for (const at of [...x.attributes]) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
    for (const at of [...y.attributes]) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    kasaneruMorph(x, y);
  }
}
// フォントと画像の読み込みが終わってから撮る（描画前のページを撮らない）。
// 読めなかった画像（ファイルがない・壊れている・時間切れ）を返す。前のコマで失敗した画像も、残っている限り毎回挙げる。
// 一度時間切れした画像は、次のコマから待たない（毎コマ上限まで待つと、書き出しが終わらなくなる）。
const kasaneruTimedOut = new Set();
window.__kasaneruDraw = async (html, background, timeoutMs) => {
  document.body.style.background = background;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  kasaneruMorph(document.getElementById('root'), tpl.content);
  await document.fonts.ready;
  const images = [...document.images].filter((img) => img.getAttribute('src'));
  const pending = images.filter((img) => !img.complete && !kasaneruTimedOut.has(img.currentSrc || img.src));
  if (pending.length > 0) {
    let timer;
    await Promise.race([
      Promise.all(pending.map((img) => img.decode().catch(() => {}))),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
  }
  const failed = [];
  for (const img of images) {
    if (!img.complete) { kasaneruTimedOut.add(img.currentSrc || img.src); failed.push({url: img.currentSrc || img.src, reason: 'timeout'}); }
    else if (img.naturalWidth === 0) failed.push({url: img.currentSrc || img.src, reason: 'error'});
  }
  return failed;
};
</script>
</head><body><div id="root"></div></body></html>`);

  const jobs = [];
  const scenes = {};
  for (const layer of sceneLayers) {
    const scene = layer.builtin ? captionsScene(layer.builtin.items, layer.builtin.style, manifest.composition) : mod.scenes[layer.scene];
    if (!scene) throw new Error(`scene "${layer.scene}" is not defined in ${scenePath}`);
    const dir = path.join(workDir, layer.id);
    mkdirSync(dir, {recursive: true});
    // regionを指定した層は、その範囲だけを撮る（動く帯などを小さく描くため）。
    const clip = layer.region ?? null;
    // canvasを指定した層は、その大きさの画面に描く（横に長い帯など）。
    const canvas = layer.canvas ?? {width, height};
    // opaqueを指定した層は背景色ごと不透明に描き、JPEGで撮る（写真の多い画面はPNGの10倍速い）。
    const opaque = Boolean(layer.opaque);
    const ext = opaque ? 'jpg' : 'png';
    if (everyFrame) {
      for (let f = 0; f < N; f++) {
        const visible = !scene.key || scene.key(f, props) !== null;
        jobs.push({layer: layer.id, frame: f, clip, canvas, opaque, html: visible ? scene.render(f, props) : '', file: path.join(dir, `f${String(f).padStart(5, '0')}.${ext}`)});
      }
      scenes[layer.id] = {mode: 'sequence', pattern: path.join(dir, `f%05d.${ext}`), count: N};
    } else {
      // keyがないシーンは、描いたHTMLそのものをkeyにする（同じHTMLなら同じ絵）。
      // 同じkeyは離れたコマでも1回しか描かない（口の開閉のように同じ絵へ何度も戻る層のため）。
      const keyOf = scene.key ? (f) => scene.key(f, props) : (f) => scene.render(f, props) || null;
      const files = new Map();
      const segments = [];
      let start = first;
      let current = keyOf(first);
      for (let f = first + 1; f <= last + 1; f++) {
        const k = f <= last ? keyOf(f) : undefined;
        if (k === current) continue;
        if (current !== null && current !== undefined) {
          if (!files.has(current)) {
            const file = path.join(dir, `i${String(files.size).padStart(5, '0')}.${ext}`);
            files.set(current, file);
            jobs.push({layer: layer.id, frame: start, clip, canvas, opaque, html: scene.key ? scene.render(start, props) : current, file});
          }
          segments.push({start, end: f, file: files.get(current)});
        }
        start = f;
        current = k;
      }
      scenes[layer.id] = {mode: 'segments', segments, images: files.size};
    }
  }

  const tLaunch = performance.now();
  const browser = await launchBrowser();
  // 読めなかった素材を、URLごとに「最初に気づいた層とコマ・枚数」へまとめる。
  const missing = new Map();
  const noteMissing = (url, reason, job) => {
    if (!missing.has(url)) missing.set(url, {url, reason, layer: job?.layer ?? null, frame: job?.frame ?? null, jobs: new Set()});
    const hit = missing.get(url);
    hit.jobs.add(job);
    // 並列で描くので、気づいた順はコマの順と限らない。いちばん早いコマを残す。
    if (job && hit.layer === job.layer && job.frame < hit.frame) hit.frame = job.frame;
  };
  const warnings = [];
  let pageMissing = [];
  let tDraw = tLaunch, tEnd = tLaunch;
  let pageTimings = {};
  try {
    const context = await browser.newContext({viewport: {width, height}, deviceScaleFactor: 1});
    const background = manifest.background ?? '#000000';
    tDraw = performance.now();
    // 画面の大きさごとに専用のページを使う（途中で大きさを変えると、レイアウトが追いつく前に撮ってしまうことがある）。
    const groups = new Map();
    for (const job of jobs) {
      const k = `${job.canvas.width}x${job.canvas.height}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(job);
    }
    for (const group of groups.values()) {
      const size = group[0].canvas;
      const pages = await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, group.length))}, async () => {
        const page = await context.newPage();
        const state = {page, job: null};
        // <img> 以外（CSSの背景画像、SVGの <image>、フォントなど）の読み込み失敗も拾う。
        // 読み込みの途中で取り消されたもの（次のコマで要らなくなった、ページを閉じた）は、読めなかったわけではない。
        page.on('requestfailed', (req) => { if (!req.url().startsWith('data:') && !/ERR_ABORTED/.test(req.failure()?.errorText ?? '')) noteMissing(req.url(), 'error', state.job); });
        page.on('response', (res) => { if (res.status() >= 400) noteMissing(res.url(), 'error', state.job); });
        await page.setViewportSize(size);
        await page.goto(pathToFileURL(pageFile).href);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', {color: {r: 0, g: 0, b: 0, a: 0}});
        // 背景の指定を送ると画面の大きさの指定が外れることがあるので、大きさも直接指定し、実際の値を確かめる。
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false});
        const actual = await page.evaluate(() => [innerWidth, innerHeight]);
        if (actual[0] !== size.width || actual[1] !== size.height) throw new Error(`viewport is ${actual.join('x')}, expected ${size.width}x${size.height}`);
        state.cdp = cdp;
        return state;
      }));
      let cursor = 0;
      await Promise.all(pages.map(async (state) => {
        const {page, cdp} = state;
        while (cursor < group.length) {
          const job = group[cursor++];
          state.job = job;
          const failed = await page.evaluate(([html, bg, ms]) => window.__kasaneruDraw(html, bg, ms), [job.html, job.opaque ? background : 'transparent', IMAGE_TIMEOUT_MS]);
          for (const {url, reason} of failed) noteMissing(url, reason, job);
          // Playwrightのscreenshotより、ブラウザへ直接頼むほうが速い（PNGの圧縮を軽くでき、並列も効く）。
          const clip = {...(job.clip ?? {x: 0, y: 0, ...size}), scale: 1};
          const shot = await cdp.send('Page.captureScreenshot', job.opaque
            ? {format: 'jpeg', quality: 92, clip, captureBeyondViewport: false}
            : {format: 'png', optimizeForSpeed: true, clip, captureBeyondViewport: false});
          await writeFile(job.file, Buffer.from(shot.data, 'base64'));
        }
      }));
      await Promise.all(pages.map(({page}) => page.close()));
    }
    tEnd = performance.now();
    if (pageLayers.length > 0) {
      const result = await renderPageLayers({context, manifest, manifestDir, layers: pageLayers, workDir, concurrency, range: [first, last]});
      Object.assign(scenes, result.scenes);
      pageTimings = result.timings;
      pageMissing = result.missing;
      warnings.push(...result.warnings);
    }
  } finally {
    // 途中で失敗しても、Chromeを残さない。
    await browser.close();
  }
  const tClosed = performance.now();
  return {
    scenes,
    missing: [...missing.values()].map(({url, reason, layer, frame, jobs: {size: count}}) => ({
      where: layer === null ? 'scene' : `scene「${layer}」 コマ${frame}`,
      message: `${reason === 'timeout' ? `素材の読み込みが${IMAGE_TIMEOUT_MS / 1000}秒で終わりません` : '素材を読めません'}: ${url}${count > 1 ? `（${count}枚の絵で発生）` : ''}`,
    })).concat(pageMissing),
    warnings,
    timings: {
      backendStartup: +((tDraw - tLaunch) / 1000).toFixed(2),
      backendDraw: +((tEnd - tDraw) / 1000).toFixed(2),
      ...pageTimings,
    },
  };
}
