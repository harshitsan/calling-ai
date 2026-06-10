import { describe, expect, it, vi } from 'vitest';
import { createSessionSink, removeSessionSink, sinkNameFor } from '../src/audio-sink';

describe('sinkNameFor', () => {
  it('derives a pactl-safe name from a session uuid', () => {
    expect(sinkNameFor('66253a15-51ad-49b9-953f-8d8d28c5e292')).toBe('snk_66253a1551ad49b9');
  });

  it('strips anything that is not alphanumeric', () => {
    expect(sinkNameFor('a/b:c d!e')).toBe('snk_abcde');
  });
});

describe('createSessionSink', () => {
  it('loads a null sink named for the session and returns the module id', async () => {
    const exec = vi.fn(async () => ({ stdout: '42\n' }));
    const { sinkName, moduleId } = await createSessionSink(exec, '66253a15-51ad-49b9-953f-8d8d28c5e292');
    expect(sinkName).toBe('snk_66253a1551ad49b9');
    expect(moduleId).toBe('42');
    expect(exec).toHaveBeenCalledWith('pactl', [
      'load-module', 'module-null-sink',
      'sink_name=snk_66253a1551ad49b9',
      'sink_properties=device.description=snk_66253a1551ad49b9',
    ]);
  });

  it('propagates pactl failures', async () => {
    const exec = vi.fn(async () => { throw new Error('pactl: not running'); });
    await expect(createSessionSink(exec, 'abc')).rejects.toThrow(/not running/);
  });
});

describe('removeSessionSink', () => {
  it('unloads the module by id', async () => {
    const exec = vi.fn(async () => ({ stdout: '' }));
    await removeSessionSink(exec, '42');
    expect(exec).toHaveBeenCalledWith('pactl', ['unload-module', '42']);
  });
});
