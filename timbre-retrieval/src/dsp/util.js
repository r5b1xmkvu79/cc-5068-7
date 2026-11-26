export function hanning(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// RMS framing with hop; returns frame times in seconds and RMS amplitudes.
export function rmsEnvelope(x, sr, frameLen, hop) {
  const win = hanning(frameLen);
  const n = Math.max(0, Math.floor((x.length - frameLen) / hop) + 1);
  const rms = new Float64Array(n);
  const times = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const start = i * hop;
    let s = 0;
    for (let j = 0; j < frameLen; j++) {
      const v = x[start + j] * win[j];
      s += v * v;
    }
    rms[i] = Math.sqrt(s / frameLen) + 1e-12;
    times[i] = (start + frameLen / 2) / sr;
  }
  return { rms, times };
}

// Least-squares slope of y = a + b*x over [i0, i1).
export function linfit(xs, ys, i0, i1) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = i0; i < i1 && i < ys.length; i++, n++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  if (n < 2) return { a: 0, b: 0 };
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-18) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / den;
  const a = (sy - b * sx) / n;
  return { a, b };
}

export const safeLog10 = (v) => Math.log10(Math.max(1e-8, v));
export const safeLog = (v) => Math.log(Math.max(1e-8, v));
export const median = (arr) => {
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
export const mean = (arr) => {
  let s = 0; for (const v of arr) s += v; return arr.length ? s / arr.length : 0;
};
export const std = (arr) => {
  if (arr.length < 2) return 0;
  const mu = mean(arr);
  let s = 0; for (const v of arr) s += (v - mu) ** 2;
  return Math.sqrt(s / (arr.length - 1));
};
