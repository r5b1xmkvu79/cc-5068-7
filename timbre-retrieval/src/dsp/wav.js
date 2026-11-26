// Minimal PCM WAV reader / writer (mono or interleaved multi-channel).
// Supports PCM int16/int24/int32 and IEEE float32. No external dependencies.

export function readWav(input) {
  // Node Buffers pool ArrayBuffers; slice to the exact byte range first.
  const buf = input instanceof ArrayBuffer
    ? input
    : input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  const dv = new DataView(buf);
  const readStr = (o) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  if (readStr(0) !== 'RIFF' || readStr(8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buf.byteLength) {
    const id = readStr(offset);
    const size = dv.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: dv.getUint16(body, true),
        numChannels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = size;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) throw new Error('WAV missing fmt/data chunks');
  const { audioFormat, numChannels, sampleRate, bitsPerSample } = fmt;
  const frameBytes = (bitsPerSample / 8) * numChannels;
  const frames = Math.floor(dataLength / frameBytes);
  const channels = Array.from({ length: numChannels }, () => new Float64Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < numChannels; c++) {
      const p = dataOffset + (f * numChannels + c) * (bitsPerSample / 8);
      let v;
      if (audioFormat === 3 && bitsPerSample === 32) {
        v = dv.getFloat32(p, true);
      } else if (bitsPerSample === 16) {
        v = dv.getInt16(p, true) / 32768;
      } else if (bitsPerSample === 24) {
        const b0 = dv.getUint8(p), b1 = dv.getUint8(p + 1), b2 = dv.getUint8(p + 2);
        let u = b0 | (b1 << 8) | (b2 << 16);
        if (u & 0x800000) u |= 0xff000000;
        v = u / 8388608;
      } else if (bitsPerSample === 32) {
        v = dv.getInt32(p, true) / 2147483648;
      } else if (bitsPerSample === 8) {
        v = (dv.getUint8(p) - 128) / 128;
      } else {
        throw new Error(`unsupported WAV format ${audioFormat}/${bitsPerSample}`);
      }
      channels[c][f] = v;
    }
  }
  return { sampleRate, channels, frames };
}

export function writeWav(samples, sampleRate, bitDepth = 16) {
  const ch = Array.isArray(samples) ? samples : [samples];
  const channels = ch.length;
  const frames = ch[0].length;
  const bytesPerSample = bitDepth / 8;
  const dataLength = frames * channels * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLength);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const writeStr = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * bytesPerSample, true);
  dv.setUint16(32, channels * bytesPerSample, true);
  dv.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataLength, true);
  let p = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      let x = ch[c][f];
      if (bitDepth === 16) {
        x = Math.max(-1, Math.min(1, x));
        dv.setInt16(p, Math.round(x * 32767), true);
      } else if (bitDepth === 32) {
        dv.setFloat32(p, x, true);
      } else if (bitDepth === 24) {
        x = Math.max(-1, Math.min(1, x));
        let u = Math.round(x * 8388607);
        u &= 0xffffff;
        u8[p] = u & 0xff; u8[p + 1] = (u >> 8) & 0xff; u8[p + 2] = (u >> 16) & 0xff;
      } else throw new Error('bitDepth must be 16, 24 or 32');
      p += bytesPerSample;
    }
  }
  return Buffer.from(buf);
}

// Mix multi-channel down to mono (equal-power simple average).
export function toMono(wav) {
  if (wav.channels.length === 1) return wav.channels[0];
  const out = new Float64Array(wav.frames);
  for (const c of wav.channels) for (let i = 0; i < out.length; i++) out[i] += c[i];
  for (let i = 0; i < out.length; i++) out[i] /= wav.channels.length;
  return out;
}
