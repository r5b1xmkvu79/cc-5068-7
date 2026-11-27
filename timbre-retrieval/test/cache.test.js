// 错误特征缓存 — the feature cache must match a fresh recomputation from
// the actual WAV material; wrong caches must fail the test.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getFixture } from './helpers/fixture.js';
import { checkFeatureCache } from '../src/accept/consistency.js';
import { CORPUS_RAW, CORPUS_EQ, SR } from '../src/config.js';
import { readWav, toMono } from '../src/dsp/wav.js';
import { resampleTo, trimSilence } from '../src/dsp/loudness.js';
import { extractFeatures } from '../src/dsp/features.js';

// Fresh recomputation through the public DSP chain (same steps the indexer
// documents, re-derived here rather than imported from the indexer).
async function recomputeFromWav(id) {
  const out = {};
  for (const [mode, dir] of [['raw', CORPUS_RAW], ['eq', CORPUS_EQ]]) {
    const wav = readWav(await readFile(path.join(dir, id + '.wav')));
    const x = trimSilence(resampleTo(toMono(wav), wav.sampleRate), SR);
    out[mode] = extractFeatures(x, SR).features;
  }
  return out;
}

test('feature cache matches a fresh recomputation from WAV', async () => {
  const { index } = await getFixture();
  const precomputed = new Map();
  for (const row of index.rows) precomputed.set(row.id, await recomputeFromWav(row.id));
  const res = checkFeatureCache(index, (id) => precomputed.get(id));
  assert.deepEqual(res.problems, []);
  assert.equal(res.ok, true);
});

test('controlled error: a tampered cached feature is caught and named', async () => {
  const { index } = await getFixture();
  const precomputed = new Map();
  for (const row of index.rows) precomputed.set(row.id, await recomputeFromWav(row.id));
  const bad = structuredClone(index);
  const victim = bad.rows[7];
  victim.eq.features.specCentroid *= 1.5;
  const res = checkFeatureCache(bad, (id) => precomputed.get(id));
  assert.equal(res.ok, false);
  assert.ok(res.problems.some((p) => p.detail.includes(victim.id) && p.detail.includes('specCentroid')),
    `expected a finding naming ${victim.id}.specCentroid: ${JSON.stringify(res.problems)}`);
});

test('controlled error: a cache produced by the wrong pipeline fails', async () => {
  const { index } = await getFixture();
  // A "wrong cache": the eq row's features were computed from the RAW file
  // (a mode mixup in the caching pipeline). Must not pass as the true cache.
  const wrongCache = structuredClone(index);
  for (const row of wrongCache.rows) {
    const wav = readWav(await readFile(path.join(CORPUS_RAW, row.id + '.wav')));
    const x = trimSilence(resampleTo(toMono(wav), wav.sampleRate), SR);
    row.eq.features = extractFeatures(x, SR).features;
  }
  const precomputed = new Map();
  for (const row of index.rows) precomputed.set(row.id, await recomputeFromWav(row.id));
  const res = checkFeatureCache(wrongCache, (id) => precomputed.get(id));
  assert.equal(res.ok, false, 'a mode-mixed cache must fail verification');
  assert.ok(res.problems.length > 0);
});
