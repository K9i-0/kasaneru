// 字幕ファイル（SRT・ASS/SSA）を読む。時刻は秒で返し、toFrames でコマ数にする。
import {readFileSync} from 'node:fs';
import path from 'node:path';

const clock = (h, m, s, frac, digits) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(frac) / 10 ** digits;
const stripTags = (text) => text.replace(/\{\\[^}]*\}/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '');

export function parseSrt(text) {
  const items = [];
  for (const block of text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l, i) => !(i === 0 && /^\d+$/.test(l.trim())));
    const m = /(\d+):(\d+):(\d+)[,.](\d{1,3})\s*-->\s*(\d+):(\d+):(\d+)[,.](\d{1,3})/.exec(lines[0] ?? '');
    if (!m) continue;
    const body = stripTags(lines.slice(1).join('\n')).trim();
    if (body) items.push({start: clock(m[1], m[2], m[3], m[4], m[4].length), end: clock(m[5], m[6], m[7], m[8], m[8].length), text: body});
  }
  return items;
}

export function parseAss(text) {
  const items = [];
  let format = null;
  let inEvents = false;
  for (const raw of text.replace(/^﻿/, '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue; }
    if (!inEvents) continue;
    if (/^format:/i.test(line)) { format = line.slice(7).split(',').map((s) => s.trim().toLowerCase()); continue; }
    if (!/^dialogue:/i.test(line) || !format) continue;
    // 最後の項目（Text）にはカンマが入るので、項目数-1回だけ区切る。
    const parts = line.slice(9).trim().split(',');
    const fields = parts.slice(0, format.length - 1).map((s) => s.trim());
    fields.push(parts.slice(format.length - 1).join(','));
    const get = (name) => fields[format.indexOf(name)];
    const time = (v) => { const m = /(\d+):(\d+):(\d+)[.](\d+)/.exec(v ?? ''); return m ? clock(m[1], m[2], m[3], m[4], m[4].length) : NaN; };
    const body = stripTags(get('text') ?? '').replace(/\\N/g, '\n').replace(/\\n/g, ' ').replace(/\\h/g, ' ').trim();
    const start = time(get('start')), end = time(get('end'));
    if (!body || Number.isNaN(start) || Number.isNaN(end)) continue;
    const item = {start, end, text: body};
    if (get('name')) item.speaker = get('name');
    if (get('style')) item.style = get('style');
    items.push(item);
  }
  return items.sort((a, b) => a.start - b.start);
}

export function readSubtitles(file) {
  const text = readFileSync(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.srt') return parseSrt(text);
  if (ext === '.ass' || ext === '.ssa') return parseAss(text);
  throw new Error(`字幕は .srt か .ass / .ssa を使います: ${file}`);
}

// 秒 → コマ数。from を含み to を含まない。
export const toFrames = (items, fps) => items.map(({start, end, ...rest}) => ({from: Math.round(start * fps), to: Math.round(end * fps), ...rest}));
