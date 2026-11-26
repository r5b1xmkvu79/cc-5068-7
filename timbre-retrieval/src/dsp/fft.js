// Iterative radix-2 FFT (in-place, separate real/imag arrays).

function bitReverse(n) {
  const rev = new Int32Array(n);
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  return rev;
}

export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT length must be power of two');
  const rev = bitReverse(n);
  for (let i = 0; i < n; i++) {
    if (i < rev[i]) {
      [re[i], re[rev[i]]] = [re[rev[i]], re[i]];
      [im[i], im[rev[i]]] = [im[rev[i]], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const ang = (-2 * Math.PI) / size;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let start = 0; start < n; start += size) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  return { re, im };
}

export function magnitudeSpectrum(frame) {
  const n = frame.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(frame);
  fft(re, im);
  const half = n >> 1;
  const mag = new Float64Array(half + 1);
  for (let i = 0; i <= half; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}
