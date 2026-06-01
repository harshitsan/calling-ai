import { describe, expect, it } from 'vitest';
import {
  expandScript,
  fitToDuration,
  mixSnippetsToPcm,
  parseSegments,
  pickProvider,
  resamplePcm,
  voicesForProvider,
} from './voiceovers';

describe('pickProvider', () => {
  it('routes en-US to Aura-2 English', () => {
    const p = pickProvider('en-US');
    expect(p.model).toBe('@cf/deepgram/aura-2-en');
    expect(p.voicePrefix).toBe('aura2en');
  });
  it('routes es and es-ES to Aura-2 Spanish', () => {
    expect(pickProvider('es').voicePrefix).toBe('aura2es');
    expect(pickProvider('es-ES').voicePrefix).toBe('aura2es');
  });
  it('routes unknown language to Gemini', () => {
    expect(pickProvider('fr').voicePrefix).toBe('gemini');
    expect(pickProvider('zh').voicePrefix).toBe('gemini');
  });
  it('is case-insensitive', () => {
    expect(pickProvider('EN-us').voicePrefix).toBe('aura2en');
  });
});

describe('voicesForProvider', () => {
  it('returns 40 voices for Aura-2 English', () => {
    expect(voicesForProvider(pickProvider('en-US')).length).toBe(40);
  });
  it('returns 10 voices for Aura-2 Spanish', () => {
    expect(voicesForProvider(pickProvider('es')).length).toBe(10);
  });
  it('returns 30 voices for Gemini', () => {
    expect(voicesForProvider(pickProvider('fr')).length).toBe(30);
  });
});

describe('expandScript', () => {
  const aura = pickProvider('en-US');
  const gemini = pickProvider('fr');
  it('expands pause tokens', () => {
    expect(expandScript('Hi[pause:short]there.', 'normal', aura)).toBe('Hi, there.');
    expect(expandScript('Hi[pause:medium]there.', 'normal', aura)).toBe('Hi. there.');
    expect(expandScript('Hi[pause:long]there.', 'normal', aura)).toBe('Hi... there.');
  });
  it('prepends pacing directive only for Gemini', () => {
    expect(expandScript('Hello.', 'slow', gemini)).toContain('slow');
    expect(expandScript('Hello.', 'slow', aura)).toBe('Hello.');
  });
});

describe('parseSegments', () => {
  it('returns a single text segment when no pauses are present', () => {
    const segs = parseSegments('Hello world.');
    expect(segs).toEqual([{ kind: 'text', value: 'Hello world.' }]);
  });
  it('parses precise seconds with a decimal', () => {
    const segs = parseSegments('Hi.[pause:1.5s]There.');
    expect(segs).toEqual([
      { kind: 'text', value: 'Hi.' },
      { kind: 'silence', durationMs: 1500 },
      { kind: 'text', value: 'There.' },
    ]);
  });
  it('parses precise milliseconds', () => {
    const segs = parseSegments('A[pause:750ms]B');
    expect(segs).toEqual([
      { kind: 'text', value: 'A' },
      { kind: 'silence', durationMs: 750 },
      { kind: 'text', value: 'B' },
    ]);
  });
  it('maps legacy short/medium/long to fixed durations', () => {
    expect(parseSegments('A[pause:short]B')[1]).toEqual({ kind: 'silence', durationMs: 500 });
    expect(parseSegments('A[pause:medium]B')[1]).toEqual({ kind: 'silence', durationMs: 1000 });
    expect(parseSegments('A[pause:long]B')[1]).toEqual({ kind: 'silence', durationMs: 2000 });
  });
  it('clamps absurd durations into a safe range', () => {
    // 30s would otherwise allocate way too much.
    expect(parseSegments('A[pause:30s]B')[1]).toEqual({ kind: 'silence', durationMs: 10_000 });
    // 5ms clamps up to 50ms.
    expect(parseSegments('A[pause:5ms]B')[1]).toEqual({ kind: 'silence', durationMs: 50 });
  });
  it('handles consecutive pauses', () => {
    const segs = parseSegments('A[pause:1s][pause:0.5s]B');
    const silenceParts = segs.filter((s) => s.kind === 'silence');
    expect(silenceParts).toHaveLength(2);
    expect(silenceParts[0]).toEqual({ kind: 'silence', durationMs: 1000 });
    expect(silenceParts[1]).toEqual({ kind: 'silence', durationMs: 500 });
  });
  it('drops empty-string text segments between adjacent tokens', () => {
    const segs = parseSegments('[pause:0.5s][pause:0.5s]');
    expect(segs.every((s) => s.kind === 'silence')).toBe(true);
    expect(segs.length).toBe(2);
  });
  it('is case-insensitive on the token', () => {
    expect(parseSegments('A[PAUSE:1S]B')[1]).toEqual({ kind: 'silence', durationMs: 1000 });
  });
});

describe('resamplePcm', () => {
  it('returns the same data when src and dst rates match', () => {
    const input = new Int16Array([1, 2, 3, 4, 5]);
    expect(resamplePcm(input, 24000, 24000)).toEqual(input);
  });
  it('downsamples to half length when src is 2× dst', () => {
    const input = new Int16Array([0, 100, 200, 300, 400, 500, 600, 700]);
    const out = resamplePcm(input, 48000, 24000);
    expect(out.length).toBe(4);
  });
  it('upsamples to double length when dst is 2× src', () => {
    const input = new Int16Array([0, 100, 200, 300]);
    const out = resamplePcm(input, 24000, 48000);
    expect(out.length).toBe(8);
  });
  it('produces an interpolated value between samples', () => {
    const out = resamplePcm(new Int16Array([0, 1000]), 24000, 48000);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(500); // midpoint between 0 and 1000
    expect(out[2]).toBe(1000);
  });
});

describe('fitToDuration', () => {
  it('targets the correct sample count at 24 kHz', () => {
    // 1 second of audio (24000 samples). Fit to 500 ms (12000 samples).
    const input = new Int16Array(24000);
    const out = fitToDuration(input, 24000, 500);
    expect(out.length).toBe(12000);
  });
  it('extends a short snippet to a longer target', () => {
    const input = new Int16Array(12000); // 500 ms at 24 kHz
    const out = fitToDuration(input, 24000, 1000); // 1 s
    expect(out.length).toBe(24000);
  });
  it('passes through when input already matches target', () => {
    const input = new Int16Array(24000);
    const out = fitToDuration(input, 24000, 1000);
    expect(out.length).toBe(24000);
  });
  it('returns a silence buffer when target is positive and input empty', () => {
    const out = fitToDuration(new Int16Array(0), 24000, 500);
    expect(out.length).toBe(12000);
    expect(out.every((v) => v === 0)).toBe(true);
  });
});

describe('mixSnippetsToPcm', () => {
  const rate = 24000;
  function ones(durationMs: number): Int16Array {
    const a = new Int16Array(Math.floor((durationMs / 1000) * rate));
    a.fill(1000);
    return a;
  }
  it('writes a snippet at the correct start offset', () => {
    const out = mixSnippetsToPcm(
      [{ pcm: ones(500), sampleRate: rate, startMs: 1000, durationMs: 500 }],
      2000,
      rate,
    );
    // Total length = 2 seconds = 48000 samples.
    expect(out.length).toBe(48000);
    // Silence before 1 second mark.
    expect(out[0]).toBe(0);
    expect(out[24000 - 1]).toBe(0);
    // Snippet sits in [24000, 36000).
    expect(out[24000]).toBe(1000);
    expect(out[36000 - 1]).toBe(1000);
    // Silence after.
    expect(out[36000]).toBe(0);
  });
  it('places multiple snippets without overwriting silence between them', () => {
    const out = mixSnippetsToPcm(
      [
        { pcm: ones(500), sampleRate: rate, startMs: 0, durationMs: 500 },
        { pcm: ones(500), sampleRate: rate, startMs: 1000, durationMs: 500 },
      ],
      2000,
      rate,
    );
    expect(out[0]).toBe(1000);
    expect(out[12000 - 1]).toBe(1000);
    expect(out[12000]).toBe(0); // gap
    expect(out[24000 - 1]).toBe(0);
    expect(out[24000]).toBe(1000);
  });
  it('truncates a snippet that would extend past the total length', () => {
    // Snippet says it lasts 2 seconds but we ask for a 1-second total.
    const out = mixSnippetsToPcm(
      [{ pcm: ones(500), sampleRate: rate, startMs: 0, durationMs: 2000 }],
      1000,
      rate,
    );
    expect(out.length).toBe(24000);
  });
  it('handles snippet at a different sample rate (16 kHz input)', () => {
    const input16k = new Int16Array(8000); // 500 ms at 16 kHz
    input16k.fill(1000);
    const out = mixSnippetsToPcm(
      [{ pcm: input16k, sampleRate: 16000, startMs: 0, durationMs: 500 }],
      1000,
      rate,
    );
    expect(out[100]).toBe(1000); // resampled into the 24 kHz output
  });
});
