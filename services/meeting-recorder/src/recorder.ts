import { spawn, type ChildProcess } from 'node:child_process';

export interface RecorderOptions {
  outputPath: string;
  inputArgs: string[]; // e.g. ['-f','pulse','-i','meet_sink.monitor']
}

export class Recorder {
  private proc: ChildProcess | null = null;

  constructor(private opts: RecorderOptions) {}

  start(): void {
    if (this.proc) throw new Error('recorder already started');
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      ...this.opts.inputArgs,
      '-ac', '1',
      '-ar', '16000',
      '-codec:a', 'libmp3lame',
      '-qscale:a', '4',
      '-y',
      this.opts.outputPath,
    ];
    this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      proc.once('close', () => resolve());
      // 'q' tells ffmpeg to finalize the file gracefully; fall back to SIGINT.
      try { proc.stdin?.write('q'); } catch { /* ignore */ }
      proc.kill('SIGINT');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 5000);
    });
  }
}
