// Signal-level duplicate / provenance check, independent of the feature
// pipeline: a cut from the same recording correlates with the source
// waveform; a different recording of the same class does not.

function decimate(x, factor) {
  const n = Math.floor(x.length / factor);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) s += x[base + j];
    out[i] = s / factor;
  }
  return out;
}

// Max normalized cross-correlation of `short` over `long` (either may be the
// longer one). Scale-invariant by construction. Computed at a reduced sample
// rate: provenance does not need full-band precision.
export function maxCorrelation(a, b, factor = 4) {
  let x = decimate(a, factor);
  let y = decimate(b, factor);
  if (x.length > y.length) [x, y] = [y, x];
  if (x.length === 0 || y.length === 0) return 0;
  let ex = 0;
  for (const v of x) ex += v * v;
  if (ex < 1e-12) return 0;
  // cumulative energy of y for O(1) window norms
  const cum = new Float64Array(y.length + 1);
  for (let i = 0; i < y.length; i++) cum[i + 1] = cum[i] + y[i] * y[i];
  let best = 0;
  const lags = y.length - x.length;
  for (let k = 0; k <= lags; k++) {
    const ey = cum[k + x.length] - cum[k];
    if (ey < 1e-12) continue;
    let dot = 0;
    for (let i = 0; i < x.length; i++) dot += x[i] * y[k + i];
    const c = Math.abs(dot) / Math.sqrt(ex * ey);
    if (c > best) best = c;
  }
  return best;
}
