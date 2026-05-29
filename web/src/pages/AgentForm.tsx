import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, AURA_VOICES } from '@/lib/api';

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
};

export function AgentForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const [error, setError] = useState('');
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: DEFAULTS });
  const { register, control, handleSubmit, reset, formState } = form;
  const vars = useFieldArray({ control, name: 'variables' });
  const tools = useFieldArray({ control, name: 'tools' });

  useEffect(() => {
    if (!id) return;
    api<{ agent: FormValues }>(`/api/agents/${id}`).then((r) => reset({ ...DEFAULTS, ...r.agent }));
  }, [id, reset]);

  async function onSubmit(values: FormValues) {
    setError('');
    const payload = {
      ...values,
      tools: values.tools.map((t) => ({ ...t, webhookUrl: t.webhookUrl || undefined })),
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
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{editing ? 'Edit agent' : 'New agent'}</h1>
        <Button type="submit" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input placeholder="Support Bot" {...register('name')} />
            {formState.errors.name && <p className="text-xs text-destructive">{formState.errors.name.message}</p>}
          </div>
          <div className="space-y-1">
            <Label>Role</Label>
            <Input placeholder="customer support" {...register('role')} />
          </div>
          <div className="space-y-1">
            <Label>Voice</Label>
            <Select {...register('voice')}>
              {AURA_VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System prompt</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea rows={5} {...register('systemPromptTemplate')} />
          <p className="text-xs text-muted-foreground">
            Use <code>{'{{variable}}'}</code> placeholders. <code>{'{{agent_name}}'}</code> is always available.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Dynamic variables
            <Button type="button" variant="outline" size="sm" onClick={() => vars.append({ name: '', source: 'call_init', default: '' })}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {vars.fields.length === 0 && <p className="text-sm text-muted-foreground">No variables.</p>}
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            Tools (webhooks)
            <Button type="button" variant="outline" size="sm" onClick={() => tools.append({ name: '', description: '', webhookUrl: '' })}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {tools.fields.length === 0 && <p className="text-sm text-muted-foreground">No tools. (end_call & recall_memory are built in.)</p>}
          {tools.fields.map((f, i) => (
            <div key={f.id} className="flex gap-2 items-start">
              <Input placeholder="lookup_order" {...register(`tools.${i}.name`)} />
              <Input placeholder="description" {...register(`tools.${i}.description`)} />
              <Input placeholder="https://api.you.com/tool" {...register(`tools.${i}.webhookUrl`)} />
              <Button type="button" variant="ghost" size="icon" onClick={() => tools.remove(i)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Model</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Default model</Label>
            <Input {...register('llmTierPolicy.defaultModel')} />
          </div>
          <div className="space-y-1">
            <Label>Escalate model (optional)</Label>
            <Input placeholder="@cf/meta/llama-3.3-70b-instruct" {...register('llmTierPolicy.escalateModel')} />
          </div>
          <div className="space-y-1">
            <Label>Escalate on</Label>
            <Select {...register('llmTierPolicy.escalateOn')}>
              <option value="never">never</option>
              <option value="manual">manual</option>
              <option value="low_confidence">low_confidence</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
