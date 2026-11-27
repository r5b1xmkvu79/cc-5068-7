import { TIMBRE_KEYS, LOUDNESS_KEYS } from '../config.js';
import {
  featureWeights, appendLoudnessWeights,
  weightedDistance, cosineDistance, explain, vectorize,
} from './distance.js';

const LOUD_WEIGHT = 1.0;

// z-scored vectors for a clip that lives OUTSIDE the index (acceptance query
// set, user import). Uses the already-fitted train statistics; the external
// clip never re-fits anything.
export function externalVectors(index, featuresRaw, featuresEq) {
  const z = (f, stats) => vectorize(f).map((v, i) => (v - stats.mean[i]) / stats.std[i]);
  const zL = (f, stats) => vectorize(f, LOUDNESS_KEYS)
    .map((v, i) => (v - stats.mean[i]) / stats.std[i]);
  return {
    eq: { z: z(featuresEq, index.stats.eq), zLoud: zL(featuresEq, index.stats.loudEq) },
    raw: { z: z(featuresRaw, index.stats.raw), zLoud: zL(featuresRaw, index.stats.loudRaw) },
  };
}

// Core ranking given prepared query vectors. Shared by in-index queries
// (search) and out-of-index queries (searchExternal).
function rank(index, vecs, options) {
  const {
    target = 'general',
    loudnessMode = 'eq',
    usePitch = true,
    metric = 'euclidean',
    excludeGroups = [],
    excludeIds = [],
    adaptedZ = null,
  } = options;
  const useLoudness = options.useLoudness ?? (loudnessMode === 'raw');
  const mode = loudnessMode === 'raw' ? 'raw' : 'eq';

  let qz = adaptedZ || vecs[mode].z;
  let weights = featureWeights(target, usePitch);
  const allKeys = [...TIMBRE_KEYS];
  if (useLoudness) {
    if (!adaptedZ) qz = [...qz, ...vecs[mode].zLoud];
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
    target, loudnessMode: mode, usePitch, useLoudness, metric,
    results,
  };
}

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
  const qrow = index.rows.find((r) => r.id === queryId);
  if (!qrow) throw new Error(`unknown query id ${queryId}`);
  const out = rank(index, {
    eq: { z: qrow.eq.z, zLoud: qrow.eq.zLoud },
    raw: { z: qrow.raw.z, zLoud: qrow.raw.zLoud },
  }, { excludeIds: [queryId], ...options });
  return {
    query: { id: qrow.id, group: qrow.group, kind: qrow.kind },
    ...out,
  };
}

// Rank candidates for a query that is NOT part of the index (the acceptance
// query set, or an imported recording). vecs comes from externalVectors().
export function searchExternal(index, queryId, vecs, options = {}) {
  const out = rank(index, vecs, options);
  return {
    query: { id: queryId, group: null, kind: 'external' },
    ...out,
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
