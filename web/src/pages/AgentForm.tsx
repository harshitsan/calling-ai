import { zodResolver } from '@hookform/resolvers/zod';
import { Bot, MessageSquareQuote, Play, Plus, Settings2, Sparkles, Trash2, Webhook } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { languageLabel, VOICES, voiceById } from '@/lib/voices';
import { cn } from '@/lib/utils';

const schema = z.object({
  name: z.string().min(1, 'name required'),
  voice: z.string(),
  role: z.string().optional(),
  systemPromptTemplate: z.string(),
  variables: z.array(
    z.object({
      name: z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'identifier only'),
      source: z.enum(['static', 'call_init', 'memory', 'webhook']),
      default: z.string().optional(),
    }),
  ),
  tools: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      webhookUrl: z.string().url('must be a URL').optional().or(z.literal('')),
    }),
  ),
  llmTierPolicy: z.object({
    defaultModel: z.string(),
    escalateModel: z.string().optional(),
    escalateOn: z.enum(['never', 'manual', 'low_confidence']),
  }),
  endpointingMs: z.coerce.number().int().min(200).max(4000),
  language: z.string(),
  inboundLookup: z.object({
    url: z.string().refine((v) => v === '' || /^https?:\/\//.test(v), 'must be a URL'),
    method: z.enum(['GET', 'POST']),
    headersJson: z.string(),
    timeoutMs: z.coerce.number().int().min(500).max(15000),
  }),
  endWebhook: z.object({
    url: z.string().refine((v) => v === '' || /^https?:\/\//.test(v), 'must be a URL'),
    headersJson: z.string(),
  }),
});
type FormValues = z.infer<typeof schema>;

const DEFAULTS: FormValues = {
  name: '',
  voice: 'asteria',
  role: '',
  systemPromptTemplate: 'You are {{agent_name}}, a helpful voice agent. Keep replies short and natural.',
  variables: [],
  tools: [],
  llmTierPolicy: { defaultModel: 'gpt-4o-mini', escalateModel: '', escalateOn: 'never' },
  endpointingMs: 900,
  language: 'en-US',
  inboundLookup: { url: '', method: 'POST', headersJson: '', timeoutMs: 5000 },
  endWebhook: { url: '', headersJson: '' },
};

const TABS = [
  { id: 'identity', label: 'Identity', icon: Bot, hint: 'Name, voice, role' },
  { id: 'prompt', label: 'Prompt', icon: MessageSquareQuote, hint: 'What it says' },
  { id: 'behavior', label: 'Behavior', icon: Sparkles, hint: 'Model, turn-taking' },
  { id: 'tools', label: 'Tools', icon: Settings2, hint: 'Webhook actions' },
  { id: 'integrations', label: 'Integrations', icon: Webhook, hint: 'External systems' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function parseHeaders(s: string): Record<string, string> {
  if (!s.trim()) return {};
  try {
    const j = JSON.parse(s);
    if (!j || typeof j !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

export function AgentForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<TabId>('identity');
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });
  const { register, control, handleSubmit, reset, formState } = form;
  const vars = useFieldArray({ control, name: 'variables' });
  const tools = useFieldArray({ control, name: 'tools' });
  const currentVoice = useWatch({ control, name: 'voice' });
  const currentName = useWatch({ control, name: 'name' });
  const currentVoiceMeta = voiceById(currentVoice);
  const [previewing, setPreviewing] = useState(false);
  const previewAudio = useRef<HTMLAudioElement | null>(null);

  async function previewVoice() {
    if (previewing) return;
    setPreviewing(true);
    const speakerName = (currentName || 'Aurora').trim();
    const text = `Hello, this is ${speakerName}. I'd love to help you today.`;
    try {
      const res = await fetch(`/api/tts?voice=${encodeURIComponent(currentVoice)}&text=${encodeURIComponent(text)}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (previewAudio.current) {
        previewAudio.current.pause();
        try { URL.revokeObjectURL(previewAudio.current.src); } catch { /* ignore */ }
      }
      const audio = new Audio(url);
      previewAudio.current = audio;
      audio.onended = () => setPreviewing(false);
      audio.onerror = () => setPreviewing(false);
      await audio.play();
    } catch {
      setPreviewing(false);
    }
  }

  useEffect(() => {
    if (!id) return;
    api<{ agent: any }>(`/api/agents/${id}`).then((r) =>
      reset({
        ...DEFAULTS,
        ...r.agent,
        inboundLookup: r.agent.inboundLookup
          ? {
              url: r.agent.inboundLookup.url ?? '',
              method: r.agent.inboundLookup.method ?? 'POST',
              headersJson: JSON.stringify(r.agent.inboundLookup.headers ?? {}, null, 2),
              timeoutMs: r.agent.inboundLookup.timeoutMs ?? 5000,
            }
          : DEFAULTS.inboundLookup,
        endWebhook: r.agent.endWebhook
          ? {
              url: r.agent.endWebhook.url ?? '',
              headersJson: JSON.stringify(r.agent.endWebhook.headers ?? {}, null, 2),
            }
          : DEFAULTS.endWebhook,
      }),
    );
  }, [id, reset]);

  async function onSubmit(values: FormValues) {
    setError('');
    const payload: any = {
      ...values,
      tools: values.tools.map((t) => ({ ...t, webhookUrl: t.webhookUrl || undefined })),
      inboundLookup: values.inboundLookup.url
        ? {
            url: values.inboundLookup.url,
            method: values.inboundLookup.method,
            headers: parseHeaders(values.inboundLookup.headersJson),
            timeoutMs: values.inboundLookup.timeoutMs,
          }
        : null,
      endWebhook: values.endWebhook.url
        ? { url: values.endWebhook.url, headers: parseHeaders(values.endWebhook.headersJson) }
        : null,
    };
    try {
      await api(editing ? `/api/agents/${id}` : '/api/agents', {
        method: editing ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      navigate('/agents');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-8 fade-up">
      <header className="flex items-end justify-between gap-6">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
            {editing ? 'Editing' : 'Composing'}
          </div>
          <h1 className="font-display text-6xl tracking-tight leading-[0.95]">
            {editing ? 'Tune the' : 'A new'} <span className="italic text-aurora">voice</span>
          </h1>
        </div>
        <Button type="submit" size="lg" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? 'Saving…' : 'Save agent'}
        </Button>
      </header>

      {/* Tab nav */}
      <div className="glass rounded-2xl p-1.5 flex gap-1 flex-wrap">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'group flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[12px] tracking-tight transition-all duration-200',
                active
                  ? 'bg-white/[0.07] text-foreground border border-white/[0.08] shadow-[inset_0_1px_0_hsl(0_0%_100%/0.06)]'
                  : 'text-muted-foreground hover:text-foreground/95 hover:bg-white/[0.025]',
              )}
            >
              <Icon className="h-[14px] w-[14px] opacity-80" />
              <span>{t.label}</span>
              <span className="hidden md:inline text-[10px] uppercase tracking-[0.16em] opacity-50">{t.hint}</span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="fade-up" key={tab}>
        {tab === 'identity' && (
          <Card>
            <CardHeader>
              <CardTitle>Identity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input placeholder="Mira" {...register('name')} />
                {formState.errors.name && <p className="text-xs text-destructive/90">{formState.errors.name.message}</p>}
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Input placeholder="customer support concierge" {...register('role')} />
              </div>
              <div className="space-y-2">
                <Label>Voice</Label>
                <div className="flex gap-2">
                  <Select {...register('voice')} className="flex-1">
                    <optgroup label="◌ Female">
                      {VOICES.filter((v) => v.gender === 'female').map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label} {v.description ? `· ${v.description}` : ''}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="◌ Male">
                      {VOICES.filter((v) => v.gender === 'male').map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label} {v.description ? `· ${v.description}` : ''}
                        </option>
                      ))}
                    </optgroup>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    onClick={previewVoice}
                    disabled={previewing}
                    className="shrink-0 px-4"
                  >
                    <Play className={`h-3.5 w-3.5 ${previewing ? 'opacity-50' : ''}`} />
                    {previewing ? 'Playing…' : 'Preview'}
                  </Button>
                </div>
                {currentVoiceMeta && currentVoiceMeta.languages.length === 1 && (
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
                    {languageLabel(currentVoiceMeta.languages[0]!)} only
                  </p>
                )}
              </div>

              {currentVoiceMeta && currentVoiceMeta.languages.length > 1 && (
                <div className="space-y-2 ring-aurora rounded-md p-3">
                  <Label>Language</Label>
                  <Select {...register('language')} className="border-0 bg-white/[0.04]">
                    {currentVoiceMeta.languages.map((code) => (
                      <option key={code} value={code}>
                        {languageLabel(code)}
                      </option>
                    ))}
                  </Select>
                  <p className="text-[11px] text-muted-foreground/80">
                    {currentVoiceMeta.label} is multilingual — pick the language to speak in.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {tab === 'prompt' && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>System prompt</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea rows={7} {...register('systemPromptTemplate')} />
                <p className="text-[11px] text-muted-foreground/80">
                  Use <code className="text-foreground/90">{'{{variable}}'}</code> placeholders.{' '}
                  <code className="text-foreground/90">{'{{agent_name}}'}</code> is always available.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  Dynamic variables
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => vars.append({ name: '', source: 'call_init', default: '' })}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {vars.fields.length === 0 && (
                  <p className="text-sm text-muted-foreground italic font-display">No variables.</p>
                )}
                {vars.fields.map((f, i) => (
                  <div key={f.id} className="flex gap-2 items-start">
                    <Input placeholder="customer_name" {...register(`variables.${i}.name`)} />
                    <Select {...register(`variables.${i}.source`)} className="w-40">
                      <option value="call_init">call_init</option>
                      <option value="static">static</option>
                      <option value="memory">memory</option>
                      <option value="webhook">webhook</option>
                    </Select>
                    <Input placeholder="default" {...register(`variables.${i}.default`)} />
                    <Button type="button" variant="ghost" size="icon" onClick={() => vars.remove(i)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}

        {tab === 'behavior' && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Turn-taking</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label>End-of-turn pause (ms)</Label>
                <Input
                  type="number"
                  min={200}
                  max={4000}
                  step={50}
                  {...register('endpointingMs')}
                  className="w-40"
                />
                <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                  How long the caller must pause before the agent treats the sentence as finished and replies.
                  Lower = snappier; higher = more patient.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Model</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>Default model</Label>
                  <Input {...register('llmTierPolicy.defaultModel')} />
                  <p className="text-[11px] text-muted-foreground/80">
                    <code className="text-foreground/85">gpt-4o-mini</code> (default, fast),{' '}
                    <code className="text-foreground/85">gpt-4o</code>, or{' '}
                    <code className="text-foreground/85">@cf/…</code> for Workers AI.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>Escalate model (optional)</Label>
                  <Input placeholder="gpt-4o" {...register('llmTierPolicy.escalateModel')} />
                </div>
                <div className="space-y-2">
                  <Label>Escalate on</Label>
                  <Select {...register('llmTierPolicy.escalateOn')}>
                    <option value="never">never</option>
                    <option value="manual">manual</option>
                    <option value="low_confidence">low_confidence</option>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {tab === 'tools' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                Tools (webhook actions)
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => tools.append({ name: '', description: '', webhookUrl: '' })}
                >
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {tools.fields.length === 0 && (
                <p className="text-sm text-muted-foreground italic font-display">
                  No tools. <span className="not-italic font-sans text-muted-foreground/70">end_call &amp; recall_memory are built in.</span>
                </p>
              )}
              {tools.fields.map((f, i) => (
                <div key={f.id} className="space-y-2 rounded-xl border border-white/[0.05] p-3">
                  <div className="flex gap-2 items-start">
                    <Input placeholder="lookup_order" {...register(`tools.${i}.name`)} />
                    <Input placeholder="description for the model" {...register(`tools.${i}.description`)} />
                    <Button type="button" variant="ghost" size="icon" onClick={() => tools.remove(i)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <Input placeholder="https://api.you.com/tool" {...register(`tools.${i}.webhookUrl`)} />
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {tab === 'integrations' && (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Inbound API call</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                  Called when a call starts; its JSON response is merged into your prompt variables (any variable
                  with source <code className="text-foreground/85">webhook</code> picks up its value by key name).
                </p>
                <div className="flex gap-2">
                  <Select {...register('inboundLookup.method')} className="w-24">
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                  </Select>
                  <Input placeholder="https://api.you.com/lookup" {...register('inboundLookup.url')} />
                </div>
                <Label className="text-[10px]">Headers (JSON, optional)</Label>
                <Textarea
                  rows={3}
                  placeholder='{"Authorization": "Bearer ..."}'
                  className="font-mono text-xs"
                  {...register('inboundLookup.headersJson')}
                />
                <p className="text-[11px] text-muted-foreground/80">
                  Payload: <code className="text-foreground/85">{'{caller, agentId, callId}'}</code>. Timeout (ms):{' '}
                  <input
                    {...register('inboundLookup.timeoutMs')}
                    className="ml-1 w-20 rounded-md bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 text-[11px] text-foreground/90"
                  />
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>End-of-call webhook</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
                  POSTed when the call ends, with{' '}
                  <code className="text-foreground/85">
                    {'{callId, agentId, caller, startedAt, endedAt, durationS, endReason, summary, transcript, costUsd}'}
                  </code>
                  .
                </p>
                <Input placeholder="https://api.you.com/calls/ended" {...register('endWebhook.url')} />
                <Label className="text-[10px]">Headers (JSON, optional)</Label>
                <Textarea
                  rows={3}
                  placeholder='{"Authorization": "Bearer ..."}'
                  className="font-mono text-xs"
                  {...register('endWebhook.headersJson')}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive/90">{error}</p>}
    </form>
  );
}
