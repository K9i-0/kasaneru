// ページ内でスクリプトを動かして描くシーン（three.jsなどcanvasへ描くもの）。
// シーンは setup(ctx) を1回、draw(frame) をコマごとに呼ばれる。key(frame) があれば同じkeyのコマは1回だけ描く。
import {createReadStream, existsSync, mkdirSync, statSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.wav': 'audio/wav'};

// 素材（モデルや画像）をページから読めるよう、この書き出しの間だけ手元のファイルを127.0.0.1へ出す。
function serveLocalFiles(pageHtml, onMissing) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/page.html') { res.writeHead(200, {'content-type': 'text/html; charset=utf-8'}); res.end(pageHtml); return; }
    const file = pathname.startsWith('/@fs/') ? pathname.slice(4) : null;
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      // ない素材を黙って404にしない（favicon.icoなど、素材でないものは数えない）。
      if (file) onMissing(file);
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, {'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'content-length': statSync(file).size});
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({server, origin: `http://127.0.0.1:${server.address().port}`})));
}

export async function renderPageLayers({context, manifest, manifestDir, layers, workDir, concurrency, range}) {
  const [first, last] = range;
  const {width, height, fps, durationInFrames: N} = manifest.composition;
  const {build} = await import('esbuild');
  const bundle = path.join(workDir, 'page.bundle.js');
  await build({entryPoints: [path.resolve(manifestDir, manifest.scenes.page)], outfile: bundle, bundle: true, format: 'iife', globalName: '__kasaneruPage', platform: 'browser', logLevel: 'error',
    alias: {'kasaneru/anim': path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../anim.mjs')},
    // ツールの外にある共有コード（モーション部品など）からも、ツールに入っているthree等を使えるようにする。
    nodePaths: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules')]});
  const background = manifest.background ?? '#000000';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:transparent}#root{position:relative;width:100%;height:100%;overflow:hidden}</style></head><body><div id="root"></div></body></html>`;
  // 読めなかった素材と、ページ内で起きたエラー。呼び出し元へ返す。
  const missing = new Map();
  const warnings = [];
  let currentLayer = null;
  const {server, origin} = await serveLocalFiles(html, (file) => {
    if (!missing.has(file)) missing.set(file, {where: `scene「${currentLayer}」`, message: `素材を読めません: ${file}`});
  });
  const assets = `${origin}/@fs${path.resolve(manifestDir, manifest.assets ?? '.')}/`;
  const ctx = {width, height, fps, durationInFrames: N, props: manifest.props ?? {}, assets};
  const scenes = {};
  const timings = {setup: 0, draw: 0};
  try {
    for (const layer of layers) {
      currentLayer = layer.id;
      const dir = path.join(workDir, layer.id);
      mkdirSync(dir, {recursive: true});
      const ext = layer.opaque ? 'jpg' : 'png';
      const tSetup = performance.now();
      const pages = await Promise.all(Array.from({length: Math.max(1, concurrency)}, async () => {
        const page = await context.newPage();
        page.on('pageerror', (e) => {
          console.error(`[page] ${e.message}`);
          const message = `ページ内でエラーが起きました: ${e.message}`;
          if (!warnings.some((w) => w.message === message)) warnings.push({where: `scene「${layer.id}」`, message});
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setDefaultBackgroundColorOverride', {color: {r: 0, g: 0, b: 0, a: 0}});
        await cdp.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
        await page.goto(`${origin}/page.html`);
        await page.addScriptTag({path: bundle});
        await page.evaluate(async ([name, c, bg]) => {
          document.body.style.background = bg;
          await window.__kasaneruPage.scenes[name].setup(c);
        }, [layer.scene, ctx, layer.opaque ? background : 'transparent']);
        return {page, cdp};
      }));
      timings.setup += performance.now() - tSetup;
      const keys = await pages[0].page.evaluate(([name, n]) => {
        const scene = window.__kasaneruPage.scenes[name];
        return Array.from({length: n}, (_, f) => (scene.key ? scene.key(f) : `f${f}`));
      }, [layer.scene, N]);
      const files = new Map();
      const jobs = [];
      const segments = [];
      let start = first;
      for (let f = first + 1; f <= last + 1; f++) {
        if (f <= last && keys[f] === keys[start]) continue;
        const k = keys[start];
        if (k !== null) {
          if (!files.has(k)) {
            files.set(k, path.join(dir, `i${String(files.size).padStart(5, '0')}.${ext}`));
            jobs.push({frame: start, file: files.get(k)});
          }
          segments.push({start, end: f, file: files.get(k)});
        }
        start = f;
      }
      const tDraw = performance.now();
      let cursor = 0;
      const clip = {...(layer.region ?? {x: 0, y: 0, width, height}), scale: 1};
      await Promise.all(pages.map(async ({page, cdp}) => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++];
          await page.evaluate(([name, f]) => window.__kasaneruPage.scenes[name].draw(f), [layer.scene, job.frame]);
          const shot = await cdp.send('Page.captureScreenshot', layer.opaque
            ? {format: 'jpeg', quality: 92, clip, captureBeyondViewport: false}
            : {format: 'png', optimizeForSpeed: true, clip, captureBeyondViewport: false});
          await writeFile(job.file, Buffer.from(shot.data, 'base64'));
        }
      }));
      timings.draw += performance.now() - tDraw;
      await Promise.all(pages.map(({page}) => page.close()));
      scenes[layer.id] = {mode: 'segments', segments, images: files.size};
    }
  } finally {
    server.close();
  }
  return {scenes, missing: [...missing.values()], warnings, timings: {pageSetup: +(timings.setup / 1000).toFixed(2), pageDraw: +(timings.draw / 1000).toFixed(2)}};
}
