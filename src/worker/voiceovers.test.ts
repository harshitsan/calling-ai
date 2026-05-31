import { describe, expect, it } from 'vitest';
import { expandScript, pickProvider, voicesForProvider } from './voiceovers';

describe('pickProvider', () => {
  it('routes en-US to Aura-2 English', () => {
    const p = pickProvider('en-US');
    expect(p.model).toBe('@cf/deepgram/aura-2-en');
    expect(p.voicePrefix).toBe('aura2en');
    expect(p.format).toBe('mp3');
  });

  it('routes en-GB to Aura-2 English', () => {
    expect(pickProvider('en-GB').voicePrefix).toBe('aura2en');
  });

  it('routes es and es-ES to Aura-2 Spanish', () => {
    expect(pickProvider('es').voicePrefix).toBe('aura2es');
    expect(pickProvider('es-ES').voicePrefix).toBe('aura2es');
  });

  it('routes unknown language to Gemini', () => {
    expect(pickProvider('fr').voicePrefix).toBe('gemini');
    expect(pickProvider('hi-IN').voicePrefix).toBe('gemini');
    expect(pickProvider('zh').voicePrefix).toBe('gemini');
  });

  it('is case-insensitive', () => {
    expect(pickProvider('EN-us').voicePrefix).toBe('aura2en');
    expect(pickProvider('ES').voicePrefix).toBe('aura2es');
  });

  it('Gemini returns wav format', () => {
    expect(pickProvider('ja').format).toBe('wav');
  });
});

describe('voicesForProvider', () => {
  it('returns 40 voices for Aura-2 English', () => {
    const voices = voicesForProvider(pickProvider('en-US'));
    expect(voices.length).toBe(40);
    expect(voices.every((v) => v.id.startsWith('aura2en:'))).toBe(true);
  });

  it('returns 10 voices for Aura-2 Spanish', () => {
    const voices = voicesForProvider(pickProvider('es'));
    expect(voices.length).toBe(10);
    expect(voices.every((v) => v.id.startsWith('aura2es:'))).toBe(true);
  });

  it('returns 30 voices for Gemini', () => {
    const voices = voicesForProvider(pickProvider('fr'));
    expect(voices.length).toBe(30);
    expect(voices.every((v) => v.id.startsWith('gemini:'))).toBe(true);
  });

  it('Gemini voices have no gender (Google does not publish per-voice gender)', () => {
    const voices = voicesForProvider(pickProvider('fr'));
    expect(voices.every((v) => v.gender === undefined)).toBe(true);
  });

  it('Aura voices all have a gender', () => {
    const en = voicesForProvider(pickProvider('en-US'));
    const es = voicesForProvider(pickProvider('es'));
    expect(en.every((v) => v.gender === 'female' || v.gender === 'male')).toBe(true);
    expect(es.every((v) => v.gender === 'female' || v.gender === 'male')).toBe(true);
  });
});

describe('expandScript', () => {
  const aura = pickProvider('en-US');
  const gemini = pickProvider('fr');

  it('passes plain text through unchanged at normal speed', () => {
    expect(expandScript('Hello world.', 'normal', aura)).toBe('Hello world.');
  });

  it('expands short/medium/long pause tokens', () => {
    expect(expandScript('Hi[pause:short]there.', 'normal', aura)).toBe('Hi, there.');
    expect(expandScript('Hi[pause:medium]there.', 'normal', aura)).toBe('Hi. there.');
    expect(expandScript('Hi[pause:long]there.', 'normal', aura)).toBe('Hi... there.');
  });

  it('is case-insensitive for pause tokens', () => {
    expect(expandScript('Hi[PAUSE:short]there.', 'normal', aura)).toBe('Hi, there.');
  });

  it('expands multiple pauses in one script', () => {
    expect(expandScript('A[pause:short]B[pause:long]C', 'normal', aura)).toBe('A, B... C');
  });

  it('prepends slow-pace directive only for Gemini', () => {
    expect(expandScript('Hello.', 'slow', gemini)).toContain('slow');
    expect(expandScript('Hello.', 'slow', gemini).endsWith('Hello.')).toBe(true);
  });

  it('prepends fast-pace directive only for Gemini', () => {
    expect(expandScript('Hello.', 'fast', gemini)).toContain('brisk');
  });

  it('does not modify text for non-normal speed on Aura (no API knob)', () => {
    expect(expandScript('Hello.', 'slow', aura)).toBe('Hello.');
    expect(expandScript('Hello.', 'fast', aura)).toBe('Hello.');
  });

  it('combines pause expansion and speed directive for Gemini', () => {
    const out = expandScript('Hi[pause:medium]there.', 'slow', gemini);
    expect(out).toContain('slow');
    expect(out).toContain('Hi. there.');
  });
});
