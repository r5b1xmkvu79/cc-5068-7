// Door-sound replacement. No ffmpeg is available in this environment, so the
// deliverable is a ready-to-mix replacement WAV: the retrieved candidate is
// rendered at the original door event's timeline positions, and a small
// browser "film" (web/door-scene.js) plays picture + replacement track.
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { REPLACE_DIR, CORPUS_EQ, CORPUS_RAW, SR } from '../config.js';
import { readWav, toMono, writeWav } from '../dsp/wav.js';
import { resampleTo, trimSilence, rmsDb, equalizeLoudness } from '../dsp/loudness.js';
import { search } from './retrieve.js';

async function load(file, equalized) {
  const wav = readWav(await readFile(file));
  let x = trimSilence(resampleTo(toMono(wav), wav.sampleRate), SR);
  if (!equalized) {
    // Match the event's original average loudness so the swap sits in the mix.
    x = equalizeLoudness(x, -26).samples;
  }
  return x;
}

// events: [{ t: seconds, queryId }] on a virtual timeline of totalSeconds.
export async function buildReplacement(index, events, opts = {}) {
  const {
    target = 'general',
    loudnessMode = 'eq',
    excludeGroups = [],
    totalSeconds = Math.ceil(events.reduce((m, e) => Math.max(m, e.t), 0)) + 2,
  } = opts;
  const mix = new Float64Array(Math.floor(totalSeconds * SR));
  const placements = [];
  for (const ev of events) {
    const out = search(index, ev.queryId, { target, loudnessMode, excludeGroups });
    const cand = out.results[0];
    const dir = loudnessMode === 'raw' ? CORPUS_RAW : CORPUS_EQ;
    const clip = await load(path.join(dir, cand.id + '.wav'), loudnessMode === 'eq');
    const pos = Math.floor(ev.t * SR);
    const n = Math.min(clip.length, mix.length - pos);
    for (let i = 0; i < n; i++) mix[pos + i] += clip[i];
    placements.push({
      eventTime: ev.t,
      query: ev.queryId,
      replacement: cand.id,
      distance: cand.distance,
      similarity: cand.similarity,
    });
  }
  // Safety limiter against summed clipping.
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.97) {
    const g = 0.97 / peak;
    for (let i = 0; i < mix.length; i++) mix[i] *= g;
  }
  await mkdir(REPLACE_DIR, { recursive: true });
  const file = path.join(REPLACE_DIR, 'door_replacement.wav');
  await writeFile(file, Buffer.from(writeWav(mix, SR, 16)));
  const summary = {
    file,
    sampleRate: SR,
    durationSec: totalSeconds,
    mixRmsDb: +rmsDb(mix).toFixed(2),
    placements,
  };
  await writeFile(path.join(REPLACE_DIR, 'placements.json'), JSON.stringify(summary, null, 2));
  return summary;
}
