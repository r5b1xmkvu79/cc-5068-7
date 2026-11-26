import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CORPUS_RAW, CORPUS_EQ, MANIFEST, INDEX_DIR,
  SR, TIMBRE_KEYS, LOUDNESS_KEYS, DURATION_KEYS,
} from '../config.js';
import { readWav, toMono } from '../dsp/wav.js';
import { resampleTo, trimSilence } from '../dsp/loudness.js';
import { extractFeatures } from '../dsp/features.js';
import { fitStats, vectorize } from './distance.js';

async function loadClip(file) {
  const wav = readWav(await readFile(file));
  let x = toMono(wav);
  x = resampleTo(x, wav.sampleRate);
  x = trimSilence(x, wav.sampleRate);
  return x;
}

// Group-disjoint split. Holdout clips are never used for fitting stats.
export function splitGroups(groups, opts = {}) {
  const sorted = [...groups].sort();
  const test = new Set(opts.testGroups || []);
  const train = sorted.filter((g) => !test.has(g));
  return { trainGroups: train, testGroups: [...test] };
}

export async function buildIndex(options = {}) {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const groups = [...new Set(manifest.records.map((r) => r.group))].sort();
  const { trainGroups, testGroups } = splitGroups(groups, options);

  const rows = [];
  for (const rec of manifest.records) {
    const raw = await loadClip(path.join(CORPUS_RAW, rec.id + '.wav'));
    const eq = await loadClip(path.join(CORPUS_EQ, rec.id + '.wav'));
    const fRaw = extractFeatures(raw, SR);
    const fEq = extractFeatures(eq, SR);
    rows.push({
      id: rec.id,
      group: rec.group,
      kind: rec.kind,
      raw: { features: fRaw.features, curves: fRaw.curves },
      eq: { features: fEq.features, curves: fEq.curves },
    });
  }

  // Fitted statistics: ONLY training groups, and separately per loudness mode.
  const trainRows = rows.filter((r) => trainGroups.includes(r.group));
  const statsRaw = fitStats(trainRows.map((r) => ({ features: r.raw.features })));
  const statsEq = fitStats(trainRows.map((r) => ({ features: r.eq.features })));
  const loudStatsRaw = fitStats(trainRows.map((r) => ({ features: r.raw.features })), LOUDNESS_KEYS);
  const loudStatsEq = fitStats(trainRows.map((r) => ({ features: r.eq.features })), LOUDNESS_KEYS);

  // Precompute z-scored vectors for every clip.
  for (const row of rows) {
    row.raw.z = vectorize(row.raw.features).map((v, i) => (v - statsRaw.mean[i]) / statsRaw.std[i]);
    row.eq.z = vectorize(row.eq.features).map((v, i) => (v - statsEq.mean[i]) / statsEq.std[i]);
    row.raw.zLoud = vectorize(row.raw.features, LOUDNESS_KEYS)
      .map((v, i) => (v - loudStatsRaw.mean[i]) / loudStatsRaw.std[i]);
    row.eq.zLoud = vectorize(row.eq.features, LOUDNESS_KEYS)
      .map((v, i) => (v - loudStatsEq.mean[i]) / loudStatsEq.std[i]);
  }

  const index = {
    builtAt: new Date().toISOString(),
    keys: TIMBRE_KEYS,
    nuisanceKeys: [...LOUDNESS_KEYS, ...DURATION_KEYS],
    trainGroups,
    testGroups,
    stats: {
      raw: statsRaw, eq: statsEq,
      loudRaw: loudStatsRaw, loudEq: loudStatsEq,
    },
    rows,
  };
  await mkdir(INDEX_DIR, { recursive: true });
  await writeFile(path.join(INDEX_DIR, 'index.json'), JSON.stringify(index));
  return index;
}

async function main() {
  const idx = await buildIndex();
  console.log(`index built: ${idx.rows.length} clips`);
  console.log(`train groups (${idx.trainGroups.length}): ${idx.trainGroups.join(', ')}`);
  if (idx.testGroups.length) console.log(`held-out groups: ${idx.testGroups.join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
