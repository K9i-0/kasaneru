// 字幕をSRTにする（YouTubeの字幕などに使う）。
const stamp = (frame, fps) => {
  const ms = Math.round((frame / fps) * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

// items: [{from, to, text}]（startFrame / endFrame の名前でもよい）
export function toSrt(items, fps) {
  return items
    .map((c) => ({from: c.from ?? c.startFrame, to: c.to ?? c.endFrame, text: c.text}))
    .filter((c) => Number.isInteger(c.from) && Number.isInteger(c.to) && typeof c.text === 'string')
    .sort((a, b) => a.from - b.from)
    .map((c, i) => `${i + 1}\n${stamp(c.from, fps)} --> ${stamp(c.to, fps)}\n${c.text}\n`)
    .join('\n');
}

// manifestの中の字幕を集める。key（例: "props.captions"）を渡すとその場所から、なければ captions の層から。
export function collectCaptions(manifest, key) {
  if (key) {
    const value = key.split('.').reduce((o, k) => o?.[k], manifest);
    if (!Array.isArray(value)) throw new Error(`${key} に字幕の配列がありません`);
    return value;
  }
  return manifest.layers.filter((l) => l.builtin?.kind === 'captions').flatMap((l) => l.builtin.items);
}
