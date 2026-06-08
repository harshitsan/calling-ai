import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  const base = {
    CONTROL_SECRET: 'sek',
    NOTETAKER_URL: 'https://app.example.com',
    NOTETAKER_API_KEY: 'key',
  };

  it('parses required fields and applies defaults', () => {
    const c = loadConfig(base);
    expect(c.controlSecret).toBe('sek');
    expect(c.notetakerUrl).toBe('https://app.example.com');
    expect(c.notetakerApiKey).toBe('key');
    expect(c.port).toBe(8080);
    expect(c.maxConcurrent).toBe(2);
    expect(c.lobbyTimeoutMs).toBe(5 * 60_000);
    expect(c.aloneGraceMs).toBe(2 * 60_000);
    expect(c.maxDurationMs).toBe(2 * 60 * 60_000);
  });

  it('overrides defaults from env', () => {
    const c = loadConfig({ ...base, PORT: '9090', MAX_CONCURRENT: '1' });
    expect(c.port).toBe(9090);
    expect(c.maxConcurrent).toBe(1);
  });

  it('throws when a required field is missing', () => {
    expect(() => loadConfig({ NOTETAKER_URL: 'x', NOTETAKER_API_KEY: 'y' })).toThrow(/CONTROL_SECRET/);
  });

  it('throws when a numeric field is not a number', () => {
    expect(() => loadConfig({ CONTROL_SECRET: 'sek', NOTETAKER_URL: 'u', NOTETAKER_API_KEY: 'k', PORT: 'abc' })).toThrow(/must be a number/);
  });
});
