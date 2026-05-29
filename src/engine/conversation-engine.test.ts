import { describe, expect, test } from 'vitest';
import { ConversationEngine } from './conversation-engine';
import { FakeClient, FakeLlm, FakeStt, FakeTts, ManualClock } from './testing/fakes';

function makeEngine(llm: FakeLlm) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const client = new FakeClient();
  const engine = new ConversationEngine({
    stt,
    llm,
    tts,
    client,
    clock: new ManualClock(0),
    systemPrompt: 'You are a helpful agent.',
  });
  engine.start();
  return { engine, stt, tts, client };
}

describe('ConversationEngine', () => {
  test('runs a turn: STT end-of-turn -> LLM -> chunked TTS -> audio to client', async () => {
    const llm = new FakeLlm([
      { type: 'text', text: 'Hi there. ' },
      { type: 'text', text: 'How can I help?' },
      { type: 'done' },
    ]);
    const { engine, stt, tts, client } = makeEngine(llm);

    stt.emit({ type: 'endOfTurn', text: 'hello' });
    await new Promise((r) => setTimeout(r, 0));

    expect(tts.calls).toEqual(['Hi there.', 'How can I help?']);
    expect(client.audioText()).toEqual(['Hi there.', 'How can I help?']);
    expect(engine.getState()).toBe('listening');
    const history = engine.getHistory();
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'Hi there. How can I help?' });
  });

  test('emits a latency summary on first audio', async () => {
    const llm = new FakeLlm([{ type: 'text', text: 'Ok. ' }, { type: 'done' }]);
    const { stt, client } = makeEngine(llm);
    stt.emit({ type: 'endOfTurn', text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));
    expect(client.events.some((e) => e.type === 'latency')).toBe(true);
  });

  test('end_call tool ends the call and speaks the farewell', async () => {
    const llm = new FakeLlm([
      { type: 'toolCall', id: 't1', name: 'end_call', arguments: { reason: 'done', farewell: 'Goodbye!' } },
    ]);
    const { engine, stt, tts, client } = makeEngine(llm);
    stt.emit({ type: 'endOfTurn', text: 'bye' });
    await new Promise((r) => setTimeout(r, 0));

    expect(tts.calls).toEqual(['Goodbye!']);
    expect(engine.getState()).toBe('ended');
    expect(stt.closed).toBe(true);
    expect(client.events.some((e) => e.type === 'ended' && e.reason === 'done')).toBe(true);
  });

  test('barge-in cancels the turn, flushes, and returns to listening', async () => {
    const llm = new FakeLlm([
      { type: 'text', text: 'One. ' },
      { type: 'text', text: 'Two. ' },
      { type: 'text', text: 'Three. ' },
      { type: 'done' },
    ]);
    const { engine, stt, client } = makeEngine(llm);
    const turn = (async () => {
      stt.emit({ type: 'endOfTurn', text: 'go' });
    })();
    engine.interrupt(); // interrupt immediately
    await turn;
    await new Promise((r) => setTimeout(r, 0));

    expect(client.events.some((e) => e.type === 'flush')).toBe(true);
    expect(engine.getState()).toBe('listening');
  });
});
