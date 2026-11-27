// 重复文件与无效输入 — duplicate files and invalid inputs at the boundary.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFixture } from './helpers/fixture.js';
import { validateQuerySignal } from '../src/accept/validate.js';
import { SR } from '../src/config.js';

test('invalid query inputs are rejected with reasons', async () => {
  const { report, queryset } = await getFixture();
  const registered = queryset.queries.filter((q) => q.kind === 'invalid').map((q) => q.id);
  assert.ok(registered.length >= 4, 'query set must register invalid probes');
  const seen = new Map(report.evidence.invalid.map((r) => [r.id, r]));
  for (const id of registered) {
    const r = seen.get(id);
    assert.ok(r, `${id} missing from the invalid-input report`);
    assert.equal(r.rejected, true, `${id} must be rejected`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${id} needs a reason`);
  }
  assert.equal(report.metrics.invalid.rejected, report.metrics.invalid.n);
});

test('validateQuerySignal unit behavior', () => {
  const n = Math.floor(0.5 * SR);
  assert.equal(validateQuerySignal(new Float64Array(0), SR).ok, false);
  assert.equal(validateQuerySignal(new Float64Array(32).fill(0.2), SR).ok, false); // tiny
  assert.equal(validateQuerySignal(new Float64Array(n).fill(1e-6), SR).ok, false); // silence
  assert.equal(validateQuerySignal(new Float64Array(n).fill(0.3), SR).ok, false); // DC
  const clipped = new Float64Array(n);
  for (let i = 0; i < n; i++) clipped[i] = i % 2 ? 1 : -1;
  assert.equal(validateQuerySignal(clipped, SR).ok, false); // square wave: no crest headroom... clipped
  // a plausible impact: decaying sine burst
  const ok = new Float64Array(n);
  for (let i = 0; i < n; i++) ok[i] = 0.8 * Math.exp(-i / 4000) * Math.sin(2 * Math.PI * 220 * i / SR);
  assert.equal(validateQuerySignal(ok, SR).ok, true);
});

test('duplicate files are detected and de-counted from evidence', async () => {
  const { report, queryset } = await getFixture();
  assert.equal(report.evidence.duplicates.length, 1);
  const dup = report.evidence.duplicates[0];
  assert.equal(dup.id, 'q_dup_b');
  assert.equal(dup.duplicateOf, 'q_rr_P1_light_U1');
  // the duplicate stays registered (it is a fact about the world) but must
  // not inflate the generalization evidence count
  const registered = queryset.registry.generalization.map((e) => e.query);
  assert.ok(registered.includes('q_dup_b'), 'the duplicate is deliberately registered');
  assert.equal(report.metrics.generalization.n, registered.length - 1);
  assert.equal(report.metrics.duplicates.detected, 1);
});
