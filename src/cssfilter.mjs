// CSSの filter と同じ書き方（"brightness(1.1) sepia(0.4) hue-rotate(20deg)"）を読み、色の変換を3D LUTにする。
// 計算はCSSの仕様どおりsRGBのまま行い、関数ごとに0〜1へ切り詰める。blur() と opacity() は色ではないので別に返す。

const clamp = (x) => Math.min(1, Math.max(0, x));
const matrix = (m) => ([r, g, b]) => [m[0] * r + m[1] * g + m[2] * b, m[3] * r + m[4] * g + m[5] * b, m[6] * r + m[7] * g + m[8] * b];

const amount = (raw) => {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) throw new Error(`数値が必要です: ${raw}`);
  return raw.trim().endsWith('%') ? v / 100 : v;
};
const angle = (raw) => {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) throw new Error(`角度が必要です: ${raw}`);
  const unit = raw.trim().replace(/^[-+\d.eE]+/, '') || 'deg';
  const toRad = {deg: Math.PI / 180, rad: 1, turn: 2 * Math.PI, grad: Math.PI / 200}[unit];
  if (!toRad) throw new Error(`角度の単位が分かりません: ${raw}`);
  return v * toRad;
};

const COLOR = {
  brightness: (raw) => { const b = Math.max(0, amount(raw)); return (c) => c.map((x) => x * b); },
  contrast: (raw) => { const k = Math.max(0, amount(raw)); return (c) => c.map((x) => (x - 0.5) * k + 0.5); },
  invert: (raw) => { const a = clamp(amount(raw)); return (c) => c.map((x) => x * (1 - 2 * a) + a); },
  saturate: (raw) => {
    const s = Math.max(0, amount(raw));
    return matrix([0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]);
  },
  grayscale: (raw) => {
    const k = 1 - clamp(amount(raw));
    return matrix([0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k]);
  },
  sepia: (raw) => {
    const k = 1 - clamp(amount(raw));
    return matrix([0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k]);
  },
  'hue-rotate': (raw) => {
    const t = angle(raw), c = Math.cos(t), s = Math.sin(t);
    return matrix([
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
    ]);
  },
};
export const filterNames = [...Object.keys(COLOR), 'blur', 'opacity'];

// → {color: 色の変換関数（なければnull）, blur: px, opacity: 0〜1}
export function parseFilter(text) {
  const steps = [];
  let blur = 0, opacity = 1;
  const rest = String(text).replace(/([a-z-]+)\(([^)]*)\)/g, (_, name, arg) => {
    if (name === 'blur') blur += parseFloat(arg);
    else if (name === 'opacity') opacity *= clamp(amount(arg));
    else if (COLOR[name]) steps.push(COLOR[name](arg));
    else throw new Error(`知らないフィルタです: ${name}（使えるのは ${filterNames.join(', ')}）`);
    return '';
  });
  if (rest.trim()) throw new Error(`読めない部分があります: "${rest.trim()}"`);
  if (!Number.isFinite(blur) || blur < 0) throw new Error('blur() には0以上のpxを書きます');
  const color = steps.length === 0 ? null : (rgb) => steps.reduce((c, f) => f(c).map(clamp), rgb);
  return {color, blur, opacity};
}

// 色の変換を .cube 形式の3D LUTにする（赤が最も速く変わる並び）。
export function cubeLut(color, size = 33) {
  const lines = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    lines.push(color([r / (size - 1), g / (size - 1), b / (size - 1)]).map((x) => x.toFixed(6)).join(' '));
  }
  return lines.join('\n') + '\n';
}
