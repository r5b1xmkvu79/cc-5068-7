import { NFFT, HOP } from '../config.js';
import { magnitudeSpectrum } from './fft.js';
import { hanning, rmsEnvelope, linfit, safeLog10, safeLog, median, mean } from './util.js';

// Short-time Fourier transform: full-length Hann-windowed frames, hop HOP.
export function stft(x, sr, nfft = NFFT, hop = HOP) {
  const win = hanning(nfft);
  const nFrames = Math.max(0, Math.floor((x.length - nfft) / hop) + 1);
  const bins = nfft / 2 + 1;
  const frames = new Float64Array(nFrames * bins);
  const times = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    const frame = new Float64Array(nfft);
    for (let j = 0; j < nfft; j++) frame[j] = x[start + j] * win[j];
    const mag = magnitudeSpectrum(frame);
    frames.set(mag, f * bins);
    times[f] = (start + nfft / 2) / sr;
  }
  return { frames, times, bins, nFrames };
}

function spectralMoments(mag, freqs) {
  let total = 0;
  for (const m of mag) total += m;
  if (total < 1e-12) return null;
  let centroid = 0;
  for (let i = 0; i < mag.length; i++) centroid += freqs[i] * mag[i];
  centroid /= total;
  let bw = 0, skew = 0, kurt = 0, geo = 0;
  let eLow = 0, eMid = 0, eHigh = 0, cum = 0, rolloff = freqs[freqs.length - 1];
  for (let i = 0; i < mag.length; i++) {
    const p = mag[i] / total;
    const d = freqs[i] - centroid;
    bw += p * d * d;
    skew += p * d ** 3;
    kurt += p * d ** 4;
    geo += p * safeLog(mag[i] + 1e-12);
    if (freqs[i] < 500) eLow += mag[i] * mag[i];
    else if (freqs[i] < 2000) eMid += mag[i] * mag[i];
    if (freqs[i] > 2000) eHigh += mag[i] * mag[i];
    cum += mag[i];
    if (rolloff === freqs[freqs.length - 1] && cum >= 0.85 * total) rolloff = freqs[i];
  }
  bw = Math.sqrt(bw);
  const flatness = Math.exp(geo) / (total / mag.length + 1e-12);
  const eAll = eLow + eMid + eHigh + 1e-12;
  return {
    centroid, bandwidth: bw, rolloff,
    flatness: Math.max(1e-8, flatness),
    skew: bw > 1 ? skew / bw ** 3 : 0,
    kurt: bw > 1 ? kurt / bw ** 4 - 3 : 0,
    hfRatio: Math.min(1, eHigh / eAll),
    // bounded so a near-zero mid band (e.g. an uploaded pure tone) cannot
    // explode the distance; physical impact sounds sit well inside this range
    lowMidRatio: Math.min(1e4, (eLow + 1e-12) / (eMid + 1e-12)),
  };
}

// Autocorrelation pitch estimate over a segment; f in [fMin, fMax] Hz.
function pitchACF(seg, sr, fMin = 45, fMax = 1500) {
  const n = seg.length;
  const minLag = Math.max(2, Math.floor(sr / fMax));
  const maxLag = Math.min(n - 2, Math.ceil(sr / fMin));
  if (maxLag <= minLag) return { f0: 0, confidence: 0 };
  let e0 = 0;
  for (const v of seg) e0 += v * v;
  if (e0 < 1e-10) return { f0: 0, confidence: 0 };
  let best = -1, bestVal = -Infinity;
  let prev = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += seg[i] * seg[i + lag];
    const v = s / e0;
    // require a local peak, prefer the first strong one
    if (v > bestVal && v > prev && lag > minLag) { bestVal = v; best = lag; }
    prev = v;
  }
  if (best < 0 || bestVal < 0.2) return { f0: 0, confidence: Math.max(0, bestVal) };
  // parabolic interpolation
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i + best < n; i++) {
    s0 += seg[i] * seg[i + best];
    if (best > 0) s1 += seg[i] * seg[i + best - 1];
    if (best + 1 < n) s2 += seg[i] * seg[i + best + 1];
  }
  const shift = 0.5 * (s1 - s2) / (s1 - 2 * s0 + s2 + 1e-12);
  const f0 = sr / (best + (Number.isFinite(shift) ? shift : 0));
  return { f0, confidence: bestVal };
}

// Fraction of spectral energy away from harmonic grid given f0 (inharmonicity proxy).
function inharmonicity(mag, freqs, f0) {
  if (!f0 || f0 <= 0) return 0;
  let harmE = 0, totalE = 0;
  for (let i = 1; i < mag.length && freqs[i] < 4000; i++) {
    const e = mag[i] * mag[i];
    totalE += e;
    const k = freqs[i] / f0;
    const nearest = Math.round(k);
    if (nearest >= 1 && Math.abs(k - nearest) / nearest < 0.04) harmE += e;
  }
  if (totalE < 1e-12) return 0;
  return Math.min(1, 1 - harmE / totalE);
}

function downsample(arr, target) {
  if (arr.length <= target) return Float64Array.from(arr);
  const out = new Float64Array(target);
  for (let i = 0; i < target; i++) {
    const a = Math.floor((i * arr.length) / target);
    const b = Math.max(a + 1, Math.floor(((i + 1) * arr.length) / target));
    let s = 0;
    for (let j = a; j < b; j++) s += arr[j];
    out[i] = s / (b - a);
  }
  return out;
}

// Main entry: compute the full descriptive feature set for one mono clip.
export function extractFeatures(x, sr) {
  x = Float64Array.from(x);
  const { frames, times, bins, nFrames } = stft(x, sr);
  const freqs = new Float64Array(bins);
  for (let i = 0; i < bins; i++) freqs[i] = (i * sr) / NFFT;

  const perFrame = {
    centroid: [], bandwidth: [], rolloff: [], flatness: [], skew: [], kurt: [], hfRatio: [], lowMidRatio: [],
  };
  for (let f = 0; f < nFrames; f++) {
    const mag = frames.subarray(f * bins, (f + 1) * bins);
    const m = spectralMoments(mag, freqs);
    if (!m) continue;
    for (const k of Object.keys(perFrame)) perFrame[k].push(m[k]);
  }

  // RMS envelope on the STFT grid + a short-window envelope for transient contrast.
  const env = rmsEnvelope(x, sr, NFFT, HOP);
  const short = rmsEnvelope(x, sr, 128, 64);
  let peakIdx = 0;
  for (let i = 1; i < env.rms.length; i++) if (env.rms[i] > env.rms[peakIdx]) peakIdx = i;
  const peakRms = env.rms[peakIdx];

  // Noise floor from the quietest 10% of frames; onset threshold relative to it.
  const sortedRms = Float64Array.from(env.rms).sort();
  const noise = sortedRms[Math.max(0, Math.floor(sortedRms.length * 0.1))] + 1e-12;
  const thresh = Math.max(noise * 4, peakRms * 0.2);
  let onset = peakIdx;
  for (let i = 0; i < peakIdx; i++) {
    if (env.rms[i] >= thresh) { onset = i; break; }
  }
  let endIdx = env.rms.length - 1;
  for (let i = peakIdx; i < env.rms.length; i++) {
    if (env.rms[i] < Math.max(noise * 2, peakRms * 0.1)) { endIdx = i; break; }
  }

  // Envelope descriptors.
  const attackTime = Math.max(0, env.times[peakIdx] - env.times[onset]);
  const db = Float64Array.from(env.rms, (v) => 20 * safeLog10(v));
  const slopeFit = linfit(env.times, db, onset, peakIdx + 1);
  const decayFit = linfit(env.times, Float64Array.from(env.rms, (v) => safeLog(v)), peakIdx, endIdx + 1);
  const decayTau = decayFit.b < -1e-6 ? -1 / decayFit.b : 1.0;
  const post = env.rms.subarray(onset, endIdx + 1);
  let geo = 0;
  for (const v of post) geo += safeLog(v);
  const envFlatness = Math.exp(geo / post.length) / (mean(post) + 1e-12);
  const tailStart = Math.max(peakIdx + 1, endIdx - Math.max(1, Math.floor((endIdx - onset) * 0.2)));
  const envSustain = mean(env.rms.subarray(tailStart, endIdx + 1)) / (peakRms + 1e-12);
  const shortPeak = Math.max(...short.rms);
  const globalRms = Math.sqrt(mean(Float64Array.from(x, (v) => v * v))) + 1e-12;
  const transientRatio = Math.min(1e3, shortPeak / globalRms);
  const duration = Math.max(0.02, env.times[endIdx] - env.times[onset]);

  // Pitch on the attack segment.
  const a0 = Math.floor(env.times[onset] * sr);
  const a1 = Math.min(x.length, a0 + Math.floor(0.12 * sr));
  const { f0, confidence } = pitchACF(x.subarray(a0, a1), sr);
  // Inharmonicity from the peak frame's spectrum.
  const peakMag = frames.subarray(peakIdx * bins, (peakIdx + 1) * bins);
  const inh = inharmonicity(peakMag, freqs, f0);

  // Level descriptors (kept OUT of the default timbre vector).
  let peakAbs = 0;
  for (const v of x) peakAbs = Math.max(peakAbs, Math.abs(v));
  const rmsDb = 20 * safeLog10(globalRms);
  const peakDb = 20 * safeLog10(peakAbs + 1e-12);

  const features = {
    // spectral shape
    specCentroid: median(perFrame.centroid),
    specBandwidth: median(perFrame.bandwidth),
    specRolloff85: median(perFrame.rolloff),
    specFlatness: median(perFrame.flatness),
    specSkew: median(perFrame.skew),
    specKurt: median(perFrame.kurt),
    specHfRatio: median(perFrame.hfRatio),
    lowMidRatio: median(perFrame.lowMidRatio),
    // temporal envelope
    attackTime,
    decayTau: Math.min(decayTau, 2),
    envFlatness,
    envSustain,
    transientRatio,
    onsetSlope: slopeFit.b,
    // pitch
    f0,
    f0Confidence: confidence,
    inharmonicity: inh,
    // explicit nuisance attributes
    rmsDb,
    peakDb,
    crestDb: peakDb - rmsDb,
    duration,
  };

  // UI curves: waveform, envelope, log-magnitude spectrogram (time x freq).
  const waveform = downsample(x.subarray(a0, Math.min(x.length, a1 + Math.floor(duration * sr))), 512);
  const envCurve = downsample(env.rms, 200);
  const tBins = 64, fBins = 48;
  const specgram = new Float64Array(tBins * fBins);
  const f0bin = Math.max(1, Math.floor((NFFT / 2 + 1) / fBins));
  for (let ti = 0; ti < tBins; ti++) {
    const fa = Math.floor((ti * nFrames) / tBins);
    const fb = Math.max(fa + 1, Math.floor(((ti + 1) * nFrames) / tBins));
    for (let fi = 0; fi < fBins; fi++) {
      let s = 0, cnt = 0;
      for (let f = fa; f < fb && f < nFrames; f++) {
        const ba = fi * f0bin;
        const bb = Math.min(bins, (fi + 1) * f0bin);
        for (let b = ba; b < bb; b++) s += frames[f * bins + b];
        cnt += bb - ba;
      }
      specgram[ti * fBins + fi] = 20 * safeLog10(s / (cnt + 1) + 1e-8);
    }
  }

  return {
    features,
    curves: {
      waveform: Array.from(waveform),
      envelope: Array.from(envCurve),
      specgram: Array.from(specgram),
      tBins, fBins,
      fMax: sr / 2,
    },
  };
}
