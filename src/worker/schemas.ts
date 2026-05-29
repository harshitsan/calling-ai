import { z } from 'zod';

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  tenantName: z.string().min(1).max(80),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const AURA_VOICES = [
  'asteria', 'luna', 'stella', 'athena', 'hera',
  'orion', 'arcas', 'perseus', 'angus', 'orpheus', 'helios', 'zeus',
] as const;

export const VariableSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'must be a valid identifier'),
  source: z.enum(['static', 'call_init', 'memory', 'webhook']),
  default: z.string().optional(),
  live: z.boolean().optional(),
});

export const ToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  parameters: z.record(z.string(), z.unknown()).default({}),
  webhookUrl: z.string().url().optional(),
});

export const LlmTierPolicySchema = z.object({
  defaultModel: z.string().default('@cf/meta/llama-3.1-8b-instruct'),
  escalateModel: z.string().optional(),
  escalateOn: z.enum(['never', 'manual', 'low_confidence']).default('never'),
});

export const AgentSchema = z.object({
  name: z.string().min(1).max(120),
  avatar: z.string().url().optional(),
  voice: z.enum(AURA_VOICES).default('asteria'),
  role: z.string().max(200).optional(),
  systemPromptTemplate: z.string().default(''),
  variables: z.array(VariableSchema).default([]),
  tools: z.array(ToolSchema).default([]),
  llmTierPolicy: LlmTierPolicySchema.default({}),
});

export type AgentInput = z.infer<typeof AgentSchema>;
export type Variable = z.infer<typeof VariableSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export const AURA_VOICE_LIST = AURA_VOICES;
