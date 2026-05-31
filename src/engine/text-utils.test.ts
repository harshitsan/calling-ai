import { describe, expect, test } from 'vitest';
import { stripMarkdownForTts } from './text-utils';

describe('stripMarkdownForTts', () => {
  test('strips bold markers around a word', () => {
    expect(stripMarkdownForTts('**Hello** world')).toBe('Hello world');
  });

  test('strips italic markers around a word', () => {
    expect(stripMarkdownForTts('Sure, *one* second')).toBe('Sure, one second');
  });

  test('strips leading numbered list markers from each line', () => {
    const input = '1. Price\n2. Reviews\n3. Recommendations';
    expect(stripMarkdownForTts(input)).toBe('Price\nReviews\nRecommendations');
  });

  test('preserves decimals and currency that look like list markers', () => {
    expect(stripMarkdownForTts('version 1.5 costs $1.99')).toBe('version 1.5 costs $1.99');
  });
});
