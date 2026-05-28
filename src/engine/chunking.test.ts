import { describe, expect, test } from 'vitest';
import { TextChunker } from './chunking';

describe('TextChunker', () => {
  test('emits a sentence when a terminator is followed by space', () => {
    const c = new TextChunker();
    expect(c.push('Hello there. ')).toEqual(['Hello there.']);
  });

  test('buffers an incomplete sentence until flushed', () => {
    const c = new TextChunker();
    expect(c.push('Hello there')).toEqual([]);
    expect(c.flush()).toBe('Hello there');
  });

  test('emits on a clause boundary only after minWords', () => {
    const c = new TextChunker({ minWords: 3 });
    expect(c.push('one, ')).toEqual([]); // only 1 word before comma
    expect(c.push('two three four, ')).toEqual(['one, two three four,']);
  });

  test('force-emits at maxWords without punctuation', () => {
    const c = new TextChunker({ maxWords: 4 });
    expect(c.push('alpha beta gamma delta epsilon ')).toEqual(['alpha beta gamma delta']);
  });

  test('handles deltas split mid-token across pushes', () => {
    const c = new TextChunker();
    expect(c.push('Hel')).toEqual([]);
    expect(c.push('lo. ')).toEqual(['Hello.']);
  });

  test('flush returns null when buffer empty', () => {
    const c = new TextChunker();
    c.push('Done. ');
    expect(c.flush()).toBeNull();
  });
});
