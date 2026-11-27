// 排序质量及索引一致 — ranking quality and index consistency.
// Every expectation in this file is derived from the INDEPENDENT physical
// reference (accept/reference.js) or recomputed from stored artifacts —
// never from the retrieval distance function's own output.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getFixture } from './helpers/fixture.js';
import { referenceClass, verifyReference } from '../src/accept/reference.js';
import { checkIndexConsistency } from '../src/accept/consistency.js';
import { MATCH_CORR, PROVENANCE_CORR_MAX } from '../src/accept/gate.js';

test('independent reference is self-consistent and not wired to the distance function', async () => {
  const { manifest } = await getFixture();
  const check = verifyReference(manifest);
  assert.equal(check.ok, true, `reference misclassifies: ${JSON.stringify(check.mismatches)}`);
  // The reference must derive expectations from physics, not from the
  // retrieval distance function. Guard the import boundary directly.
  const src = await readFile(new URL('../src/accept/reference.js', import.meta.url), 'utf8');
  const imports = src.match(/^import .*$/gm) || [];
  assert.ok(!imports.some((l) => l.includes('core/distance') || l.includes('core/retrieve')),
    `reference must not import retrieval machinery, found: ${imports.join(' | ')}`);
});

test('dedup evidence: same-recording segments retrieve their source', async () => {
  const { report } = await getFixture();
  assert.equal(report.evidence.dedup.length >= 4, true, 'need segment evidence');
  for (const e of report.evidence.dedup) {
    assert.equal(e.ok, true, `${e.query} failed dedup evidence`);
    assert.ok(e.sourceCorrelation >= MATCH_CORR,
      `${e.query}: correlation ${e.sourceCorrelation} with its source recording`);
    assert.ok(e.sourceGroupRank >= 1 && e.sourceGroupRank <= 3,
      `${e.query}: source group ranks #${e.sourceGroupRank}`);
  }
  assert.equal(report.metrics.dedup.pass, report.metrics.dedup.n);
});

test('generalization evidence: unseen-performer re-recordings, expectations from the independent reference', async () => {
  const { report, queryset } = await getFixture();
  const metaById = new Map(queryset.queries.map((q) => [q.id, q]));
  assert.equal(report.evidence.generalization.length >= 8, true, 'need re-recording evidence');
  for (const e of report.evidence.generalization) {
    // Expected class derived HERE from physics, not copied from the report.
    const expected = referenceClass(metaById.get(e.query));
    assert.equal(e.expectedProp, expected.prop);
    assert.equal(e.top1.prop, expected.prop,
      `${e.query}: top-1 ${e.top1.id} is ${e.top1.prop}, physics expects ${expected.prop}`);
    assert.ok(e.top1Correlation < PROVENANCE_CORR_MAX,
      `${e.query}: correlates ${e.top1Correlation} with an indexed clip — cannot prove generalization`);
    assert.equal(e.ok, true);
  }
  assert.equal(report.metrics.generalization.top1, 1);
});

test('hard negatives: similar envelope, different pitch — class survives in both directions', async () => {
  const { report, queryset } = await getFixture();
  const metaById = new Map(queryset.queries.map((q) => [q.id, q]));
  const roles = new Set();
  for (const e of report.evidence.hardNegative) {
    roles.add(e.role);
    const meta = metaById.get(e.query);
    assert.notEqual(meta.pitchShift, 0, 'hard negative must actually shift pitch');
    const expected = referenceClass(meta);
    assert.equal(e.top1.prop, expected.prop,
      `${e.query} (${e.role}, ${meta.pitchShift}st): pitch alone must not flip ${expected.prop}`);
    assert.equal(e.ok, true);
  }
  assert.deepEqual([...roles].sort(), ['negative', 'positive']);
  assert.equal(report.metrics.hardNegative.pass, report.metrics.hardNegative.n);
});

test('index consistency: stats, z-vectors and split reproduce from stored features', async () => {
  const { index, manifest } = await getFixture();
  const check = checkIndexConsistency(index, manifest);
  assert.deepEqual(check.problems, []);
  assert.equal(check.ok, true);
});

test('controlled error: a tampered z-vector is caught and named', async () => {
  const { index, manifest } = await getFixture();
  const bad = structuredClone(index);
  const victim = bad.rows[5];
  victim.eq.z[3] += 0.5;
  const check = checkIndexConsistency(bad, manifest);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.check === 'z-vector' && p.detail.includes(victim.id)),
    `expected a z-vector finding naming ${victim.id}: ${JSON.stringify(check.problems)}`);
});

test('controlled error: swapped fitted statistics are caught', async () => {
  const { index, manifest } = await getFixture();
  const bad = structuredClone(index);
  [bad.stats.eq, bad.stats.raw] = [bad.stats.raw, bad.stats.eq];
  const check = checkIndexConsistency(bad, manifest);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.check === 'stats-refit'));
});

test('controlled error: a dropped index row is caught', async () => {
  const { index, manifest } = await getFixture();
  const bad = structuredClone(index);
  bad.rows.splice(3, 1);
  const check = checkIndexConsistency(bad, manifest);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.check === 'rows-match-manifest'));
});
