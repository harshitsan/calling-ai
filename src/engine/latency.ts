import type { Clock, LatencyMark, TurnLatencySummary } from './types';

export class TurnLatency {
  private marks: Partial<Record<LatencyMark, number>> = {};

  constructor(private clock: Clock) {}

  mark(m: LatencyMark): void {
    if (this.marks[m] === undefined) this.marks[m] = this.clock.now();
  }

  summary(): TurnLatencySummary {
    const m = this.marks;
    const diff = (a?: number, b?: number) =>
      a !== undefined && b !== undefined ? b - a : undefined;
    return {
      endpointToFirstToken: diff(m.endOfTurn, m.llmFirstToken),
      firstTokenToFirstAudio: diff(m.llmFirstToken, m.ttsFirstAudio),
      endpointToFirstAudio: diff(m.endOfTurn, m.ttsFirstAudio),
      marks: { ...m },
    };
  }
}
