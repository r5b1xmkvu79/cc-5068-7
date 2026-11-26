// Build the homemade short-audio corpus:
//   main grid   : 2 props x 2 forces x 3 take templates x 2 preamp gains = 24
//   controls    : pitch-shifted timbre matches, same-pitch different excitation
// A loudness-equalized twin of every clip is written under corpus_equalized.
// Filenames are neutral IDs only; ground truth lives in manifest.json.

import { mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WAV_DIR, CORPUS_RAW, CORPUS_EQ, MANIFEST, SR } from '../config.js';
import { synthesize, propList, forceList } from '../dsp/synth.js';
import { writeWav } from '../dsp/wav.js';
import { equalizeLoudness, rmsDb, peakDb } from '../dsp/loudness.js';

const TARGET_RMS_DB = -26;
const GAINS = [{ tag: 'lo', db: -12 }, { tag: 'hi', db: 6 }];

async function cleanDirs() {
  for (const d of [CORPUS_RAW, CORPUS_EQ]) {
    if (existsSync(d)) await rm(d, { recursive: true, force: true });
    await mkdir(d, { recursive: true });
  }
}

async function emit(rec, samples) {
  const raw = Buffer.from(writeWav(samples, SR, 16));
  await writeFile(path.join(CORPUS_RAW, rec.id + '.wav'), raw);
  const eq = equalizeLoudness(samples, TARGET_RMS_DB);
  const eqBuf = Buffer.from(writeWav(eq.samples, SR, 16));
  await writeFile(path.join(CORPUS_EQ, rec.id + '.wav'), eqBuf);
  rec.rawRmsDb = +rmsDb(samples).toFixed(2);
  rec.rawPeakDb = +peakDb(samples).toFixed(2);
  rec.eqRmsDb = +rmsDb(eq.samples).toFixed(2);
  rec.eqAppliedDb = +eq.gainDb.toFixed(2);
  rec.gainDb = rec.gainDb ?? 0;
}

export async function buildCorpus() {
  await cleanDirs();
  const records = [];
  let seed = 1000;
  const make = (id, group, meta) => {
    const { samples, sr } = synthesize({ seed: seed++, ...meta });
    const rec = {
      id,
      group,
      kind: meta.kind || 'main',
      prop: meta.prop,
      force: meta.force,
      take: meta.template ?? 0,
      gainTag: meta.gainTag ?? 'flat',
      gainDb: meta.gainDb ?? 0,
      pitchShift: meta.pitchShift ?? 0,
      excitation: meta.excitation ?? 'strike',
      duration: +(samples.length / sr).toFixed(3),
    };
    records.push(rec);
    return emit(rec, samples);
  };

  // Main grid. Source group = prop/force/take; gain variants stay in one group
  // so "same source, different preamp" never leaks across the split.
  for (const prop of propList()) {
    for (const force of forceList()) {
      for (let take = 0; take < 3; take++) {
        const group = `${prop}_${force}_t${take}`;
        for (const g of GAINS) {
          await make(`c_${group}_${g.tag}`, group, {
            prop, force, template: take,
            gainDb: g.db, gainTag: g.tag,
          });
        }
      }
    }
  }

  // Control A: same prop/force, shifted pitch -> timbre stays close, F0 changes.
  for (const prop of propList()) {
    const shift = prop === 'P1' ? 7 : 5;
    const group = `ctl_pitch_${prop}_heavy`;
    await make(`${group}`, group, {
      prop, force: 'heavy', template: 1, kind: 'control_pitch',
      pitchShift: shift, gainTag: 'flat',
    });
  }

  // Control B: same prop, near-identical F0 region, different excitation (rub vs strike).
  for (const prop of propList()) {
    const group = `ctl_rub_${prop}_light`;
    await make(`${group}`, group, {
      prop, force: 'light', template: 1, kind: 'control_excitation',
      excitation: 'rub', gainTag: 'flat',
    });
  }

  // One explicit "held-out" prop-like probe is NOT needed (groups are split at
  // eval time), but we keep a spare unseen take per prop/force for the UI check.
  for (const prop of propList()) {
    for (const force of forceList()) {
      const group = `holdout_${prop}_${force}`;
      await make(group, group, {
        prop, force, template: 4, kind: 'holdout',
        gainDb: -3, gainTag: 'flat',
      });
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    sampleRate: SR,
    targetRmsDb: TARGET_RMS_DB,
    count: records.length,
    groups: [...new Set(records.map((r) => r.group))],
    records,
  };
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2));

  // Also mirror files into data/wav for the static server (raw versions).
  await rm(WAV_DIR, { recursive: true, force: true });
  await mkdir(WAV_DIR, { recursive: true });
  for (const f of await readdir(CORPUS_RAW)) {
    const b = await readFile(path.join(CORPUS_RAW, f));
    await writeFile(path.join(WAV_DIR, f), b);
  }
  return manifest;
}

async function main() {
  const m = await buildCorpus();
  console.log(`corpus built: ${m.count} clips, ${m.groups.length} source groups`);
  console.log(`raw: ${CORPUS_RAW}`);
  console.log(`loudness-equalized: ${CORPUS_EQ}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
