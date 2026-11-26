import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
export const DATA = resolve(ROOT, 'data');
export const WAV_DIR = resolve(DATA, 'wav');
export const CORPUS_RAW = resolve(DATA, 'corpus_raw');
export const CORPUS_EQ = resolve(DATA, 'corpus_equalized');
export const INDEX_DIR = resolve(DATA, 'index');
export const EVAL_DIR = resolve(DATA, 'evaluation');
export const REPLACE_DIR = resolve(DATA, 'replacement');
export const MANIFEST = resolve(DATA, 'manifest.json');
export const PORT = Number(process.env.PORT || 8123);

export const SR = 22050;
export const NFFT = 1024;
export const HOP = 256;

// Feature keys, grouped by the perceptual attribute they describe.
export const SPECTRAL_KEYS = [
  'specCentroid', 'specBandwidth', 'specRolloff85', 'specFlatness',
  'specSkew', 'specKurt', 'specHfRatio', 'lowMidRatio',
];
export const ENVELOPE_KEYS = [
  'attackTime', 'decayTau', 'envFlatness', 'envSustain',
  'transientRatio', 'onsetSlope',
];
export const PITCH_KEYS = ['f0', 'f0Confidence', 'inharmonicity'];
export const LOUDNESS_KEYS = ['rmsDb', 'peakDb', 'crestDb'];
export const DURATION_KEYS = ['duration'];

// Timbral feature block used for similarity (loudness / duration deliberately excluded).
export const TIMBRE_KEYS = [...SPECTRAL_KEYS, ...ENVELOPE_KEYS, ...PITCH_KEYS];

// Retrival target: which attribute block the user is asking about.
// prop     -> who/what object made the sound  (spectrum + mode/pitch signature dominate)
// force    -> light touch vs heavy slam        (transient/envelope contrast dominates)
// general  -> generic timbre, equal weight
export const TARGET_WEIGHTS = {
  prop: {
    spectral: 2.0,
    envelope: 0.8,
    pitch: 1.2,
  },
  force: {
    spectral: 0.8,
    envelope: 2.2,
    pitch: 0.4,
  },
  general: {
    spectral: 1.0,
    envelope: 1.0,
    pitch: 1.0,
  },
};

export const KEY_BLOCK = {};
for (const k of SPECTRAL_KEYS) KEY_BLOCK[k] = 'spectral';
for (const k of ENVELOPE_KEYS) KEY_BLOCK[k] = 'envelope';
for (const k of PITCH_KEYS) KEY_BLOCK[k] = 'pitch';
for (const k of LOUDNESS_KEYS) KEY_BLOCK[k] = 'loudness';
for (const k of DURATION_KEYS) KEY_BLOCK[k] = 'duration';
