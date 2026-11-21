// Rendering backend (browser): turns the HTML returned by scenes into transparent PNGs with headless Chrome.
import {mkdirSync, writeFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {captionsScene} from '../captions.mjs';
import {DEPENDENCY_PATHS, PACKAGE_DIR} from './deps.mjs';
import {launchBrowser} from './launch.mjs';
import {renderPageLayers} from './browser_page.mjs';

// Upper limit for waiting on an image to load. Past it, the image is reported as one that could not be loaded.
const IMAGE_TIMEOUT_MS = Number(process.env.KASANERU_IMAGE_TIMEOUT_MS) || 30000;

export async function renderScenes({manifest, manifestDir, sceneLayers, workDir, everyFrame, concurrency, range}) {
  // When rendering only part of the frames, draw only the pictures in that range.
  const [first, last] = range ?? [0, manifest.composition.durationInFrames - 1];
  const pageLayers = sceneLayers.filter((l) => l.page);
  sceneLayers = sceneLayers.filter((l) => !l.page);
  const {width, height, durationInFrames: N} = manifest.composition;
  const scenePath = path.resolve(manifestDir, manifest.scenes?.browser ?? 'scene.mjs');
  let mod = {scenes: {}};
  if (sceneLayers.some((l) => !l.builtin)) {
    // Bundle the scene into one file before loading it (so TypeScript and JSX work, and 'kasaneru/anim' can be imported wherever the scene lives).
    const {build} = await import('esbuild');
    const modulePath = path.join(workDir, 'scene.bundle.mjs');
    await build({entryPoints: [scenePath], outfile: modulePath, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'error',
      alias: {'kasaneru/anim': path.join(PACKAGE_DIR, 'src/anim.mjs')},
      nodePaths: DEPENDENCY_PATHS,
      define: {'import.meta.url': JSON.stringify(pathToFileURL(scenePath).href), 'process.env.NODE_ENV': '"production"'},
      banner: {js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"}});
  mod = await import(pathToFileURL(modulePath).href);
  }
  const props = manifest.props ?? {};

  // Make the font files listed under fonts in the manifest loadable (for fonts not installed on the system).
  const fontFaces = (manifest.fonts ?? []).map((f) => `@font-face{font-family:${JSON.stringify(f.family)};src:url(${JSON.stringify(pathToFileURL(path.resolve(manifestDir, f.file)).href)});font-weight:${f.weight ?? 'normal'};font-style:${f.style ?? 'normal'}}`).join('');
  const pageFile = path.join(workDir, 'page.html');
  writeFileSync(pageFile, `<!doctype html><html><head><meta charset="utf-8"><base href="${pathToFileURL(path.dirname(scenePath)).href}/">
<style>${fontFaces}*{box-sizing:border-box}html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:transparent}#root{position:relative;width:100%;height:100%;overflow:hidden}${mod.css ?? ''}</style>
<script>
// Replacing the whole HTML would reload the same images on every frame.
// Keep the parts whose structure matches the previous frame, and rewrite only the attributes and text that changed.
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
// Capture after fonts and images have finished loading (do not capture a page that has not been drawn yet).
// Returns the images that could not be loaded (file does not exist, is corrupt, or timed out). An image that failed on an earlier frame is listed every time for as long as it stays in the page.
// Once an image has timed out, later frames do not wait for it again (waiting up to the limit on every frame would keep the render from ever finishing).
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
    // A layer with region captures only that area (to draw a moving bar or similar at a small size).
    const clip = layer.region ?? null;
    // A layer with canvas is drawn on a screen of that size (a horizontally long bar, for example).
    const canvas = layer.canvas ?? {width, height};
    // A layer with opaque is drawn opaque, background color included, and captured as JPEG (10x faster than PNG for photo-heavy screens).
    const opaque = Boolean(layer.opaque);
    const ext = opaque ? 'jpg' : 'png';
    if (everyFrame) {
      for (let f = 0; f < N; f++) {
        const visible = !scene.key || scene.key(f, props) !== null;
        jobs.push({layer: layer.id, frame: f, clip, canvas, opaque, html: visible ? scene.render(f, props) : '', file: path.join(dir, `f${String(f).padStart(5, '0')}.${ext}`)});
      }
      scenes[layer.id] = {mode: 'sequence', pattern: path.join(dir, `f%05d.${ext}`), count: N};
    } else {
      // A scene without key uses the drawn HTML itself as the key (the same HTML is the same picture).
      // The same key is drawn only once even across distant frames (for layers that keep returning to the same picture, such as a mouth opening and closing).
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
  // Group the assets that could not be loaded by URL, as "the layer and frame where it was first noticed, and the number of pictures".
  const missing = new Map();
  const noteMissing = (url, reason, job) => {
    if (!missing.has(url)) missing.set(url, {url, reason, layer: job?.layer ?? null, frame: job?.frame ?? null, jobs: new Set()});
    const hit = missing.get(url);
    hit.jobs.add(job);
    // Drawing runs in parallel, so the order of noticing is not necessarily frame order. Keep the earliest frame.
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
    // Use a dedicated page per screen size (changing the size partway can lead to capturing before layout has caught up).
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
        // Also pick up load failures for things other than <img> (CSS background images, SVG <image>, fonts, and so on).
        // A load cancelled partway (no longer needed in the next frame, or the page was closed) is not a failure to load.
        page.on('requestfailed', (req) => { if (!req.url().startsWith('data:') && !/ERR_ABORTED/.test(req.failure()?.errorText ?? '')) noteMissing(req.url(), 'error', state.job); });
        page.on('response', (res) => { if (res.status() >= 400) noteMissing(res.url(), 'error', state.job); });
        await page.setViewportSize(size);
        await page.goto(pathToFileURL(pageFile).href);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', {color: {r: 0, g: 0, b: 0, a: 0}});
        // Sending the background override can drop the screen size override, so set the size directly as well and check the actual value.
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
          // Asking the browser directly is faster than the Playwright screenshot (PNG compression can be made lighter, and parallelism helps).
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
    // Do not leave Chrome running even if something fails partway.
    await browser.close();
  }
  const tClosed = performance.now();
  return {
    scenes,
    missing: [...missing.values()].map(({url, reason, layer, frame, jobs: {size: count}}) => ({
      where: layer === null ? 'scene' : `scene "${layer}" frame ${frame}`,
      message: `${reason === 'timeout' ? `Asset did not finish loading within ${IMAGE_TIMEOUT_MS / 1000} seconds` : 'Cannot load asset'}: ${url}${count > 1 ? ` (in ${count} pictures)` : ''}`,
    })).concat(pageMissing),
    warnings,
    timings: {
      backendStartup: +((tDraw - tLaunch) / 1000).toFixed(2),
      backendDraw: +((tEnd - tDraw) / 1000).toFixed(2),
      ...pageTimings,
    },
  };
}
