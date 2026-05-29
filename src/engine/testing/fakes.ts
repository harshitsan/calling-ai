import type { Clock } from '../types';

export class ManualClock implements Clock {
  constructor(private t: number = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
