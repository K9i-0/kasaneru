// 字幕の層（type: "captions"）。シーンを書かなくても、字幕ファイルか項目の一覧から字幕を重ねられる。
import path from 'node:path';
import {readSubtitles, toFrames} from './subtitles.mjs';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
export const CAPTION_STYLE = ['fontFamily', 'fontSize', 'fontWeight', 'color', 'strokeColor', 'strokeWidth', 'lineHeight', 'letterSpacing', 'align',
  'left', 'right', 'top', 'bottom', 'background', 'padding', 'borderRadius', 'shadow'];

export function captionItems(layer, manifestDir, fps) {
  if (layer.items) return layer.items;
  return toFrames(readSubtitles(path.resolve(manifestDir, layer.src)), fps);
}

// 字幕の層を、ブラウザで描く組み込みのシーンにする。
export function captionsScene(items, style = {}, {width, height}) {
  const fontSize = style.fontSize ?? Math.round(Math.min(width, height) * 0.055);
  const stroke = style.strokeWidth ?? Math.round(fontSize * 0.14);
  const box = [
    'position:absolute', `left:${style.left ?? Math.round(width * 0.06)}px`, `right:${style.right ?? Math.round(width * 0.06)}px`,
    style.top !== undefined ? `top:${style.top}px` : `bottom:${style.bottom ?? Math.round(height * 0.08)}px`,
    `text-align:${style.align ?? 'center'}`,
  ].join(';');
  const text = [
    'display:inline-block', 'white-space:pre-line', 'line-break:strict',
    `font-family:${style.fontFamily ?? 'system-ui,"Hiragino Sans","Noto Sans CJK JP","Yu Gothic",sans-serif'}`,
    `font-size:${fontSize}px`, `font-weight:${style.fontWeight ?? 700}`, `line-height:${style.lineHeight ?? 1.35}`,
    `letter-spacing:${style.letterSpacing ?? 0}px`, `color:${style.color ?? '#ffffff'}`,
    ...(stroke > 0 ? [`-webkit-text-stroke:${stroke}px ${style.strokeColor ?? '#000000'}`, 'paint-order:stroke fill'] : []),
    ...(style.shadow ? [`text-shadow:${style.shadow}`] : []),
    ...(style.background ? [`background:${style.background}`, `padding:${style.padding ?? '0.2em 0.6em'}`, `border-radius:${style.borderRadius ?? 6}px`] : []),
  ].join(';');
  const at = (frame) => items.findIndex((c) => frame >= c.from && frame < c.to);
  return {
    key: (frame) => { const i = at(frame); return i < 0 ? null : `c${i}`; },
    render: (frame) => `<div style="${esc(box)}"><span style="${esc(text)}">${esc(items[at(frame)].text)}</span></div>`,
  };
}

// manifestの captions 層を、描画バックエンドが扱える形（組み込みシーンを持つ scene 層）に置き換える。
export function expandCaptions(manifest, manifestDir) {
  let n = 0;
  const layers = manifest.layers.map((layer) => {
    if (layer.type !== 'captions') return layer;
    const id = layer.id ?? `captions${++n}`;
    return {type: 'scene', id, scene: `builtin:captions:${id}`, builtin: {kind: 'captions', items: captionItems(layer, manifestDir, manifest.composition.fps), style: layer.style ?? {}}};
  });
  return {...manifest, layers};
}
