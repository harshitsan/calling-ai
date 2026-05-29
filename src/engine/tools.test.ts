import { describe, expect, test } from 'vitest';
import { END_CALL_TOOL, dispatchTool } from './tools';

describe('tools', () => {
  test('end_call tool definition is exposed', () => {
    expect(END_CALL_TOOL.name).toBe('end_call');
    expect(END_CALL_TOOL.parameters.required).toContain('reason');
  });

  test('dispatch end_call returns endCall result with reason + farewell', () => {
    const r = dispatchTool({ id: '1', name: 'end_call', arguments: { reason: 'done', farewell: 'Bye!' } });
    expect(r).toEqual({ type: 'endCall', reason: 'done', farewell: 'Bye!' });
  });

  test('dispatch end_call defaults reason when missing', () => {
    const r = dispatchTool({ id: '1', name: 'end_call', arguments: {} });
    expect(r).toEqual({ type: 'endCall', reason: 'completed', farewell: undefined });
  });

  test('unknown tool returns a continue error', () => {
    const r = dispatchTool({ id: '2', name: 'mystery', arguments: {} });
    expect(r).toEqual({ type: 'continue', content: 'Error: unknown tool "mystery".' });
  });
});
