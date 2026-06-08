import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../src/recorder';

function ffmpegAvailable(): boolean {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('Recorder', () => {
  let hasFfmpeg = false;
  beforeAll(() => { hasFfmpeg = ffmpegAvailable(); });

  it('records the injected source to a non-empty mp3 and stops cleanly', async () => {
    if (!hasFfmpeg) { console.warn('ffmpeg not on PATH — skipping'); return; }
    const dir = mkdtempSync(join(tmpdir(), 'rec-'));
    const out = join(dir, 'test.mp3');
    const rec = new Recorder({
      outputPath: out,
      // Synthetic source for tests; prod injects ['-f','pulse','-i','meet_sink.monitor'].
      inputArgs: ['-f', 'lavfi', '-i', 'sine=frequency=440'],
    });
    rec.start();
    await new Promise((r) => setTimeout(r, 1500));
    await rec.stop();
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(1000);
    rmSync(dir, { recursive: true, force: true });
  });
});
