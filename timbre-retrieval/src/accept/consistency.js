// Index consistency checks (索引一致). Every assertion recomputes from the
// stored artifacts themselves — nothing is taken on trust, and every failure
// names the exact row / stat / key so the report is execution evidence, not
// a pass/fail flag.

import { TIMBRE_KEYS, LOUDNESS_KEYS } from '../config.js';
import { fitStats, vectorize } from '../core/distance.js';

const EPS = 1e-9;

function close(a, b, eps = EPS) {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

// stats / z-vectors / group split must be exactly reproducible from the
// stored per-row features.
export function checkIndexConsistency(index, manifest) {
  const problems = [];

  // 1. manifest <-> index row correspondence (no missing, no extra, no dupes)
  const manifestIds = manifest.records.map((r) => r.id).sort();
  const rowIds = index.rows.map((r) => r.id);
  const sortedRowIds = [...rowIds].sort();
  if (JSON.stringify(manifestIds) !== JSON.stringify(sortedRowIds)) {
    problems.push({
      check: 'rows-match-manifest',
      detail: `manifest has ${manifestIds.length} ids, index has ${sortedRowIds.length}`,
    });
  }
  if (new Set(rowIds).size !== rowIds.length) {
    problems.push({ check: 'rows-unique', detail: 'duplicate row ids in index' });
  }

  // 2. train/test split covers the manifest groups, disjointly
  const manifestGroups = new Set(manifest.records.map((r) => r.group));
  const train = new Set(index.trainGroups);
  const test = new Set(index.testGroups);
  for (const g of train) if (test.has(g)) problems.push({ check: 'split-disjoint', detail: g });
  for (const g of manifestGroups) {
    if (!train.has(g) && !test.has(g)) {
      problems.push({ check: 'split-covers-groups', detail: `group ${g} in neither split` });
    }
  }

  // 3. z-score statistics refit from the stored train rows must match
  const trainRows = index.rows.filter((r) => train.has(r.group));
  const refit = {
    eq: fitStats(trainRows.map((r) => ({ features: r.eq.features }))),
    raw: fitStats(trainRows.map((r) => ({ features: r.raw.features }))),
    loudEq: fitStats(trainRows.map((r) => ({ features: r.eq.features })), LOUDNESS_KEYS),
    loudRaw: fitStats(trainRows.map((r) => ({ features: r.raw.features })), LOUDNESS_KEYS),
  };
  for (const [name, want] of Object.entries(refit)) {
    const got = index.stats[name];
    for (let i = 0; i < want.mean.length; i++) {
      if (!close(want.mean[i], got.mean[i]) || !close(want.std[i], got.std[i])) {
        problems.push({
          check: 'stats-refit',
          detail: `stats.${name}[${want.keys[i]}]: stored mean=${got.mean[i]} std=${got.std[i]}, refit mean=${want.mean[i]} std=${want.std[i]}`,
        });
      }
    }
  }

  // 4. every stored z-vector must equal vectorize(features) under the stats
  const checkVec = (row, mode, keys, stats, field) => {
    const want = vectorize(row[mode].features, keys)
      .map((v, i) => (v - stats.mean[i]) / stats.std[i]);
    const got = row[mode][field];
    if (got.length !== want.length) {
      problems.push({ check: 'z-vector', detail: `${row.id}.${mode}.${field}: length ${got.length} != ${want.length}` });
      return;
    }
    for (let i = 0; i < want.length; i++) {
      if (!close(want[i], got[i])) {
        problems.push({
          check: 'z-vector',
          detail: `${row.id}.${mode}.${field}[${keys[i]}]: stored ${got[i]}, recomputed ${want[i]}`,
        });
        return; // one finding per row is enough
      }
    }
  };
  for (const row of index.rows) {
    checkVec(row, 'eq', TIMBRE_KEYS, index.stats.eq, 'z');
    checkVec(row, 'raw', TIMBRE_KEYS, index.stats.raw, 'z');
    checkVec(row, 'eq', LOUDNESS_KEYS, index.stats.loudEq, 'zLoud');
    checkVec(row, 'raw', LOUDNESS_KEYS, index.stats.loudRaw, 'zLoud');
  }

  return { ok: problems.length === 0, problems };
}

// The cached per-row features must match a fresh recomputation from the WAV
// material. `recompute(id)` returns freshly extracted features for both
// loudness modes: { eq: features, raw: features }. A wrong feature cache
// (stale, swapped, or tampered) must fail here.
export function checkFeatureCache(index, recompute) {
  const problems = [];
  const REL = 1e-6;
  for (const row of index.rows) {
    const fresh = recompute(row.id);
    for (const mode of ['eq', 'raw']) {
      for (const k of Object.keys(row[mode].features)) {
        const a = row[mode].features[k];
        const b = fresh[mode][k];
        if (!(Math.abs(a - b) <= REL * Math.max(1, Math.abs(a), Math.abs(b)))) {
          problems.push({
            check: 'feature-cache',
            detail: `${row.id}.${mode}.${k}: cached ${a}, recomputed ${b}`,
          });
          break; // one finding per row/mode is enough
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
