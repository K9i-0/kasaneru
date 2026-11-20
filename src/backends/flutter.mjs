// Rendering backend (Flutter): turns widgets into transparent PNGs inside `flutter test`. Uses neither a window nor a browser.
// Scenes are written in a Dart file on the project side (scenes.flutter in the manifest). The entry point that loads it is generated and run here.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../flutter_backend');

export async function renderScenes({manifest, manifestDir, sceneLayers, workDir, everyFrame, range}) {
  const scenePath = path.resolve(manifestDir, manifest.scenes.flutter);
  const [first, last] = range ?? [0, manifest.composition.durationInFrames - 1];
  const jobFile = path.join(workDir, 'flutter_job.json');
  const resultFile = path.join(workDir, 'flutter_result.json');
  writeFileSync(jobFile, JSON.stringify({
    width: manifest.composition.width,
    height: manifest.composition.height,
    frames: manifest.composition.durationInFrames,
    first, last,
    fonts: (manifest.fonts ?? []).map((f) => ({...f, file: path.resolve(manifestDir, f.file)})),
    layers: sceneLayers.map((l) => ({id: l.id, scene: l.scene, region: l.region ?? null, canvas: l.canvas ?? null})),
    props: manifest.props ?? {},
    everyFrame,
    workDir,
    resultFile,
  }));
  // Make one entry point per project (the same project gets the same name, so from the second run on the compiled result is reused).
  const entryDir = path.join(packageDir, 'test', 'generated');
  mkdirSync(entryDir, {recursive: true});
  const entry = path.join(entryDir, `${createHash('sha1').update(scenePath).digest('hex').slice(0, 12)}_test.dart`);
  writeFileSync(entry, `// Generated. Entry point that loads the scenes in ${scenePath}.
import 'package:kasaneru_flutter/runner.dart';

import '${pathToFileURL(scenePath).href}' as project;

void main() => runKasaneruJob(project.scenes);
`);
  const t0 = performance.now();
  try {
    await new Promise((resolve, reject) => {
      const p = spawn('flutter', ['test', path.relative(packageDir, entry), '--reporter', 'failures-only'], {
        cwd: packageDir,
        env: {...process.env, KASANERU_JOB: jobFile},
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`flutter test exited with ${code}`))));
    });
  } finally {
    rmSync(entry, {force: true});
  }
  const total = (performance.now() - t0) / 1000;
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  return {
    scenes: result.scenes,
    timings: {
      backendStartup: +(total - result.drawSeconds).toFixed(2),
      backendDraw: +result.drawSeconds.toFixed(2),
    },
  };
}
