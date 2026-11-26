// Modal-synthesis of door-impact-like sounds. This stands in for homemade
// short recordings: every signal is generated here, then written as WAV.
//
// Two physical props (P1 = hollow wooden panel, P2 = metal fire door),
// two action forces (light tap / heavy slam), repeated templates, and two
// preamp gains (the gain difference must be separated from timbre later).

import { SR } from '../config.js';

// Per-prop deterministic physical settings. Filenames stay neutral; the
// words "wood/metal" never appear in file names or the retrieval UI.
const PROPS = {
  P1: {
    // hollow panel: lower, inharmonic, shorter woody modes + air thump
    modes: [
      { f: 92,  g: 1.00, t60: 0.18 },
      { f: 168, g: 0.72, t60: 0.14 },
      { f: 305, g: 0.42, t60: 0.10 },
      { f: 512, g: 0.24, t60: 0.07 },
      { f: 880, g: 0.12, t60: 0.045 },
      { f: 1450, g: 0.06, t60: 0.03 },
    ],
    inharmonic: 0.008,
    noiseBurstAmp: 0.10,
    rattleAmp: 0.05,
    airThump: true,
  },
  P2: {
    // metal door: brighter, near-harmonic long ringing + high shimmer
    modes: [
      { f: 210, g: 1.00, t60: 0.55 },
      { f: 425, g: 0.65, t60: 0.48 },
      { f: 648, g: 0.48, t60: 0.40 },
      { f: 905, g: 0.34, t60: 0.33 },
      { f: 1320, g: 0.22, t60: 0.26 },
      { f: 1900, g: 0.14, t60: 0.18 },
      { f: 2650, g: 0.08, t60: 0.12 },
    ],
    inharmonic: 0.0012,
    noiseBurstAmp: 0.05,
    rattleAmp: 0.14,
    airThump: false,
  },
};

const FORCE = {
  light: { impulse: 0.55, noise: 0.45, rattle: 0.25, t60Scale: 0.8, onsetJitter: 0.004 },
  heavy: { impulse: 1.25, noise: 1.0, rattle: 1.0, t60Scale: 1.15, onsetJitter: 0.001 },
};

// Mulberry32 deterministic RNG so the corpus is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// One rendered impact. options: { prop, force, template, gainDb, pitchShift, excitation, seed }
export function synthesize(options) {
  const {
    prop, force, template = 0, gainDb = 0,
    pitchShift = 0, excitation = 'strike', seed = 1,
  } = options;
  const cfg = PROPS[prop];
  const fz = FORCE[force];
  const rand = rng(seed);
  const dur = force === 'heavy' ? 1.15 : 0.9;
  const n = Math.floor(SR * dur);
  const out = new Float64Array(n);
  const t0 = 0.02 + rand() * fz.onsetJitter;
  const n0 = Math.floor(t0 * SR);
  const pitchMul = 2 ** (pitchShift / 12);

  // Per-template physical jitter (same object, repeated take).
  const jitter = (v) => v * (1 + (rand() - 0.5) * 0.06 + (template - 1) * 0.012);

  // Modal ring: exponentially decaying sinusoids with slight frequency mistuning.
  for (const m of cfg.modes) {
    const f = jitter(m.f) * pitchMul * (1 + cfg.inharmonic * (m.f / 100) ** 2);
    const t60 = m.t60 * fz.t60Scale * (0.9 + rand() * 0.2);
    const amp = m.g * fz.impulse * (0.85 + rand() * 0.3);
    const phase = rand() * 2 * Math.PI;
    const alpha = -Math.log(1000) / t60; // amplitude decay to -60 dB
    for (let i = n0; i < n; i++) {
      const t = (i - n0) / SR;
      out[i] += amp * Math.exp(alpha * t) * Math.sin(2 * Math.PI * f * t + phase);
    }
  }

  // Air thump (low-frequency puff) for the hollow panel.
  if (cfg.airThump) {
    const f = 58 * pitchMul;
    const alpha = -Math.log(1000) / 0.12;
    for (let i = n0; i < n; i++) {
      const t = (i - n0) / SR;
      out[i] += 0.5 * fz.impulse * Math.exp(alpha * t) * Math.sin(2 * Math.PI * f * t);
    }
  }

  // Contact noise burst (broadband, very short).
  const burstLen = Math.floor(SR * (force === 'heavy' ? 0.025 : 0.012));
  for (let i = 0; i < burstLen && n0 + i < n; i++) {
    const t = i / burstLen;
    const env = Math.exp(-t * 9);
    out[n0 + i] += cfg.noiseBurstAmp * fz.noise * env * gaussian(rand);
  }

  // Loose-component rattle: delayed sparse impulses (strong on metal door / heavy).
  const rattleCount = force === 'heavy' ? 9 : 3;
  for (let k = 0; k < rattleCount; k++) {
    const rt = 0.03 + rand() * (force === 'heavy' ? 0.25 : 0.1);
    const ri = n0 + Math.floor(rt * SR);
    const rlen = Math.floor(SR * 0.008);
    const ramp = cfg.rattleAmp * fz.rattle * (0.4 + rand() * 0.8);
    for (let i = 0; i < rlen && ri + i < n; i++) {
      out[ri + i] += ramp * Math.exp(-i / rlen * 6) * gaussian(rand);
    }
  }

  // Alternative excitation: fingertips/bowed contact -> softer, noisier, smeared onset.
  // The prop's own modes still ring (so object identity is recoverable), but the
  // sharp transient is replaced by a shaped friction swell.
  if (excitation === 'rub') {
    const rubLen = Math.floor(SR * 0.22);
    for (let i = 0; i < rubLen && n0 + i < n; i++) {
      const env = Math.sin(Math.PI * i / rubLen);
      // attenuate the strike-burst region rather than overwrite the modal ring
      out[n0 + i] = out[n0 + i] * (0.55 + 0.45 * env) + 0.22 * env * gaussian(rand);
    }
  }

  // Constant low-level self-noise so "gain" is distinguishable from silence.
  const noiseFloor = 0.0009;
  for (let i = 0; i < n; i++) out[i] += noiseFloor * gaussian(rand);

  // Preamp gain stage (the variable the index must sometimes remove).
  const g = 10 ** (gainDb / 20);
  for (let i = 0; i < n; i++) out[i] *= g;

  // Soft clip emulation of the preamp (gentle; strong non-linearity would
  // itself become a timbral cue and defeat the gain-isolation experiment).
  for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i]) ;

  return { samples: out, sr: SR };
}

export function propList() { return Object.keys(PROPS); }
export function forceList() { return Object.keys(FORCE); }
