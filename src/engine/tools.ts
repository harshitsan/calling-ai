export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolResult =
  | { type: 'continue'; content: string }
  | { type: 'endCall'; reason: string; farewell?: string };

export const END_CALL_TOOL: ToolDefinition = {
  name: 'end_call',
  description: 'End the call when the conversation is complete or the caller asks to hang up.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why the call is ending.' },
      farewell: { type: 'string', description: 'Optional closing line to speak before hanging up.' },
    },
    required: ['reason'],
  },
};

export function dispatchTool(call: ToolCall): ToolResult {
  switch (call.name) {
    case 'end_call':
      return {
        type: 'endCall',
        reason: typeof call.arguments.reason === 'string' ? call.arguments.reason : 'completed',
        farewell: typeof call.arguments.farewell === 'string' ? call.arguments.farewell : undefined,
      };
    default:
      return { type: 'continue', content: `Error: unknown tool "${call.name}".` };
  }
}
