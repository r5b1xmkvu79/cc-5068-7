// Validation of query signals at the system boundary. Anything the acceptance
// gate or the import endpoint ingests must pass these checks; the reason
// strings are surfaced to the UI / acceptance report verbatim.

const MIN_SAMPLES = 512;          // ~23 ms at 22.05 kHz: shortest analyzable clip
const SILENCE_DB = -60;           // below this there is no signal to describe
const MIN_CREST_DB = 6;           // an impact sound has a clear transient
const MAX_CLIP_FRAC = 0.1;        // >10% of samples at full scale = clipped

export function validateQuerySignal(x, sr) {
  if (!x || x.length === 0) return { ok: false, reason: 'empty signal' };
  if (x.length < MIN_SAMPLES) {
    return { ok: false, reason: `too short: ${x.length} samples (< ${MIN_SAMPLES})` };
  }
  let sum = 0, peak = 0, clipped = 0;
  for (const v of x) {
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.98) clipped++;
  }
  const rms = Math.sqrt(sum / x.length);
  const rmsDb = 20 * Math.log10(rms + 1e-12);
  if (rmsDb < SILENCE_DB) return { ok: false, reason: `near-silence (${rmsDb.toFixed(1)} dB RMS)` };
  const peakDb = 20 * Math.log10(peak + 1e-12);
  const crestDb = peakDb - rmsDb;
  if (crestDb < MIN_CREST_DB) {
    return { ok: false, reason: `no transient (crest ${crestDb.toFixed(1)} dB < ${MIN_CREST_DB} dB): DC, steady tone or noise floor` };
  }
  if (clipped / x.length > MAX_CLIP_FRAC) {
    return { ok: false, reason: `clipped: ${(100 * clipped / x.length).toFixed(1)}% of samples at full scale` };
  }
  return { ok: true, rmsDb: +rmsDb.toFixed(2), crestDb: +crestDb.toFixed(2), samples: x.length, sampleRate: sr };
}
