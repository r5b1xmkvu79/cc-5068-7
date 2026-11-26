import {
  TIMBRE_KEYS, SPECTRAL_KEYS, ENVELOPE_KEYS, PITCH_KEYS,
  LOUDNESS_KEYS, TARGET_WEIGHTS, KEY_BLOCK,
} from '../config.js';

// Fixed list of transforms applied before z-scoring. All parameters here are
// structural (no data dependence); data-dependent statistics live in the
// fitted index and are computed on training groups only.
const LOG_KEYS = new Set([
  'specCentroid', 'specBandwidth', 'specRolloff85',
  'attackTime', 'decayTau', 'f0', 'transientRatio',
]);

export function transformFeature(key, value) {
  if (key === 'f0' && (!value || value <= 0)) return 0;
  if (LOG_KEYS.has(key)) return Math.log10(Math.max(1e-6, value));
  if (key === 'f0Confidence') return value;
  return value;
}

export function vectorize(features, keys = TIMBRE_KEYS) {
  return keys.map((k) => transformFeature(k, features[k]));
}

// Per-feature mean/std z-score. Stats are fitted once, on training groups.
export function fitStats(rows, keys = TIMBRE_KEYS) {
  const n = rows.length;
  const mean = new Array(keys.length).fill(0);
  const std = new Array(keys.length).fill(0);
  for (const row of rows) {
    const v = vectorize(row.features, keys);
    for (let i = 0; i < keys.length; i++) mean[i] += v[i];
  }
  for (let i = 0; i < keys.length; i++) mean[i] /= n;
  for (const row of rows) {
    const v = vectorize(row.features, keys);
    for (let i = 0; i < keys.length; i++) std[i] += (v[i] - mean[i]) ** 2;
  }
  for (let i = 0; i < keys.length; i++) {
    std[i] = Math.sqrt(std[i] / Math.max(1, n - 1));
    if (std[i] < 1e-9) std[i] = 1;
  }
  return { keys, mean, std };
}

export function zscore(vec, stats) {
  return vec.map((v, i) => (v - stats.mean[i]) / stats.std[i]);
}

export function featureWeights(target, usePitch = true) {
  const tw = TARGET_WEIGHTS[target] || TARGET_WEIGHTS.general;
  return TIMBRE_KEYS.map((k) => {
    const block = KEY_BLOCK[k];
    if (block === 'pitch' && !usePitch) return 0;
    return tw[block] ?? 1;
  });
}

// Dynamics-preserving mode appends absolute loudness descriptors. They are
// fitted with their own stats and weighted as an explicit block so the effect
// of preamp gain on neighbor order is measurable, not accidental.
export function appendLoudnessWeights(weights, loudnessWeight) {
  return [...weights, ...LOUDNESS_KEYS.map(() => loudnessWeight)];
}

// Default metric: block-weighted Euclidean distance on z-scored timbre
// descriptors. Loudness and duration are not inputs. Cosine is offered as an
// explicit alternative, not as a claim of universal perceptual superiority.
export function weightedDistance(za, zb, weights) {
  let s = 0, wsum = 0;
  for (let i = 0; i < za.length; i++) {
    const w = weights[i];
    s += w * (za[i] - zb[i]) ** 2;
    wsum += w;
  }
  return Math.sqrt(s / Math.max(1e-9, wsum));
}

export function cosineDistance(za, zb, weights) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < za.length; i++) {
    const w = weights[i];
    dot += w * za[i] * zb[i];
    na += w * za[i] * za[i];
    nb += w * zb[i] * zb[i];
  }
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
  return 1 - Math.max(-1, Math.min(1, cos));
}

// Per-feature contribution (in z-score units) for the explanation panel.
export function explain(za, zb, keys = TIMBRE_KEYS) {
  return keys.map((k, i) => ({
    feature: k,
    block: KEY_BLOCK[k],
    deltaZ: +(za[i] - zb[i]).toFixed(3),
    absDelta: Math.abs(za[i] - zb[i]),
  })).sort((a, b) => b.absDelta - a.absDelta);
}

export { SPECTRAL_KEYS, ENVELOPE_KEYS, PITCH_KEYS };
