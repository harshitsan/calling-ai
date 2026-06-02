import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decodeMulaw,
  encodeMulaw,
  linearToMulaw,
  mulawToLinear,
  resampleLinear16,
} from './codecs';

describe('μ-law codec', () => {
  it('round-trips silence', () => {
    expect(mulawToLinear(linearToMulaw(0))).toBe(0);
  });

  it('round-trips small positive samples to within quantization', () => {
    for (const s of [100, 500, 1000, 4000, 12000, 30000]) {
      const out = mulawToLinear(linearToMulaw(s));
      expect(Math.abs(out - s)).toBeLessThan(s * 0.05 + 16);
    }
  });

  it('round-trips small negative samples to within quantization', () => {
    for (const s of [-100, -500, -1000, -4000, -12000, -30000]) {
      const out = mulawToLinear(linearToMulaw(s));
      expect(Math.abs(out - s)).toBeLessThan(Math.abs(s) * 0.05 + 16);
    }
  });

  it('clips samples above +32635', () => {
    expect(mulawToLinear(linearToMulaw(40000))).toBeLessThanOrEqual(32635);
  });

  it('μ-law silence is 0xff (encoded representation of 0)', () => {
    expect(linearToMulaw(0)).toBe(0xff);
  });

  it('bulk encode + decode preserves length', () => {
    const pcm = new Int16Array([0, 100, -100, 1000, -1000, 5000, -5000]);
    const ulaw = encodeMulaw(pcm);
    expect(ulaw.length).toBe(pcm.length);
    const back = decodeMulaw(ulaw);
    expect(back.length).toBe(pcm.length);
  });
});

describe('resampleLinear16', () => {
  it('returns identical input when rates match', () => {
    const input = new Int16Array([0, 1, 2, 3, 4]);
    expect(resampleLinear16(input, 8000, 8000)).toEqual(input);
  });

  it('doubles length when upsampling 8k → 16k', () => {
    const input = new Int16Array(160); // 20 ms at 8 kHz
    expect(resampleLinear16(input, 8000, 16000).length).toBe(320); // 20 ms at 16 kHz
  });

  it('halves length when downsampling 16k → 8k', () => {
    const input = new Int16Array(320); // 20 ms at 16 kHz
    expect(resampleLinear16(input, 16000, 8000).length).toBe(160);
  });

  it('triples length when upsampling 8k → 24k', () => {
    const input = new Int16Array(80); // 10 ms at 8 kHz
    expect(resampleLinear16(input, 8000, 24000).length).toBe(240);
  });

  it('interpolates between samples', () => {
    const out = resampleLinear16(new Int16Array([0, 1000]), 8000, 16000);
    expect(out[1]).toBe(500); // midpoint
  });
});

describe('base64', () => {
  it('round-trips a simple byte array', () => {
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe('aGVsbG8=');
    expect(base64ToBytes(b64)).toEqual(bytes);
  });

  it('handles a large buffer without stack overflow', () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const round = base64ToBytes(bytesToBase64(bytes));
    expect(round.length).toBe(bytes.length);
    expect(round[0]).toBe(0);
    expect(round[99_999]).toBe(99_999 & 0xff);
  });
});
