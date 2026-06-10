import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
}

interface CreatedKey {
  id: string;
  name: string;
  key: string;
  prefix: string;
  createdAt: number;
}

function fmtAge(ms: number): string {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 h-7 w-7 rounded-full border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] text-muted-foreground hover:text-foreground transition-colors flex items-center justify-center"
      aria-label="Copy"
    >
      {copied ? <Check className="h-3 w-3 text-aurora-1" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

const CURL_EXAMPLE = (origin: string) => `curl -X POST ${origin}/api/v1/notetaker \\
  -H "x-api-key: cai_..." \\
  -F "audio=@meeting.mp3;type=audio/mpeg" \\
  -F "title=Weekly sync" \\
  -F "webhookUrl=https://your-app.example/hooks/notetaker"

# → 202 { "notetaker": { "id": "...", "status": "queued", ... } }
# When notes are ready your webhookUrl receives a POST signed with
# X-Notetaker-Signature: sha256=HMAC-SHA256(body, webhook secret).
# Or poll: GET ${origin}/api/v1/notetaker/<id>`;

export function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    api<{ apiKeys: ApiKeyRow[]; webhookSecret: string | null }>('/api/api-keys')
      .then((r) => {
        setKeys(r.apiKeys);
        setWebhookSecret(r.webhookSecret);
      })
      .finally(() => setLoading(false));
  }, []);

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const r = await api<{ apiKey: CreatedKey; webhookSecret: string }>('/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setCreated(r.apiKey);
      setWebhookSecret(r.webhookSecret);
      setKeys((cur) => [
        { id: r.apiKey.id, name: r.apiKey.name, prefix: r.apiKey.prefix, createdAt: r.apiKey.createdAt },
        ...cur,
      ]);
      setName('');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this API key? Requests using it will start failing immediately.')) return;
    setDeletingId(id);
    try {
      await api(`/api/api-keys/${id}`, { method: 'DELETE' });
      setKeys((cur) => cur.filter((k) => k.id !== id));
      if (created?.id === id) setCreated(null);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="fade-up">
      <header className="mb-10">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
          Workspace · API
        </div>
        <h1 className="font-display text-6xl tracking-tight leading-[0.95]">
          API <span className="italic text-aurora">keys</span>
        </h1>
        <p className="mt-4 text-[13px] text-muted-foreground max-w-md leading-relaxed">
          Send recordings to the notetaker from your own systems. Upload audio, get back a
          transcript and structured notes — by webhook or polling.
        </p>
      </header>

      <Card className="p-5 mb-6">
        <div className="flex items-center gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
            placeholder="Key name, e.g. “production ingest”"
            className="max-w-sm"
          />
          <Button onClick={create} disabled={creating || !name.trim()}>
            <Plus className="h-4 w-4" /> Create key
          </Button>
        </div>

        {created && (
          <div className="mt-4 rounded-xl border border-aurora-1/20 bg-aurora-1/[0.06] p-4">
            <p className="text-[11px] uppercase tracking-[0.18em] text-aurora-1 mb-2">
              Copy this key now — it will not be shown again
            </p>
            <div className="flex items-center gap-2">
              <code className="text-[13px] text-foreground/95 break-all">{created.key}</code>
              <CopyButton value={created.key} />
            </div>
          </div>
        )}
      </Card>

      {loading ? (
        <p className="text-sm text-muted-foreground italic font-display">Loading…</p>
      ) : keys.length === 0 ? (
        <Card className="py-16 text-center">
          <KeyRound className="mx-auto h-6 w-6 text-aurora-2 opacity-70" />
          <p className="mt-4 font-display italic text-xl text-foreground/90">No API keys yet.</p>
          <p className="text-sm text-muted-foreground mt-1">
            Create one to start sending recordings from your systems.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 stagger mb-6">
          {keys.map((k) => (
            <Card key={k.id} className="p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1 flex items-center gap-3">
                  <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-display text-lg tracking-tight text-foreground/95 truncate">
                    {k.name}
                  </span>
                  <Badge className="bg-white/[0.04] text-muted-foreground border-white/[0.08] font-mono">
                    {k.prefix}…
                  </Badge>
                </div>
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
                  {fmtAge(k.createdAt)}
                </span>
                <button
                  onClick={() => revoke(k.id)}
                  disabled={deletingId === k.id}
                  className="shrink-0 h-8 w-8 rounded-full border border-white/[0.08] bg-white/[0.02] hover:bg-red-500/10 hover:border-red-500/20 hover:text-red-400 text-muted-foreground transition-colors flex items-center justify-center disabled:opacity-40"
                  aria-label="Revoke"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {webhookSecret && (
        <Card className="p-5 mb-6">
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80 mb-2">
            Webhook signing secret
          </p>
          <div className="flex items-center gap-2">
            <code className="text-[13px] text-foreground/95 break-all">{webhookSecret}</code>
            <CopyButton value={webhookSecret} />
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground leading-relaxed">
            Verify webhook payloads by comparing <code>X-Notetaker-Signature</code> against an
            HMAC-SHA256 of the raw request body using this secret.
          </p>
        </Card>
      )}

      <Card className="p-5">
        <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground/80 mb-3">
          Quick start
        </p>
        <pre className="text-[12px] leading-relaxed text-foreground/85 overflow-x-auto whitespace-pre">
          {CURL_EXAMPLE(window.location.origin)}
        </pre>
      </Card>
    </div>
  );
}
