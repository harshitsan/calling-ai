import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  safeParseNotes, realignSpeakers, parseCorrectionUtterances, transcribeViaDeepgram,
  alignSpeakerNames, parseTimeline,
} from './notetaker';

describe('transcribeViaDeepgram', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests multilingual transcription (language=multi, not detect_language)', async () => {
    let url = '';
    vi.stubGlobal('fetch', async (u: string) => {
      url = u;
      return new Response(
        JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'Hello नमस्ते', words: [] }] }] } }),
        { status: 200 },
      );
    });

    const out = await transcribeViaDeepgram('dg-key', new Uint8Array([1, 2, 3]), 'audio/mpeg');

    const q = new URL(url).searchParams;
    // Regression guard: detect_language picks ONE language and drops mixed
    // Hindi/English — language=multi keeps both.
    expect(q.get('language')).toBe('multi');
    expect(q.get('detect_language')).toBeNull();
    expect(q.get('model')).toBe('nova-3');
    expect(q.get('diarize')).toBe('true');
    expect(out.text).toBe('Hello नमस्ते');
  });
});

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

describe('realignSpeakers', () => {
  // Real data from job 0ad282fb: Deepgram mis-attributed the single word
  // "Welcome" to Speaker 1 (across a 3.5s gap), splitting the sentence
  // "Welcome back to California." The LLM correction pass regroups it.
  it('reassigns a word the LLM moved to the correct speaker', () => {
    const words = [
      { word: "that's", start: 4.0, end: 4.16, speaker: 1 },
      { word: 'for', start: 4.16, end: 4.32, speaker: 1 },
      { word: 'you.', start: 4.32, end: 4.64, speaker: 1 },
      { word: 'Welcome', start: 4.64, end: 5.0, speaker: 1 }, // WRONG → should be 0
      { word: 'back', start: 8.16, end: 8.32, speaker: 0 },
      { word: 'to', start: 8.32, end: 8.48, speaker: 0 },
      { word: 'California.', start: 8.48, end: 8.9, speaker: 0 },
    ];
    const utterances = [
      { speaker: 1, text: "that's for you." },
      { speaker: 0, text: 'Welcome back to California.' },
    ];
    const out = realignSpeakers(words, utterances);
    expect(out.find((w) => w.word === 'Welcome')!.speaker).toBe(0);
    // Every other word, its timing, and order is preserved.
    expect(out.length).toBe(words.length);
    expect(out.map((w) => w.word)).toEqual(words.map((w) => w.word));
    expect(out[0]!.start).toBe(4.0);
    expect(out.map((w) => w.speaker)).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });

  it('leaves speakers untouched when the LLM output does not align with the words', () => {
    // Fail-safe: a garbage / reworded LLM response must never corrupt labels.
    const words = [
      { word: 'hello', start: 0, end: 1, speaker: 0 },
      { word: 'world', start: 1, end: 2, speaker: 0 },
    ];
    const utterances = [{ speaker: 1, text: 'completely different words entirely' }];
    const out = realignSpeakers(words, utterances);
    expect(out.map((w) => w.speaker)).toEqual([0, 0]);
  });
});

describe('alignSpeakerNames', () => {
  // Word times are SECONDS; timeline segments are MILLISECONDS from start.
  const timeline = [
    { startMs: 0, endMs: 5000, name: 'Alex' },
    { startMs: 5000, endMs: 10000, name: 'Mira' },
  ];

  it('maps each speaker index to the name it overlaps most', () => {
    const words = [
      { word: 'hi', start: 0.0, end: 1.0, speaker: 0 },   // in Alex's window
      { word: 'there', start: 1.0, end: 2.0, speaker: 0 },
      { word: 'hello', start: 6.0, end: 7.0, speaker: 1 }, // in Mira's window
    ];
    expect(alignSpeakerNames(words, timeline)).toEqual({ '0': 'Alex', '1': 'Mira' });
  });

  it('assigns by MAXIMAL overlap when a speaker straddles a boundary', () => {
    // Speaker 0: 1s in Alex's window, 3s in Mira's → Mira wins.
    const words = [
      { word: 'a', start: 4.0, end: 5.0, speaker: 0 },
      { word: 'b', start: 5.0, end: 8.0, speaker: 0 },
    ];
    expect(alignSpeakerNames(words, timeline)).toEqual({ '0': 'Mira' });
  });

  it('leaves out indices with no timeline overlap (LLM fills them later)', () => {
    const words = [{ word: 'x', start: 50.0, end: 51.0, speaker: 3 }];
    expect(alignSpeakerNames(words, timeline)).toEqual({});
  });

  it('returns {} when there is no timeline', () => {
    expect(alignSpeakerNames([{ word: 'x', start: 0, end: 1, speaker: 0 }], [])).toEqual({});
  });

  it('ignores words without a speaker index', () => {
    const words = [{ word: 'x', start: 0, end: 1 }];
    expect(alignSpeakerNames(words, timeline)).toEqual({});
  });
});

describe('parseTimeline', () => {
  it('parses valid segments', () => {
    const raw = '[{"startMs":0,"endMs":1000,"name":"Alex"},{"startMs":1000,"endMs":2000,"name":"Mira"}]';
    expect(parseTimeline(raw)).toEqual([
      { startMs: 0, endMs: 1000, name: 'Alex' },
      { startMs: 1000, endMs: 2000, name: 'Mira' },
    ]);
  });

  it('drops malformed entries and tolerates junk', () => {
    expect(parseTimeline('[{"startMs":0,"endMs":1,"name":"A"},{"bad":true},42]'))
      .toEqual([{ startMs: 0, endMs: 1, name: 'A' }]);
    expect(parseTimeline('not json')).toEqual([]);
    expect(parseTimeline(null)).toEqual([]);
    expect(parseTimeline('{"not":"an array"}')).toEqual([]);
  });
});

describe('parseCorrectionUtterances', () => {
  it('parses a valid utterances payload', () => {
    const raw = '{"utterances":[{"speaker":0,"text":"Welcome back."},{"speaker":1,"text":"Thanks."}]}';
    expect(parseCorrectionUtterances(raw)).toEqual([
      { speaker: 0, text: 'Welcome back.' },
      { speaker: 1, text: 'Thanks.' },
    ]);
  });

  it('strips ```json fences', () => {
    const raw = '```json\n{"utterances":[{"speaker":2,"text":"Hi"}]}\n```';
    expect(parseCorrectionUtterances(raw)).toEqual([{ speaker: 2, text: 'Hi' }]);
  });

  it('drops entries with a missing or non-numeric speaker or empty text', () => {
    const raw = '{"utterances":[{"speaker":0,"text":"ok"},{"text":"no speaker"},{"speaker":1,"text":""},{"speaker":"x","text":"bad"}]}';
    expect(parseCorrectionUtterances(raw)).toEqual([{ speaker: 0, text: 'ok' }]);
  });

  it('returns [] on invalid JSON', () => {
    expect(parseCorrectionUtterances('not json at all')).toEqual([]);
  });
});
