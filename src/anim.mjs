// Functions for scenes that produce values from the frame. All of them are pure functions.
export const easings = {
  linear: (p) => p,
  inCubic: (p) => p ** 3,
  outCubic: (p) => 1 - (1 - p) ** 3,
  inOutCubic: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (2 - 2 * p) ** 3 / 2),
  inQuad: (p) => p * p,
  outQuad: (p) => 1 - (1 - p) ** 2,
  inOutQuad: (p) => (p < 0.5 ? 2 * p * p : 1 - (2 - 2 * p) ** 2 / 2),
  // Overshoots a little, then comes back
  outBack: (p) => 1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2,
};

export const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));

// A random number determined by a seed (0 or more, less than 1). The same seed gives the same value on every call, so the picture does not change from render to render.
export function random(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Smoothly varying noise (-1 to 1). Pass time (frame count × speed) as x and use it for shakes and wobbles.
export function noise(seed, x) {
  const i = Math.floor(x), t = x - i;
  const a = random(`${seed}:${i}`) * 2 - 1, b = random(`${seed}:${i + 1}`) * 2 - 1;
  return a + (b - a) * (t * t * (3 - 2 * t));
}

// Shows text one character at a time. Returns the part shown by the given frame (perSecond is characters per second).
export function typewriter(text, frame, fps, perSecond = 20) {
  return Array.from(text).slice(0, Math.max(0, Math.floor((frame / fps) * perSecond))).join('');
}

// Maps frame from [f0, f1, ...] to [v0, v1, ...]. Outside the range it holds the end value.
export function interpolate(frame, frames, values, easing = 'linear') {
  if (frame <= frames[0]) return values[0];
  for (let i = 1; i < frames.length; i++) {
    if (frame < frames[i]) {
      const p = (frame - frames[i - 1]) / (frames[i] - frames[i - 1]);
      return values[i - 1] + (values[i] - values[i - 1]) * easings[easing](p);
    }
  }
  return values[values.length - 1];
}

// A damped spring going from 0 to 1. Uses the closed-form solution of the equation of motion (no numerical integration).
export function spring({frame, fps, damping = 10, stiffness = 100, mass = 1}) {
  const t = Math.max(0, frame) / fps;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const s = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - s), r2 = -w0 * (zeta + s);
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

// Once the motion has stopped, snap to the same value so that those frames are drawn only once, as the same picture.
export function settle(value, target = 1, digits = 3) {
  const q = Number(value.toFixed(digits));
  return Math.abs(q - target) <= 2 * 10 ** -digits ? target : q;
}
