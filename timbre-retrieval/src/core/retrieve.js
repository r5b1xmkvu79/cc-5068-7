import { TIMBRE_KEYS, LOUDNESS_KEYS } from '../config.js';
import {
  featureWeights, appendLoudnessWeights,
  weightedDistance, cosineDistance, explain, vectorize,
} from './distance.js';

// Rank candidates for a query clip already present in the index.
// options:
//   target       prop | force | general
//   loudnessMode eq (equalized, gain removed) | raw (dynamics preserved)
//   usePitch     include pitch block in timbre
//   useLoudness  include absolute loudness block (defaults ON in raw mode)
//   metric       euclidean | cosine
//   excludeGroups  groups banned from candidates (leakage control)
//   excludeIds     ids banned (e.g. the query itself)
//   adaptedZ     optional Rocchio-adapted query vector (re-ranking)
export function search(index, queryId, options = {}) {
  const {
    target = 'general',
    loudnessMode = 'eq',
    usePitch = true,
    metric = 'euclidean',
    excludeGroups = [],
    excludeIds = [queryId],
    adaptedZ = null,
  } = options;
  const useLoudness = options.useLoudness ?? (loudnessMode === 'raw');
  const LOUD_WEIGHT = 1.0;

  const qrow = index.rows.find((r) => r.id === queryId);
  if (!qrow) throw new Error(`unknown query id ${queryId}`);
  const mode = loudnessMode === 'raw' ? 'raw' : 'eq';
  const stats = index.stats[mode];
  const loudStats = index.stats[mode === 'raw' ? 'loudRaw' : 'loudEq'];
  let qz = adaptedZ
    || vectorize(qrow[mode].features).map((v, i) => (v - stats.mean[i]) / stats.std[i]);
  let weights = featureWeights(target, usePitch);
  const allKeys = [...TIMBRE_KEYS];
  if (useLoudness) {
    if (!adaptedZ) {
      const qLoud = vectorize(qrow[mode].features, LOUDNESS_KEYS)
        .map((v, i) => (v - loudStats.mean[i]) / loudStats.std[i]);
      qz = [...qz, ...qLoud];
    }
    weights = appendLoudnessWeights(weights, LOUD_WEIGHT);
    allKeys.push(...LOUDNESS_KEYS);
  }
  const banGroup = new Set(excludeGroups);
  const banId = new Set(excludeIds);

  const results = [];
  for (const row of index.rows) {
    if (banId.has(row.id) || banGroup.has(row.group)) continue;
    let cz = row[mode].z;
    if (useLoudness) cz = [...cz, ...row[mode].zLoud];
    const dist = metric === 'cosine'
      ? cosineDistance(qz, cz, weights)
      : weightedDistance(qz, cz, weights);
    results.push({
      id: row.id,
      group: row.group,
      kind: row.kind,
      distance: +dist.toFixed(4),
      similarity: +Math.exp(-dist).toFixed(4),
      explanation: explain(qz, cz, allKeys).slice(0, 6),
    });
  }
  results.sort((a, b) => a.distance - b.distance);
  return {
    query: { id: qrow.id, group: qrow.group, kind: qrow.kind },
    target, loudnessMode: mode, usePitch, useLoudness, metric,
    results,
  };
}

// Rocchio-style relevance feedback in the fitted z-space; drives a new query.
// relevant/irrelevant are arrays of clip ids marked by the user in the UI.
export function adaptQuery(index, queryId, relevantIds, irrelevantIds, loudnessMode = 'eq', useLoudness = loudnessMode === 'raw') {
  const mode = loudnessMode === 'raw' ? 'raw' : 'eq';
  const qrow = index.rows.find((r) => r.id === queryId);
  const vecOf = (row) => useLoudness ? [...row[mode].z, ...row[mode].zLoud] : row[mode].z;
  const dim = vecOf(qrow).length;
  const centroid = (ids) => {
    const c = new Array(dim).fill(0);
    let n = 0;
    for (const id of ids) {
      const row = index.rows.find((r) => r.id === id);
      if (!row) continue;
      const v = vecOf(row);
      for (let i = 0; i < dim; i++) c[i] += v[i];
      n++;
    }
    return n ? c.map((v) => v / n) : c;
  };
  const rel = centroid(relevantIds);
  const irr = centroid(irrelevantIds);
  const alpha = 1, beta = 0.6, gamma = 0.35;
  return vecOf(qrow).map((q, i) =>
    alpha * q
    + (relevantIds.length ? beta * rel[i] : 0)
    - (irrelevantIds.length ? gamma * irr[i] : 0));
}
