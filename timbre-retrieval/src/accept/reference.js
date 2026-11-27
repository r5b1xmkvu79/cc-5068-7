// Independent reference model for acceptance expectations.
//
// Everything here is derived from the PHYSICAL SYNTHESIS PARAMETERS (mode
// ladder, decay times, excitation tables in dsp/synth.js) — never from the
// retrieval distance function in core/distance.js. If the retrieval system
// and this reference disagree, the retrieval system is what gets rejected.
//
// Physical premise: the identity of a struck object lives in its RELATIVE
// mode ladder, decay profile and excitation character. Absolute pitch is a
// property of the recording, not the object — a pitch-shifted wooden panel
// is still a wooden panel. The reference metric is therefore built to be
// shift-invariant for prop identity.

import { propParams, forceParams, propList, forceList } from '../dsp/synth.js';

// Shift-invariant physical fingerprint of a prop.
export function propFingerprint(prop) {
  const p = propParams(prop);
  const f0 = p.modes[0].f;
  return {
    nModes: p.modes.length,
    spacing: p.modes.map((m) => Math.log(m.f / f0)), // relative mode ladder
    gains: p.modes.map((m) => m.g),
    logT60: p.modes.map((m) => Math.log(m.t60)),
    inharmonic: p.inharmonic,
    noiseBurstAmp: p.noiseBurstAmp,
    rattleAmp: p.rattleAmp,
    airThump: p.airThump ? 1 : 0,
  };
}

export function forceFingerprint(force) {
  const f = forceParams(force);
  return {
    impulse: f.impulse,
    noise: f.noise,
    rattle: f.rattle,
    t60Scale: f.t60Scale,
  };
}

function propDistance(a, b) {
  let d = 2.0 * Math.abs(a.nModes - b.nModes);
  const n = Math.min(a.spacing.length, b.spacing.length);
  for (let i = 1; i < n; i++) d += Math.abs(a.spacing[i] - b.spacing[i]);
  for (let i = 0; i < n; i++) {
    d += 0.5 * Math.abs(a.logT60[i] - b.logT60[i]);
    d += 0.5 * Math.abs(a.gains[i] - b.gains[i]);
  }
  d += 300 * Math.abs(a.inharmonic - b.inharmonic);
  d += 10 * Math.abs(a.noiseBurstAmp - b.noiseBurstAmp);
  d += 10 * Math.abs(a.rattleAmp - b.rattleAmp);
  d += 1.5 * Math.abs(a.airThump - b.airThump);
  return d;
}

function forceDistance(a, b) {
  return Math.abs(a.impulse - b.impulse)
    + Math.abs(a.noise - b.noise)
    + Math.abs(a.rattle - b.rattle)
    + 2 * Math.abs(a.t60Scale - b.t60Scale);
}

const PROPS = propList();
const FORCES = forceList();
const PROP_PRINTS = new Map(PROPS.map((p) => [p, propFingerprint(p)]));
const FORCE_PRINTS = new Map(FORCES.map((f) => [f, forceFingerprint(f)]));

// Reference class assignment for a synthesized query described by its
// physical parameters. `params` may carry performer-level variation; the
// reference answers which class the resulting object belongs to.
export function referenceClass(params) {
  // Reconstruct the query's prop fingerprint from its physical parameters.
  // performerSeed variation scales impulse/t60 mildly; pitchShift scales all
  // mode frequencies by a common factor, which the spacing ladder ignores.
  const p = propParams(params.prop);
  const f0 = p.modes[0].f;
  const q = {
    nModes: p.modes.length,
    spacing: p.modes.map((m) => Math.log(m.f / f0)),
    gains: p.modes.map((m) => m.g),
    logT60: p.modes.map((m) => Math.log(m.t60)),
    inharmonic: p.inharmonic,
    noiseBurstAmp: p.noiseBurstAmp,
    rattleAmp: p.rattleAmp,
    airThump: p.airThump ? 1 : 0,
  };
  let bestProp = null, bestD = Infinity;
  for (const prop of PROPS) {
    const d = propDistance(q, PROP_PRINTS.get(prop));
    if (d < bestD) { bestD = d; bestProp = prop; }
  }

  const fz = forceParams(params.force);
  const qf = {
    impulse: fz.impulse, noise: fz.noise, rattle: fz.rattle, t60Scale: fz.t60Scale,
  };
  let bestForce = null, bestFd = Infinity;
  for (const force of FORCES) {
    const d = forceDistance(qf, FORCE_PRINTS.get(force));
    if (d < bestFd) { bestFd = d; bestForce = force; }
  }
  return { prop: bestProp, force: bestForce, propMargin: bestD, forceMargin: bestFd };
}

// Cross-check the reference itself: for every main/holdout record of the
// manifest the reference must recover the recorded prop/force. If this
// fails, the reference — not the index — is broken, and no acceptance
// expectation may be trusted.
export function verifyReference(manifest) {
  const mismatches = [];
  for (const r of manifest.records) {
    if (r.kind === 'user') continue;
    const rc = referenceClass(r);
    if (rc.prop !== r.prop || rc.force !== r.force) {
      mismatches.push({ id: r.id, truth: { prop: r.prop, force: r.force }, reference: rc });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// Independent expectation for the loudness-statistic swap diagnostic.
//
// When the equalized loudness stats are wrongly used for the
// dynamics-preserved index, the loudness z-values dominate the weighted
// distance and the ranking degenerates to a loudness-subspace ordering.
// The expected first reversal is therefore derivable from the LOUDNESS
// SUBSPACE ALONE (3 keys, z-scaled by the corrupted stats) — no timbre
// keys, no block weights, no 17-dim ranking code from the retrieval system.
// `queries` carry { id, prop, rawFeatures, baselineTop1Prop }.
export function expectedSwapVictim(queries, indexRows, manifest, swappedStats) {
  const keys = swappedStats.keys;
  const z = (f) => keys.map((k, i) => (f[k] - swappedStats.mean[i]) / swappedStats.std[i]);
  const recById = new Map(manifest.records.map((r) => [r.id, r]));
  const rows = indexRows.map((row) => ({
    id: row.id,
    prop: recById.get(row.id)?.prop,
    z: z(row.raw.features),
  }));
  const predictions = [];
  for (const q of queries) {
    const qz = z(q.rawFeatures);
    let best = null, bestD = Infinity;
    for (const r of rows) {
      let d = 0;
      for (let i = 0; i < qz.length; i++) d += (qz[i] - r.z[i]) ** 2;
      if (d < bestD) { bestD = d; best = r; }
    }
    predictions.push({ query: q.id, prop: q.prop, loudnessNearest: best });
  }
  predictions.sort((a, b) => a.query.localeCompare(b.query));
  const first = predictions.find((p) => p.loudnessNearest
    && p.loudnessNearest.prop !== p.baselineTop1Prop);
  return {
    victim: first ? first.prop : null,
    firstQuery: first ? first.query : null,
    predictions: predictions.map((p) => ({
      query: p.query,
      prop: p.prop,
      loudnessNearest: { id: p.loudnessNearest?.id, prop: p.loudnessNearest?.prop },
    })),
  };
}
