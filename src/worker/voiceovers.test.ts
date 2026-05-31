import { describe, expect, it } from 'vitest';
import { pickProvider, voicesForProvider } from './voiceovers';

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
