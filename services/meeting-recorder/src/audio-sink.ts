// Per-session PulseAudio sinks. Each recording session gets its own null
// sink: the session's Chromium is launched with PULSE_SINK=<name> so meeting
// audio plays only into that sink, and the session's ffmpeg records only that
// sink's .monitor. Without this, parallel sessions all play into one shared
// sink and every recording captures every meeting's audio mixed together.

export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

/** pactl sink names must be simple tokens — keep [a-z0-9], cap the length. */
export function sinkNameFor(sessionId: string): string {
  return `snk_${sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
}

export async function createSessionSink(
  exec: ExecFn,
  sessionId: string,
): Promise<{ sinkName: string; moduleId: string }> {
  const sinkName = sinkNameFor(sessionId);
  const { stdout } = await exec('pactl', [
    'load-module', 'module-null-sink',
    `sink_name=${sinkName}`,
    `sink_properties=device.description=${sinkName}`,
  ]);
  return { sinkName, moduleId: stdout.trim() };
}

export async function removeSessionSink(exec: ExecFn, moduleId: string): Promise<void> {
  await exec('pactl', ['unload-module', moduleId]);
}
