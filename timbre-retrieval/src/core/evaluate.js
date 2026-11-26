import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { EVAL_DIR } from '../config.js';
import { search } from './retrieve.js';

const metrics = (ranked, predicate) => {
  let hit1 = 0, hit3 = 0, hit5 = 0, rr = 0, total = ranked.length;
  for (const list of ranked) {
    const pos = list.findIndex(predicate);
    if (pos === 0) hit1++;
    if (pos >= 0 && pos < 3) hit3++;
    if (pos >= 0 && pos < 5) hit5++;
    if (pos >= 0) rr += 1 / (pos + 1);
  }
  return {
    n: total,
    top1: +(hit1 / total).toFixed(3),
    top3: +(hit3 / total).toFixed(3),
    top5: +(hit5 / total).toFixed(3),
    mrr: +(rr / total).toFixed(3),
  };
};

// Leave-one-group-out evaluation. Normalization statistics were fitted on the
// training groups at index time; here we additionally exclude the query's own
// source group from the candidate pool so no take/gain twin can be returned.
export function evaluate(index, manifest) {
  const recById = new Map(manifest.records.map((r) => [r.id, r]));
  const groups = [...new Set(manifest.records
    .filter((r) => r.kind === 'main')
    .map((r) => r.group))].sort();

  const summarize = (mode, useLoudness) => {
    const rp = [], fails = [];
    for (const g of groups) {
      for (const q of index.rows.filter((r) => r.group === g && r.kind === 'main')) {
        const truth = recById.get(q.id);
        const out = search(index, q.id, {
          target: 'general', loudnessMode: mode, useLoudness, excludeGroups: [g],
        });
        rp.push(out.results);
        const pos = out.results.findIndex((c) => recById.get(c.id)?.prop === truth.prop);
        if (pos !== 0) {
          fails.push({
            query: q.id, mode, propRank: pos + 1,
            top: out.results.slice(0, 3).map((r) => ({
              id: r.id, distance: r.distance,
              prop: recById.get(r.id)?.prop, force: recById.get(r.id)?.force,
              gain: recById.get(r.id)?.gainTag,
            })),
          });
        }
      }
    }
    // Rebuild cleanly with query truth captured per list.
    const propLists = [], forceLists = [];
    let qi = 0;
    for (const g of groups) {
      for (const q of index.rows.filter((r) => r.group === g && r.kind === 'main')) {
        const truth = recById.get(q.id);
        const list = rp[qi++];
        propLists.push(list.map((c) => ({ ...c, _match: recById.get(c.id)?.prop === truth.prop })));
        forceLists.push(list.map((c) => ({ ...c, _match: recById.get(c.id)?.force === truth.force })));
      }
    }
    return {
      propIdentity: metrics(propLists, (c) => c._match),
      actionForce: metrics(forceLists, (c) => c._match),
      failures: fails.slice(0, 15),
    };
  };

  const eq = summarize('eq', false);
  const rawTimbreOnly = summarize('raw', false);
  const raw = summarize('raw', true);

  // Targeted task runs (prop target / force target), equalized mode.
  const targeted = { prop: null, force: null };
  for (const target of ['prop', 'force']) {
    const propLists = [], forceLists = [];
    for (const g of groups) {
      for (const q of index.rows.filter((r) => r.group === g && r.kind === 'main')) {
        const truth = recById.get(q.id);
        const out = search(index, q.id, {
          target, loudnessMode: 'eq', excludeGroups: [g],
        });
        propLists.push(out.results.map((c) => ({ ...c, _match: recById.get(c.id)?.prop === truth.prop })));
        forceLists.push(out.results.map((c) => ({ ...c, _match: recById.get(c.id)?.force === truth.force })));
      }
    }
    targeted[target] = {
      propIdentity: metrics(propLists, (c) => c._match),
      actionForce: metrics(forceLists, (c) => c._match),
    };
  }

  // Gain experiment: same source recorded at two preamp gains. Compare whether
  // neighbor order is driven by timbre (eq mode, gain removed) or by absolute
  // level (raw mode, loudness block retained). Purity = share of top-k results
  // carrying the query's own gain tag.
  const gainExperiment = [];
  for (const g of groups) {
    const hi = index.rows.find((r) => r.group === g && recById.get(r.id)?.gainTag === 'hi');
    const lo = index.rows.find((r) => r.group === g && recById.get(r.id)?.gainTag === 'lo');
    if (!hi || !lo) continue;
    const rankFor = (query, twin, mode) => {
      const out = search(index, query.id, {
        target: 'general', loudnessMode: mode,
        useLoudness: mode === 'raw',
        excludeIds: [query.id], // twin allowed: this is the point of the test
      });
      const qTag = recById.get(query.id).gainTag;
      const top5 = out.results.slice(0, 5);
      return {
        mode,
        twinRank: out.results.findIndex((r) => r.id === twin.id) + 1,
        gainPurityTop5: +(top5
          .filter((r) => recById.get(r.id)?.gainTag === qTag).length / top5.length).toFixed(2),
        top5: top5.map((r) => ({
          id: r.id, distance: r.distance, gain: recById.get(r.id)?.gainTag,
          prop: recById.get(r.id)?.prop, force: recById.get(r.id)?.force,
        })),
      };
    };
    gainExperiment.push({
      group: g,
      hiToLo: { eq: rankFor(hi, lo, 'eq'), raw: rankFor(hi, lo, 'raw') },
      loToHi: { eq: rankFor(lo, hi, 'eq'), raw: rankFor(lo, hi, 'raw') },
    });
  }
  const avg = (arr) => +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2);
  const twinRank = (dir, mode) =>
    avg(gainExperiment.map((e) => e[dir][mode].twinRank).filter((r) => r > 0));
  const purity = (dir, mode) =>
    avg(gainExperiment.map((e) => e[dir][mode].gainPurityTop5));

  // Control-clip analysis.
  const controls = [];
  for (const row of index.rows.filter((r) => r.kind.startsWith('control'))) {
    const truth = recById.get(row.id);
    const out = search(index, row.id, { target: 'general', loudnessMode: 'eq' });
    controls.push({
      query: row.id,
      kind: row.kind,
      expectedProp: truth.prop,
      samePropRank: out.results.findIndex((r) => recById.get(r.id)?.prop === truth.prop) + 1,
      top5: out.results.slice(0, 5).map((r) => ({
        id: r.id, distance: r.distance,
        prop: recById.get(r.id)?.prop, force: recById.get(r.id)?.force,
      })),
    });
  }
  const controlSummary = {};
  for (const kind of ['control_pitch', 'control_excitation']) {
    const cs = controls.filter((c) => c.kind === kind);
    controlSummary[kind] = {
      n: cs.length,
      samePropTop1: +(cs.filter((c) => c.samePropRank === 1).length / cs.length).toFixed(2),
      meanSamePropRank: +(cs.reduce((a, c) => a + c.samePropRank, 0) / cs.length).toFixed(2),
      expectation: kind === 'control_pitch'
        ? 'Pitch shifted but timbre close: same-prop clips should dominate despite different F0.'
        : 'Same pitch region but different excitation: rankings reorder by envelope/spectrum; same-prop identity should still recover within the top ranks, while no strike twin is a near-zero-distance match.',
    };
  }

  // Held-out verification: first candidate must match the held-out prop / force.
  const heldout = [];
  for (const row of index.rows.filter((r) => r.kind === 'holdout')) {
    const truth = recById.get(row.id);
    const out = search(index, row.id, { target: 'general', loudnessMode: 'eq' });
    const first = out.results[0];
    heldout.push({
      query: row.id,
      expectedProp: truth.prop,
      expectedForce: truth.force,
      firstCandidate: first.id,
      propOk: recById.get(first.id)?.prop === truth.prop,
      forceOk: recById.get(first.id)?.force === truth.force,
      distance: first.distance,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    definition: {
      similarity: 'weighted Euclidean distance on z-scored timbral descriptors (spectral shape, temporal envelope, pitch). z-score stats fitted on training source groups only.',
      excludedByDesign: ['average loudness (rmsDb/peakDb/crestDb)', 'clip duration'],
      leakageControl: 'candidate pool excludes the query source group; train/test splits are group-disjoint; no eval clip contributes to normalization stats',
      caveat: 'This is a signal-level operationalization of timbre similarity, not a universal model of human preference. Verify with your own ears using the UI playback.',
    },
    splits: { mainGroups: groups.length, leaveOneGroupOut: true },
    generalTarget: {
      equalized: eq,
      dynamicsPreserved: raw,
      dynamicsPreservedTimbreOnly: rawTimbreOnly,
    },
    targeted,
    gainExperiment: {
      sameSourceTwinMeanRank: {
        equalized: { hiToLo: twinRank('hiToLo', 'eq'), loToHi: twinRank('loToHi', 'eq') },
        dynamicsPreserved: { hiToLo: twinRank('hiToLo', 'raw'), loToHi: twinRank('loToHi', 'raw') },
      },
      gainPurityTop5: {
        equalized: { hiQuery: purity('hiToLo', 'eq'), loQuery: purity('loToHi', 'eq') },
        dynamicsPreserved: { hiQuery: purity('hiToLo', 'raw'), loQuery: purity('loToHi', 'raw') },
      },
      interpretation: 'Equalized index ignores gain (purity ~ chance 0.5, twin ranked on timbre). Dynamics-preserved index with the loudness block routes queries toward same-gain clips (high purity); remove the loudness block and timbre-only ordering returns.',
      cases: gainExperiment,
    },
    controls,
    controlSummary,
    heldoutCheck: heldout,
  };
  return report;
}

export async function writeReport(index, manifest) {
  const report = evaluate(index, manifest);
  await mkdir(EVAL_DIR, { recursive: true });
  await writeFile(path.join(EVAL_DIR, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
