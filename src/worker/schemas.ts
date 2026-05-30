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

// Voice IDs use a "<model>:<speaker>" form (e.g. "aura2en:luna", "aura2es:carina");
// bare ids (e.g. "asteria") stay on Aura-1 for backwards compatibility.

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

export const InboundLookupSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST']).default('POST'),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.coerce.number().int().min(500).max(15000).default(5000),
});

export const EndWebhookSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});

export const LlmTierPolicySchema = z.object({
  defaultModel: z.string().default('gpt-4o-mini'),
  escalateModel: z.string().optional(),
  escalateOn: z.enum(['never', 'manual', 'low_confidence']).default('never'),
});

export const AgentSchema = z.object({
  name: z.string().min(1).max(120),
  avatar: z.string().url().optional(),
  voice: z.string().default('aura2en:luna'),
  role: z.string().max(200).optional(),
  systemPromptTemplate: z.string().default(''),
  variables: z.array(VariableSchema).default([]),
  tools: z.array(ToolSchema).default([]),
  llmTierPolicy: LlmTierPolicySchema.default({}),
  endpointingMs: z.coerce.number().int().min(200).max(4000).default(900),
  language: z.string().default('en-US'),
  inboundLookup: InboundLookupSchema.optional().nullable(),
  endWebhook: EndWebhookSchema.optional().nullable(),
});

export type AgentInput = z.infer<typeof AgentSchema>;
export type Variable = z.infer<typeof VariableSchema>;
export type Tool = z.infer<typeof ToolSchema>;
