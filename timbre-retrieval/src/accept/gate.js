// The acceptance gate (验收器). Runs the separated query set against a
// candidate index and PUBLISHES or REJECTS that index version.
//
// Evidence discipline:
//   - same-recording segments (裁片) prove duplicate retrieval only;
//   - timbre generalization may be proven by unseen-performer re-recordings
//     (重录) only — provenance is enforced at the SIGNAL level (waveform
//     correlation), so a swapped source registry fails even when it makes
//     the top-1 hit rate go UP;
//   - expected classes come from the independent physical reference
//     (accept/reference.js), never from the retrieval distance function.

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  QUERY_DIR, PUBLISH_DIR, INDEX_DIR, CORPUS_RAW, SR, LOUDNESS_KEYS,
} from '../config.js';
import { readWav, toMono } from '../dsp/wav.js';
import { resampleTo, trimSilence, equalizeLoudness } from '../dsp/loudness.js';
import { extractFeatures } from '../dsp/features.js';
import { searchExternal, externalVectors } from '../core/retrieve.js';
import { validateQuerySignal } from './validate.js';
import { referenceClass, verifyReference, expectedSwapVictim } from './reference.js';
import { checkIndexConsistency } from './consistency.js';
import { maxCorrelation } from './sigmatch.js';

// Same-recording provenance: a cut correlates with its source (~1.0 in this
// corpus); a genuine re-recording of the same class stays well below (<=0.8).
export const MATCH_CORR = 0.95;
export const PROVENANCE_CORR_MAX = 0.9;

const loadSamples = async (file) => {
  const wav = readWav(await readFile(file));
  return trimSilence(resampleTo(toMono(wav), wav.sampleRate), SR);
};

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex');

// Loudness stats with the two fitted sets exchanged — the classic
// wrong-cache bug the diagnostic must catch.
function withSwappedLoudnessStats(index) {
  const clone = structuredClone(index);
  [clone.stats.loudRaw, clone.stats.loudEq] = [clone.stats.loudEq, clone.stats.loudRaw];
  for (const row of clone.rows) {
    for (const [mode, stats] of [['raw', clone.stats.loudRaw], ['eq', clone.stats.loudEq]]) {
      row[mode].zLoud = LOUDNESS_KEYS
        .map((k) => row[mode].features[k])
        .map((v, i) => (v - stats.mean[i]) / stats.std[i]);
    }
  }
  return clone;
}

// Diagnostic: which instrument class's ranking reverses FIRST when the
// loudness statistics are wrongly swapped. Compares baseline vs tampered
// rankings for the generalization queries in dynamics-preserved mode.
export function diagnoseLoudnessSwap(index, manifest, queryVectors) {
  const recById = new Map(manifest.records.map((r) => [r.id, r]));
  const tampered = withSwappedLoudnessStats(index);
  const opts = { target: 'general', loudnessMode: 'raw', useLoudness: true };

  const perQuery = [];
  for (const q of queryVectors) {
    const base = searchExternal(index, q.id, q.vecs, opts).results;
    const tampVecs = externalVectors(tampered, q.featuresRaw, q.featuresEq);
    const tamp = searchExternal(tampered, q.id, tampVecs, opts).results;
    const baseTop = base[0];
    const tampTop = tamp[0];
    perQuery.push({
      query: q.id,
      prop: q.prop,
      baselineTop1: { id: baseTop.id, prop: recById.get(baseTop.id)?.prop, distance: baseTop.distance },
      tamperedTop1: { id: tampTop.id, prop: recById.get(tampTop.id)?.prop, distance: tampTop.distance },
      reversed: recById.get(baseTop.id)?.prop !== recById.get(tampTop.id)?.prop,
    });
  }
  perQuery.sort((a, b) => a.query.localeCompare(b.query));
  const first = perQuery.find((q) => q.reversed);
  return {
    firstReversedClass: first ? first.prop : null,
    firstReversedQuery: first ? first.query : null,
    perQuery,
  };
}

export async function runAcceptance({ index, manifest, queryset }) {
  const findings = [];
  const notes = [];
  const recById = new Map(manifest.records.map((r) => [r.id, r]));

  // ---- 0. the independent reference must be self-consistent ----
  const refCheck = verifyReference(manifest);
  if (!refCheck.ok) {
    findings.push({
      check: 'reference-self-check',
      detail: `${refCheck.mismatches.length} records misclassified by the reference`,
      evidence: refCheck.mismatches.slice(0, 5),
    });
  }

  // ---- 1. invalid inputs must be rejected ----
  const invalidReport = [];
  const usable = new Map(); // id -> { samples, meta }
  for (const q of queryset.queries) {
    const file = path.join(QUERY_DIR, q.file);
    const samples = await loadSamples(file);
    const v = validateQuerySignal(samples, SR);
    if (q.kind === 'invalid') {
      invalidReport.push({ id: q.id, rejected: !v.ok, reason: v.reason || null });
      if (v.ok) {
        findings.push({ check: 'invalid-input', detail: `${q.id} passed validation but is registered invalid` });
      }
      continue;
    }
    if (!v.ok) {
      findings.push({ check: 'invalid-input', detail: `${q.id} rejected: ${v.reason}` });
      continue;
    }
    usable.set(q.id, { samples, meta: q });
  }

  // ---- 2. duplicate files must be detected and de-counted ----
  const byHash = new Map();
  const duplicates = [];
  for (const [id] of usable) {
    const bytes = await readFile(path.join(QUERY_DIR, usable.get(id).meta.file));
    const h = sha1(bytes);
    if (byHash.has(h)) {
      duplicates.push({ id, duplicateOf: byHash.get(h) });
      usable.delete(id);
    } else {
      byHash.set(h, id);
    }
  }
  for (const d of duplicates) {
    notes.push(`duplicate file detected: ${d.id} == ${d.duplicateOf}; excluded from evidence`);
  }

  // ---- 3. feature vectors for every usable query (fitted stats reused) ----
  const queryData = new Map();
  for (const [id, u] of usable) {
    const eq = equalizeLoudness(u.samples, -26).samples;
    const fRaw = extractFeatures(u.samples, SR);
    const fEq = extractFeatures(eq, SR);
    queryData.set(id, {
      meta: u.meta,
      samples: u.samples,
      featuresRaw: fRaw.features,
      featuresEq: fEq.features,
      curves: fEq.curves,
      vecs: externalVectors(index, fRaw.features, fEq.features),
    });
  }

  // ---- 4. dedup evidence: same-recording segments ----
  const dedupEvidence = [];
  let dedupPass = 0;
  for (const entry of queryset.registry.dedup) {
    const qd = queryData.get(entry.query);
    if (!qd) {
      // duplicates removed above are noted, not failures
      if (duplicates.some((d) => d.id === entry.query)) continue;
      findings.push({ check: 'dedup', detail: `${entry.query}: query missing/invalid` });
      continue;
    }
    if (!entry.sourceRecording || !recById.has(entry.sourceRecording)) {
      findings.push({
        check: 'dedup',
        detail: `${entry.query}: registered source recording ${entry.sourceRecording} is not in the index`,
      });
      continue;
    }
    const srcGroup = recById.get(entry.sourceRecording).group;
    const out = searchExternal(index, entry.query, qd.vecs, { target: 'general', loudnessMode: 'eq' });
    const top = out.results[0];
    // signal-level proof the query really is a cut of the registered source
    const srcSamples = await loadSamples(path.join(CORPUS_RAW, entry.sourceRecording + '.wav'));
    const corr = maxCorrelation(qd.samples, srcSamples);
    // Retrieval evidence: the source group must surface at the top. Take-level
    // ordering inside one class is below the feature shift a tail cut causes,
    // so the bar is top-3, while the SAME-RECORDING proof is the correlation.
    const srcRank = out.results.findIndex((r) => r.group === srcGroup) + 1;
    const ok = srcRank > 0 && srcRank <= 3 && corr >= MATCH_CORR;
    if (ok) dedupPass++;
    else {
      findings.push({
        check: 'dedup',
        detail: `${entry.query}: source group ${srcGroup} ranks #${srcRank || '—'} (want <= 3), source correlation ${corr.toFixed(3)} (want >= ${MATCH_CORR})`,
      });
    }
    dedupEvidence.push({
      query: entry.query, sourceRecording: entry.sourceRecording,
      top1: { id: top.id, group: top.group, distance: top.distance },
      sourceGroupRank: srcRank,
      sourceCorrelation: +corr.toFixed(3), ok,
    });
  }

  // ---- 5. generalization evidence: unseen-performer re-recordings only ----
  const genEvidence = [];
  let genPass = 0, genTotal = 0, genTop1Hits = 0;
  const unseen = new Set(queryset.unseenPerformers || []);
  const genVectors = [];
  for (const entry of queryset.registry.generalization) {
    const qd = queryData.get(entry.query);
    if (!qd) {
      // duplicates removed above are noted, not failures
      if (duplicates.some((d) => d.id === entry.query)) continue;
      findings.push({ check: 'generalization', detail: `${entry.query}: query missing/invalid` });
      continue;
    }
    genTotal++;
    // Expected class comes from the query's OWN physical parameters via the
    // independent reference — never from what the registry claims.
    const expected = referenceClass(qd.meta);
    const out = searchExternal(index, entry.query, qd.vecs, { target: 'general', loudnessMode: 'eq' });
    const top = out.results[0];
    const topProp = recById.get(top.id)?.prop;
    const topForce = recById.get(top.id)?.force;
    if (topProp === expected.prop) genTop1Hits++;

    // provenance: an unseen performer, and NOT a cut of anything indexed
    if (!entry.performer || !unseen.has(entry.performer)) {
      findings.push({
        check: 'provenance',
        detail: `${entry.query}: performer ${entry.performer ?? '(none)'} is not a registered unseen performer — same-source material cannot prove generalization`,
      });
    }
    const corr = maxCorrelation(qd.samples, await loadSamples(path.join(CORPUS_RAW, top.id + '.wav')));
    if (corr >= PROVENANCE_CORR_MAX) {
      findings.push({
        check: 'provenance',
        detail: `${entry.query}: waveform correlation ${corr.toFixed(3)} with indexed ${top.id} — a same-recording segment cannot prove timbre generalization`,
      });
    }
    const ok = topProp === expected.prop && corr < PROVENANCE_CORR_MAX && unseen.has(entry.performer || '');
    if (ok) genPass++;
    genEvidence.push({
      query: entry.query, performer: entry.performer,
      expectedProp: expected.prop, expectedForce: expected.force,
      top1: { id: top.id, prop: topProp, force: topForce, distance: top.distance },
      top1Correlation: +corr.toFixed(3), ok,
    });
    genVectors.push({
      id: entry.query, prop: qd.meta.prop,
      vecs: qd.vecs, featuresRaw: qd.featuresRaw, featuresEq: qd.featuresEq,
    });
  }

  // ---- 6. hard negatives: similar envelope, different pitch ----
  const hardNegEvidence = [];
  let hardPass = 0, hardTotal = 0;
  for (const entry of queryset.registry.hardNegative) {
    const qd = queryData.get(entry.query);
    if (!qd) {
      findings.push({ check: 'hard-negative', detail: `${entry.query}: query missing/invalid` });
      continue;
    }
    hardTotal++;
    const expected = referenceClass(qd.meta);
    const out = searchExternal(index, entry.query, qd.vecs, { target: 'general', loudnessMode: 'eq' });
    const top = out.results[0];
    const topProp = recById.get(top.id)?.prop;
    const ok = topProp === expected.prop;
    if (ok) hardPass++;
    else {
      findings.push({
        check: 'hard-negative',
        detail: `${entry.query} (${entry.role}, pitchShift ${qd.meta.pitchShift}st): top-1 ${top.id} is ${topProp}, expected ${expected.prop} — pitch alone must not flip the class`,
      });
    }
    hardNegEvidence.push({
      query: entry.query, role: entry.role, pitchShift: qd.meta.pitchShift,
      expectedProp: expected.prop,
      top1: { id: top.id, prop: topProp, distance: top.distance }, ok,
    });
  }

  // ---- 7. loudness-stat swap diagnostic ----
  const swapDiag = diagnoseLoudnessSwap(index, manifest, genVectors);
  const basePropByQuery = new Map(swapDiag.perQuery.map((q) => [q.query, q.baselineTop1.prop]));
  const swapExpected = expectedSwapVictim(
    genVectors.map((g) => ({
      id: g.id, prop: g.prop, rawFeatures: g.featuresRaw,
      baselineTop1Prop: basePropByQuery.get(g.id),
    })),
    index.rows, manifest, index.stats.loudEq,
  );
  if (swapDiag.firstReversedClass && swapExpected.victim
    && swapDiag.firstReversedClass !== swapExpected.victim) {
    findings.push({
      check: 'loudness-swap-diagnostic',
      detail: `diagnostic names ${swapDiag.firstReversedClass} but independent loudness analysis expects ${swapExpected.victim}`,
    });
  }

  // ---- 8. index consistency ----
  const consistency = checkIndexConsistency(index, manifest);
  for (const p of consistency.problems) {
    findings.push({ check: `index-${p.check}`, detail: p.detail });
  }

  // ---- metrics + decision ----
  const metrics = {
    dedup: { n: dedupEvidence.length, pass: dedupPass },
    generalization: {
      n: genTotal, pass: genPass,
      top1: genTotal ? +(genTop1Hits / genTotal).toFixed(3) : 0,
    },
    hardNegative: { n: hardTotal, pass: hardPass },
    invalid: { n: invalidReport.length, rejected: invalidReport.filter((r) => r.rejected).length },
    duplicates: { n: duplicates.length, detected: duplicates.length },
  };
  const publish = findings.length === 0
    && dedupEvidence.length > 0 && dedupPass === dedupEvidence.length
    && genTotal > 0 && genPass === genTotal
    && hardTotal > 0 && hardPass === hardTotal;

  return {
    generatedAt: new Date().toISOString(),
    publish,
    findings,
    notes,
    metrics,
    evidence: {
      dedup: dedupEvidence,
      generalization: genEvidence,
      hardNegative: hardNegEvidence,
      invalid: invalidReport,
      duplicates,
    },
    loudnessSwap: { ...swapDiag, independentExpectation: swapExpected },
    consistency,
  };
}

// Publish or reject the candidate index version. Publication copies the
// exact index bytes plus the evidence report; rejection removes any stale
// published index so a rejected version can never be served as current.
export async function decidePublish(report) {
  await mkdir(PUBLISH_DIR, { recursive: true });
  const decision = {
    decision: report.publish ? 'published' : 'rejected',
    at: report.generatedAt,
    reasons: report.findings.map((f) => `${f.check}: ${f.detail}`),
    metrics: report.metrics,
  };
  if (report.publish) {
    await copyFile(path.join(INDEX_DIR, 'index.json'), path.join(PUBLISH_DIR, 'index.json'));
    await writeFile(path.join(PUBLISH_DIR, 'report.json'), JSON.stringify(report, null, 2));
  } else {
    await rm(path.join(PUBLISH_DIR, 'index.json'), { force: true });
    await rm(path.join(PUBLISH_DIR, 'report.json'), { force: true });
  }
  await writeFile(path.join(PUBLISH_DIR, 'decision.json'), JSON.stringify(decision, null, 2));
  return decision;
}

// Test helper: return the queryset with the two source registries exchanged.
// Wrong grouping must fail the publish assertions even where it raises the
// top-1 hit rate.
export function swapRegistries(queryset) {
  const clone = structuredClone(queryset);
  [clone.registry.dedup, clone.registry.generalization] = [
    clone.registry.generalization, clone.registry.dedup,
  ];
  return clone;
}
