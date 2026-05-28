export interface ChunkerOptions {
  minWords?: number;
  maxWords?: number;
}

export class TextChunker {
  private buffer = '';
  private readonly minWords: number;
  private readonly maxWords: number;

  constructor(opts: ChunkerOptions = {}) {
    this.minWords = opts.minWords ?? 3;
    this.maxWords = opts.maxWords ?? 20;
  }

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let chunk: string | null;
    while ((chunk = this.extract()) !== null) out.push(chunk);
    return out;
  }

  flush(): string | null {
    const text = this.buffer.trim();
    this.buffer = '';
    return text.length > 0 ? text : null;
  }

  private wordCount(s: string): number {
    const t = s.trim();
    return t.length === 0 ? 0 : t.split(/\s+/).length;
  }

  private extract(): string | null {
    const buf = this.buffer;
    // Earliest boundary that is valid to emit: sentence-ender always,
    // clause-ender only once minWords is reached. Punctuation must be
    // followed by whitespace (avoids splitting "3.14" or mid-stream tokens).
    const re = /[.!?,;:](?=\s)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(buf)) !== null) {
      const idx = m.index;
      const piece = buf.slice(0, idx + 1);
      const isSentence = buf[idx] === '.' || buf[idx] === '!' || buf[idx] === '?';
      if (isSentence || this.wordCount(piece) >= this.minWords) {
        this.buffer = buf.slice(idx + 1).replace(/^\s+/, '');
        return piece.trim();
      }
    }
    // Force-emit to bound latency on a long run-on with no punctuation.
    if (this.wordCount(buf) >= this.maxWords) {
      const words = buf.trim().split(/\s+/);
      const take = words.slice(0, this.maxWords).join(' ');
      this.buffer = words.slice(this.maxWords).join(' ');
      return take.trim();
    }
    return null;
  }
}
