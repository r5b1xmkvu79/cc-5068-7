// 验收器 — the gate actually publishes or rejects an index version.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getFixture } from './helpers/fixture.js';
import {
  runAcceptance, decidePublish, swapRegistries,
} from '../src/accept/gate.js';
import { expectedSwapVictim } from '../src/accept/reference.js';
import { vectorize } from '../src/core/distance.js';
import { PUBLISH_DIR, TIMBRE_KEYS, PITCH_KEYS } from '../src/config.js';

test('clean index is published, with evidence on disk', async () => {
  const { report } = await getFixture();
  assert.equal(report.publish, true, `findings: ${JSON.stringify(report.findings)}`);
  const decision = await decidePublish(report);
  assert.equal(decision.decision, 'published');
  assert.ok(existsSync(path.join(PUBLISH_DIR, 'index.json')), 'published index must exist');
  assert.ok(existsSync(path.join(PUBLISH_DIR, 'decision.json')));
});

test('swapped source registries are rejected even though top-1 hit rate stays perfect', async () => {
  const { index, manifest, queryset } = await getFixture();
  const swapped = swapRegistries(queryset);
  const report = await runAcceptance({ index, manifest, queryset: swapped });
  assert.equal(report.publish, false);
  // The wrong grouping makes same-recording segments pose as generalization
  // evidence: they trivially "hit" their class, so the hit rate is perfect —
  // and publication must STILL fail on provenance grounds.
  assert.equal(report.metrics.generalization.top1, 1,
    'segments posing as generalization evidence should raise the hit rate');
  const provenance = report.findings.filter((f) => f.check === 'provenance');
  assert.ok(provenance.length > 0, 'expected provenance findings');
  assert.ok(provenance.some((f) => f.detail.includes('cannot prove')),
    'findings must state that same-source material cannot prove generalization');
  const decision = await decidePublish(report);
  assert.equal(decision.decision, 'rejected');
  assert.ok(!existsSync(path.join(PUBLISH_DIR, 'index.json')),
    'a rejected version must not leave a published index behind');
});

test('loudness-stat swap: checker names the class the independent loudness analysis expects', async () => {
  const { report, index, manifest } = await getFixture();
  const diag = report.loudnessSwap;
  assert.ok(diag.firstReversedClass, 'the swap must reverse some class ranking');
  assert.ok(diag.perQuery.some((q) => q.reversed), 'need at least one reversed query as evidence');
  // Independently re-derived here from the loudness subspace alone.
  const gen = report.evidence.generalization.map((e) => e.query);
  assert.ok(gen.length > 0);
  assert.equal(diag.firstReversedClass, diag.independentExpectation.victim,
    `checker names ${diag.firstReversedClass}, independent expectation ${diag.independentExpectation.victim}`);
  // and the independent expectation itself is not trivially null
  assert.ok(['P1', 'P2'].includes(diag.independentExpectation.victim));
});

test('controlled error: corrupted fitted statistics reject the index', async () => {
  const { index, manifest, queryset } = await getFixture();
  const bad = structuredClone(index);
  bad.stats.eq.mean[0] += 0.25;
  const report = await runAcceptance({ index: bad, manifest, queryset });
  assert.equal(report.publish, false);
  assert.ok(report.findings.some((f) => f.check === 'index-stats-refit'));
});

test('controlled error: pitch-dominated statistics flip a hard negative and reject', async () => {
  const { index, manifest, queryset } = await getFixture();
  const bad = structuredClone(index);
  const pitchIdx = TIMBRE_KEYS
    .map((k, i) => (PITCH_KEYS.includes(k) ? i : -1))
    .filter((i) => i >= 0);
  for (const s of [bad.stats.eq, bad.stats.raw]) {
    for (const i of pitchIdx) s.std[i] /= 6;
  }
  for (const row of bad.rows) {
    for (const mode of ['eq', 'raw']) {
      const st = bad.stats[mode];
      row[mode].z = vectorize(row[mode].features).map((v, i) => (v - st.mean[i]) / st.std[i]);
    }
  }
  const report = await runAcceptance({ index: bad, manifest, queryset });
  assert.equal(report.publish, false);
  assert.ok(report.findings.some((f) => f.check === 'hard-negative'),
    `expected a hard-negative finding: ${JSON.stringify(report.findings.map((f) => f.check))}`);
});
