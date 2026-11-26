import { SR } from '../config.js';

export function rmsDb(x) {
  let s = 0;
  for (const v of x) s += v * v;
  return 20 * Math.log10(Math.sqrt(s / x.length) + 1e-12);
}

export function peakDb(x) {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return 20 * Math.log10(p + 1e-12);
}

// Equalize average loudness (RMS) to a fixed target while keeping dynamics.
// A peak ceiling avoids clipping; if the required gain would clip, everything
// is attenuated to fit (and the returned headroom reports the shortfall).
export function equalizeLoudness(x, targetDb = -26, ceilingDb = -1) {
  const cur = rmsDb(x);
  const g = 10 ** ((targetDb - cur) / 20);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v * g));
  let finalGain = g;
  let headroom = 0;
  const ceil = 10 ** (ceilingDb / 20);
  if (peak > ceil) {
    finalGain = ceil / peak;
    headroom = 20 * Math.log10((finalGain / g));
  }
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * finalGain;
  return { samples: out, gainDb: 20 * Math.log10(finalGain), headroom };
}

// Linear-interpolation resampler to the project sample rate.
export function resampleTo(x, srIn, srOut = SR) {
  if (srIn === srOut) return Float64Array.from(x);
  const ratio = srIn / srOut;
  const n = Math.floor(x.length / ratio);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = x[Math.min(i0, x.length - 1)];
    const b = x[Math.min(i0 + 1, x.length - 1)];
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

export function trimSilence(x, sr, threshDb = -55, padMs = 10) {
  const thresh = 10 ** (threshDb / 20);
  let a = 0, b = x.length - 1;
  while (a < x.length && Math.abs(x[a]) < thresh) a++;
  while (b > a && Math.abs(x[b]) < thresh) b--;
  const pad = Math.floor((padMs / 1000) * sr);
  a = Math.max(0, a - pad);
  b = Math.min(x.length - 1, b + pad);
  return x.subarray(a, b + 1);
}
