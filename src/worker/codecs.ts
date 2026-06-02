// G.711 μ-law codec + linear PCM resampling.
//
// Used by carrier protocol adapters (Twilio Media Streams, Tata Teleservices,
// Acefone Stream, etc.) to translate between the 8 kHz μ-law mono wire format
// every PSTN carrier exposes and the 16 kHz / 24 kHz linear16 PCM our STT and
// TTS adapters consume.

// μ-law constants per ITU-T G.711
const MULAW_BIAS = 0x84;
const MULAW_SIGN_BIT = 0x80;
const MULAW_SEG_MASK = 0x70;
const MULAW_QUANT_MASK = 0x0f;
const MULAW_SEG_SHIFT = 4;
const MULAW_CLIP = 32635;

/** Encode one signed 16-bit linear PCM sample to one μ-law byte. */
export function linearToMulaw(sample: number): number {
  let s = sample | 0;
  let sign = 0;
  if (s < 0) {
    s = -s;
    sign = MULAW_SIGN_BIT;
  }
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;

  let seg = 7;
  for (let mask = 0x4000; (s & mask) === 0 && seg > 0; mask >>= 1) seg--;

  const uval = (sign | (seg << MULAW_SEG_SHIFT) | ((s >> (seg + 3)) & MULAW_QUANT_MASK)) ^ 0xff;
  return uval & 0xff;
}

/** Decode one μ-law byte to one signed 16-bit linear PCM sample. */
export function mulawToLinear(ulaw: number): number {
  const u = (~ulaw) & 0xff;
  const sign = u & MULAW_SIGN_BIT;
  const seg = (u & MULAW_SEG_MASK) >> MULAW_SEG_SHIFT;
  const mant = u & MULAW_QUANT_MASK;
  let s = ((mant << 3) + MULAW_BIAS) << seg;
  s -= MULAW_BIAS;
  return sign ? -s : s;
}

/** Bulk encode linear16 PCM → μ-law bytes (1 sample → 1 byte). */
export function encodeMulaw(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]!);
  return out;
}

/** Bulk decode μ-law bytes → linear16 PCM (1 byte → 1 sample). */
export function decodeMulaw(ulaw: Uint8Array): Int16Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) out[i] = mulawToLinear(ulaw[i]!);
  return out;
}

/**
 * Linear-interpolation resampler. Cheap, runs in pure JS, fine for the small
 * rate ratios we use here (8↔16↔24 kHz). For pitch-preserving stretch, swap
 * in SoundTouch WASM.
 */
export function resampleLinear16(input: Int16Array, srcRate: number, dstRate: number): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const dstLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIdx - lo;
    out[i] = Math.round(input[lo]! * (1 - frac) + input[hi]! * frac);
  }
  return out;
}

// Tiny base64 helpers — atob/btoa exist in Workers but operate on strings.
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  // Chunk to keep call-stack manageable on large buffers.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
