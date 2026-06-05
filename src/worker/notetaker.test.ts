import { describe, expect, it } from 'vitest';
import { safeParseNotes } from './notetaker';

describe('safeParseNotes', () => {
  it('parses a valid JSON response', () => {
    const raw = `{
      "summary": "Discussed Q3 goals.",
      "actionItems": ["Send recap", "Schedule follow-up"],
      "keyTopics": ["pricing", "timeline"],
      "sentiment": "positive",
      "decisions": ["Move to staging Friday"],
      "speakers": ["Alex", "Mira"]
    }`;
    const out = safeParseNotes(raw);
    expect(out.summary).toBe('Discussed Q3 goals.');
    expect(out.actionItems).toEqual(['Send recap', 'Schedule follow-up']);
    expect(out.sentiment).toBe('positive');
    expect(out.speakers).toEqual(['Alex', 'Mira']);
  });

  it('strips ```json fences', () => {
    const raw = '```json\n{"summary":"x","actionItems":[],"keyTopics":[],"sentiment":"neutral","decisions":[],"speakers":[]}\n```';
    const out = safeParseNotes(raw);
    expect(out.summary).toBe('x');
  });

  it('strips conversational prefix before the JSON', () => {
    const raw = 'Sure, here are the notes:\n{"summary":"y","actionItems":[],"keyTopics":[],"sentiment":"neutral","decisions":[],"speakers":[]}\nLet me know if you need anything else.';
    const out = safeParseNotes(raw);
    expect(out.summary).toBe('y');
  });

  it('returns empty shape on invalid JSON', () => {
    const out = safeParseNotes('totally not json');
    expect(out.summary).toBe('');
    expect(out.actionItems).toEqual([]);
    expect(out.sentiment).toBe('neutral');
  });

  it('coerces unknown sentiment to neutral', () => {
    const raw = '{"summary":"","actionItems":[],"keyTopics":[],"sentiment":"euphoric","decisions":[],"speakers":[]}';
    expect(safeParseNotes(raw).sentiment).toBe('neutral');
  });

  it('filters non-string list entries', () => {
    const raw = '{"summary":"","actionItems":["ok",42,null,"good"],"keyTopics":[],"sentiment":"neutral","decisions":[],"speakers":[]}';
    expect(safeParseNotes(raw).actionItems).toEqual(['ok', 'good']);
  });

  it('returns empty arrays when fields missing entirely', () => {
    const raw = '{"summary":"z"}';
    const out = safeParseNotes(raw);
    expect(out.summary).toBe('z');
    expect(out.actionItems).toEqual([]);
    expect(out.keyTopics).toEqual([]);
    expect(out.decisions).toEqual([]);
    expect(out.speakers).toEqual([]);
  });
});
