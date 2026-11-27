// Acceptance query set — built SEPARATELY from the index.
//
//   segment     裁片: a time slice cut from an indexed recording (same seed
//               re-render). Evidence for duplicate/near-duplicate retrieval
//               ONLY — a cut of a recording the index already holds can never
//               prove timbre generalization.
//   rerecord    重录: the same prop/force rendered with an unseen performer's
//               seed. The ONLY valid evidence for timbre generalization.
//   hardneg     synthesizable hard negatives: similar envelope, different
//               pitch. Positive: shifted but same class must still win.
//               Negative: shifted INTO the other class's pitch region; the
//               true class must still win (pitch alone must not flip it).
//   invalid     silence / DC / clipped / tiny signals the gate must reject.
//   duplicate   byte-identical copies the gate must detect and de-count.
//
// The two SOURCE REGISTRIES (dedup / generalization) record what each query
// is evidence FOR. Swapping them must make publication impossible (see the
// gate's provenance assertions and test/gate.test.js).

import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { QUERY_DIR, QUERYSET, MANIFEST, SR } from '../config.js';
import { synthesize } from '../dsp/synth.js';
import { writeWav } from '../dsp/wav.js';

// Unseen performers: their seeds never appear in the indexed corpus.
export const UNSEEN_PERFORMERS = ['U1', 'U2'];
const PERFORMER_SEED = { U1: 7003, U2: 7006 };

// Segment sources: a spread of main-grid clips across both classes.
const SEGMENT_SOURCES = [
  'c_P1_light_t0_hi', 'c_P2_heavy_t1_lo', 'c_P1_heavy_t2_hi', 'c_P2_light_t0_lo',
];
const SEGMENT_FRACTION = 0.9; // leading share of the source recording kept

// Hard-negative pitch shifts (semitones). Positive: moderate shift, class
// must survive. Negative: shifted into the OTHER class's pitch region.
const HARDNEG = [
  { id: 'q_hnpos_P1', prop: 'P1', force: 'heavy', pitchShift: 5, role: 'positive', performer: 'U1' },
  { id: 'q_hnpos_P2', prop: 'P2', force: 'light', pitchShift: -5, role: 'positive', performer: 'U2' },
  { id: 'q_hnneg_P1', prop: 'P1', force: 'heavy', pitchShift: 14, role: 'negative', performer: 'U1' },
  { id: 'q_hnneg_P2', prop: 'P2', force: 'heavy', pitchShift: -14, role: 'negative', performer: 'U2' },
];

// Re-recordings: unseen performers, gains spread so the loudness-swap
// diagnostic has something to bite on.
const RERECORDS = [
  { performer: 'U1', prop: 'P1', force: 'light', gainDb: -9 },
  { performer: 'U1', prop: 'P1', force: 'heavy', gainDb: 3 },
  { performer: 'U1', prop: 'P2', force: 'light', gainDb: 0 },
  { performer: 'U1', prop: 'P2', force: 'heavy', gainDb: 6 },
  { performer: 'U2', prop: 'P1', force: 'light', gainDb: 6 },
  { performer: 'U2', prop: 'P1', force: 'heavy', gainDb: -12 },
  { performer: 'U2', prop: 'P2', force: 'light', gainDb: 3 },
  { performer: 'U2', prop: 'P2', force: 'heavy', gainDb: -9 },
];

async function emit(id, samples) {
  await writeFile(path.join(QUERY_DIR, id + '.wav'), Buffer.from(writeWav(samples, SR, 16)));
}

export async function buildQuerySet() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const recById = new Map(manifest.records.map((r) => [r.id, r]));
  await rm(QUERY_DIR, { recursive: true, force: true });
  await mkdir(QUERY_DIR, { recursive: true });

  const queries = [];
  const registry = { dedup: [], generalization: [], hardNegative: [] };
  let seed = 9000;

  // ---- segments (裁片): re-render the source recording, cut a slice ----
  for (const srcId of SEGMENT_SOURCES) {
    const rec = recById.get(srcId);
    if (!rec) throw new Error(`segment source ${srcId} not in manifest`);
    const { samples } = synthesize({
      seed: rec.seed, prop: rec.prop, force: rec.force, template: rec.take,
      gainDb: rec.gainDb, pitchShift: rec.pitchShift, excitation: rec.excitation,
    });
    const cut = samples.subarray(0, Math.floor(samples.length * SEGMENT_FRACTION));
    const id = `q_seg_${srcId}`;
    await emit(id, cut);
    queries.push({
      id, kind: 'segment', file: id + '.wav',
      sourceRecording: srcId, cropFraction: SEGMENT_FRACTION,
      prop: rec.prop, force: rec.force,
    });
    registry.dedup.push({ query: id, sourceRecording: srcId });
  }

  // ---- re-recordings (重录): unseen performers ----
  for (const rr of RERECORDS) {
    const id = `q_rr_${rr.prop}_${rr.force}_${rr.performer}`;
    const { samples } = synthesize({
      seed: seed++, prop: rr.prop, force: rr.force, template: 2,
      gainDb: rr.gainDb, performerSeed: PERFORMER_SEED[rr.performer],
    });
    await emit(id, samples);
    queries.push({
      id, kind: 'rerecord', file: id + '.wav',
      performer: rr.performer, prop: rr.prop, force: rr.force, gainDb: rr.gainDb,
    });
    registry.generalization.push({
      query: id, performer: rr.performer, prop: rr.prop, force: rr.force,
    });
  }

  // ---- hard negatives (相似包络、不同音高的正反例) ----
  for (const hn of HARDNEG) {
    const { samples } = synthesize({
      seed: seed++, prop: hn.prop, force: hn.force, template: 2,
      pitchShift: hn.pitchShift, gainDb: 0,
      performerSeed: PERFORMER_SEED[hn.performer],
    });
    await emit(hn.id, samples);
    queries.push({
      id: hn.id, kind: `hardneg_${hn.role}`, file: hn.id + '.wav',
      performer: hn.performer, prop: hn.prop, force: hn.force,
      pitchShift: hn.pitchShift, gainDb: 0,
    });
    registry.hardNegative.push({
      query: hn.id, role: hn.role, prop: hn.prop, force: hn.force,
    });
  }

  // ---- invalid inputs ----
  const n = Math.floor(0.5 * SR);
  const invalids = {
    q_inv_silence: new Float64Array(n).fill(1e-6),
    q_inv_dc: new Float64Array(n).fill(0.3),
    q_inv_clipped: (() => {
      const x = new Float64Array(n);
      let s = 12345;
      for (let i = 0; i < n; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        x[i] = Math.max(-1, Math.min(1, ((s / 0x7fffffff) * 2 - 1) * 8));
      }
      return x;
    })(),
    q_inv_tiny: new Float64Array(32).fill(0.2),
  };
  for (const [id, samples] of Object.entries(invalids)) {
    await emit(id, samples);
    queries.push({ id, kind: 'invalid', file: id + '.wav' });
  }

  // ---- duplicate files: byte-identical copy of a rerecord ----
  const dupSrc = 'q_rr_P1_light_U1';
  const dupBytes = await readFile(path.join(QUERY_DIR, dupSrc + '.wav'));
  await writeFile(path.join(QUERY_DIR, 'q_dup_b.wav'), dupBytes);
  queries.push({
    id: 'q_dup_b', kind: 'duplicate', file: 'q_dup_b.wav', duplicateOf: dupSrc,
    performer: 'U1', prop: 'P1', force: 'light',
  });
  // The duplicate is deliberately registered as generalization evidence: the
  // gate must detect the byte-identity and refuse to count it twice.
  registry.generalization.push({
    query: 'q_dup_b', performer: 'U1', prop: 'P1', force: 'light',
  });

  const queryset = {
    createdAt: new Date().toISOString(),
    sampleRate: SR,
    unseenPerformers: UNSEEN_PERFORMERS,
    note: 'Query set is disjoint from the index. Segments prove duplicate retrieval only; generalization may be proven by unseen-performer re-recordings only.',
    queries,
    registry,
  };
  await writeFile(QUERYSET, JSON.stringify(queryset, null, 2));
  return queryset;
}
