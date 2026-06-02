import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Network,
  Phone,
  Radio,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface StreamingCfg {
  enabled: boolean;
  apiKeyPrefix: string | null;
  apiKeyCreatedAt: number | null;
}
interface PstnCfg {
  enabled: boolean;
  provider: string | null;
  accountId: string | null;
  authToken: string | null;        // redacted ••••XXXX or null
  phoneNumbers: string[];
  endpointUrl: string | null;
  extra: Record<string, unknown>;
}
interface SipCfg {
  enabled: boolean;
  uri: string | null;
  authMethod: 'ip_allowlist' | 'digest' | null;
  allowedIps: string[];
  digestUser: string | null;
  digestPass: string | null;
}
interface Integrations {
  streaming: StreamingCfg;
  pstn: PstnCfg;
  sip: SipCfg;
  updatedAt: number;
}

const PSTN_PROVIDERS = [
  { id: 'twilio', label: 'Twilio' },
  { id: 'vonage', label: 'Vonage' },
  { id: 'plivo', label: 'Plivo' },
  { id: 'telnyx', label: 'Telnyx' },
  { id: 'acefone', label: 'Acefone' },
  { id: 'other', label: 'Other' },
];

type CardKey = 'pstn' | 'streaming' | 'sip';

export function VoiceIntegrations() {
  const [data, setData] = useState<Integrations | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<CardKey | null>(null);

  useEffect(() => {
    api<{ integrations: Integrations }>('/api/voice-integrations')
      .then((r) => setData(r.integrations))
      .finally(() => setLoading(false));
  }, []);

  function reload() {
    return api<{ integrations: Integrations }>('/api/voice-integrations').then((r) => {
      setData(r.integrations);
      return r.integrations;
    });
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground italic font-display">Loading…</p>;
  }
  if (!data) {
    return <p className="text-sm text-red-400 italic">Failed to load integrations.</p>;
  }

  return (
    <div className="fade-up">
      <header className="mb-10">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
          Workspace · Voice
        </div>
        <h1 className="font-display text-6xl tracking-tight leading-[0.95]">
          Voice <span className="italic text-aurora">integrations</span>
        </h1>
        <p className="mt-4 text-[13px] text-muted-foreground max-w-xl leading-relaxed">
          Connect your telephony to calling-ai. Each modality is configured per tenant —
          enable what you need, leave the rest off.
        </p>
      </header>

      <Card className="p-4 mb-6 flex items-center justify-between gap-4 bg-aurora-1/[0.04] border-aurora-1/15">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-aurora-1/15 border border-aurora-1/20 flex items-center justify-center text-aurora-1">
            <BookOpen className="h-5 w-5" />
          </div>
          <div>
            <div className="text-[13px] font-display tracking-tight text-foreground/95">
              First time? Read the Tata Teleservices setup guide.
            </div>
            <p className="text-[11px] text-muted-foreground/75 mt-0.5 leading-relaxed">
              Step-by-step walkthrough — carrier portal + dashboard, ~15 minutes.
            </p>
          </div>
        </div>
        <Button asChild variant="outline">
          <Link to="/integrations/tata">Open guide →</Link>
        </Button>
      </Card>

      <div className="grid gap-5 md:grid-cols-3 mb-6">
        <ModalityCard
          k="pstn"
          icon={<Phone className="h-5 w-5" />}
          title="PSTN / VoIP"
          description="Own a phone number; route inbound/outbound dialing through a carrier."
          status="coming-soon"
          enabled={data.pstn.enabled}
          configured={!!data.pstn.provider}
          expanded={expanded === 'pstn'}
          onToggle={() => setExpanded((v) => (v === 'pstn' ? null : 'pstn'))}
        />
        <ModalityCard
          k="streaming"
          icon={<Radio className="h-5 w-5" />}
          title="Voice Streaming"
          description="Stream media from your PBX / contact-center to calling-ai over WebSocket."
          status="live"
          enabled={data.streaming.enabled}
          configured={!!data.streaming.apiKeyPrefix}
          expanded={expanded === 'streaming'}
          onToggle={() => setExpanded((v) => (v === 'streaming' ? null : 'streaming'))}
        />
        <ModalityCard
          k="sip"
          icon={<Network className="h-5 w-5" />}
          title="SIP Trunking"
          description="Point your SBC / PBX at our SIP URI for direct trunk connection."
          status="preview"
          enabled={data.sip.enabled}
          configured={!!data.sip.uri}
          expanded={expanded === 'sip'}
          onToggle={() => setExpanded((v) => (v === 'sip' ? null : 'sip'))}
        />
      </div>

      {expanded === 'streaming' && <StreamingEditor data={data.streaming} reload={reload} />}
      {expanded === 'pstn' && <PstnEditor data={data.pstn} reload={reload} />}
      {expanded === 'sip' && <SipEditor data={data.sip} reload={reload} />}
    </div>
  );
}

interface CardProps {
  k: CardKey;
  icon: React.ReactNode;
  title: string;
  description: string;
  status: 'live' | 'coming-soon' | 'preview';
  enabled: boolean;
  configured: boolean;
  expanded: boolean;
  onToggle: () => void;
}
function ModalityCard({
  icon, title, description, status, enabled, configured, expanded, onToggle,
}: CardProps) {
  const statusBadge =
    status === 'live' ? (
      <Badge className="bg-emerald-400/15 text-emerald-400 border-emerald-400/20">Live</Badge>
    ) : status === 'preview' ? (
      <Badge className="bg-amber-400/15 text-amber-400 border-amber-400/20">Preview</Badge>
    ) : (
      <Badge className="bg-white/[0.06] text-muted-foreground border-white/[0.10]">Coming soon</Badge>
    );

  return (
    <Card
      onClick={onToggle}
      className={cn(
        'p-5 cursor-pointer transition-all relative overflow-hidden group',
        expanded && 'border-aurora-1/40 bg-white/[0.04]',
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="h-10 w-10 rounded-xl bg-aurora-1/15 border border-aurora-1/20 flex items-center justify-center text-aurora-1">
          {icon}
        </div>
        {statusBadge}
      </div>
      <h3 className="font-display text-2xl tracking-tight text-foreground/95 mb-1">{title}</h3>
      <p className="text-[12px] text-muted-foreground leading-relaxed mb-4">{description}</p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em]">
          {enabled && configured ? (
            <span className="text-emerald-400/85 flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3" /> active
            </span>
          ) : configured ? (
            <span className="text-amber-400/85 flex items-center gap-1.5">
              <AlertCircle className="h-3 w-3" /> configured, off
            </span>
          ) : (
            <span className="text-muted-foreground/70">not configured</span>
          )}
        </div>
        <span className="text-[10px] uppercase tracking-[0.18em] text-aurora-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {expanded ? 'close ↑' : 'configure →'}
        </span>
      </div>
    </Card>
  );
}

// ----- Streaming editor -----
function StreamingEditor({ data, reload }: { data: StreamingCfg; reload: () => Promise<Integrations> }) {
  const [enabled, setEnabled] = useState(data.enabled);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);

  useEffect(() => setEnabled(data.enabled), [data.enabled]);

  const wsHost = typeof window !== 'undefined' ? window.location.host : 'YOUR-DOMAIN';
  const wsProto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsRaw = `${wsProto}://${wsHost}/call`;
  const wsTata = `${wsProto}://${wsHost}/voice/stream/tata`;

  async function toggle(next: boolean) {
    setSaving(true);
    try {
      await api('/api/voice-integrations/streaming', {
        method: 'PUT',
        body: JSON.stringify({ enabled: next }),
      });
      setEnabled(next);
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    if (data.apiKeyPrefix && !confirm('Rotating revokes the current key. Continue?')) return;
    setRotating(true);
    setFreshKey(null);
    try {
      const r = await api<{ apiKey: string }>('/api/voice-integrations/streaming/rotate', { method: 'POST' });
      setFreshKey(r.apiKey);
      await reload();
    } finally {
      setRotating(false);
    }
  }

  function copy(s: string) {
    navigator.clipboard?.writeText(s).catch(() => {});
  }

  return (
    <Card className="p-6 mt-2">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="font-display text-2xl tracking-tight">Voice Streaming · BYOC</h3>
          <p className="text-[12px] text-muted-foreground mt-1 max-w-xl leading-relaxed">
            Your contact-center / PBX connects directly to our streaming endpoint, authenticates with
            the API key below, and pipes media in both directions.
          </p>
        </div>
        <Toggle on={enabled} disabled={saving} onChange={toggle} />
      </div>

      <div className="space-y-4">
        <div>
          <Label>Streaming endpoints</Label>
          <p className="text-[11px] text-muted-foreground/65 mt-1 mb-2">
            Two wire formats supported — pick whichever your PBX speaks.
          </p>
          <div className="space-y-2">
            <EndpointRow label="Raw PCM (internal)" url={wsRaw} onCopy={() => copy(wsRaw)} note="16 kHz linear16, 60 ms frames, our JSON envelope." />
            <EndpointRow label="Tata / Twilio Media Streams" url={wsTata} onCopy={() => copy(wsTata)} note="8 kHz μ-law base64, 20 ms frames, connected/start/media/stop events." />
          </div>
        </div>

        <div>
          <Label>API key</Label>
          {!data.apiKeyPrefix && !freshKey ? (
            <div className="mt-1.5 rounded-md bg-white/[0.02] border border-white/[0.06] border-dashed p-4 text-center">
              <p className="text-[12px] text-muted-foreground mb-3">
                No key generated yet. Create one to authenticate your inbound stream.
              </p>
              <Button onClick={rotate} disabled={rotating}>
                {rotating ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Generating…</>
                ) : (
                  <><Sparkles className="h-4 w-4" /> Generate API key</>
                )}
              </Button>
            </div>
          ) : (
            <div className="mt-1.5 space-y-2">
              {freshKey && (
                <div className="rounded-md bg-emerald-500/10 border border-emerald-500/25 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-[0.18em] text-emerald-400/90 flex items-center gap-1.5">
                      <KeyRound className="h-3 w-3" /> Shown once
                    </span>
                    <button
                      type="button"
                      onClick={() => copy(freshKey)}
                      className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  </div>
                  <code className="block font-mono text-[12px] text-foreground/95 break-all">{freshKey}</code>
                  <p className="text-[10px] text-emerald-400/70 mt-2 italic">
                    Save it now — we don't store the plaintext.
                  </p>
                </div>
              )}
              {data.apiKeyPrefix && (
                <div className="flex items-center justify-between rounded-md bg-white/[0.03] border border-white/[0.06] px-3 py-2">
                  <code className="font-mono text-[12px] text-foreground/80">
                    {data.apiKeyPrefix}••••••••
                  </code>
                  <Button variant="ghost" size="sm" onClick={rotate} disabled={rotating}>
                    {rotating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    Rotate
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        <details className="text-[12px] text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground/90">Wire-format details</summary>
          <div className="mt-2 space-y-1 leading-relaxed">
            <p>• Auth: <code className="text-foreground/85">Authorization: Bearer &lt;key&gt;</code>, <code className="text-foreground/85">X-Api-Key: &lt;key&gt;</code>, or <code className="text-foreground/85">?key=&lt;key&gt;</code> on either endpoint</p>
            <p>• Raw PCM: send 16-bit linear PCM at 16 kHz mono, 60 ms per frame</p>
            <p>• Tata format: send <code className="text-foreground/85">connected</code> → <code className="text-foreground/85">start</code> → <code className="text-foreground/85">media</code> events with base64 μ-law payload (160-byte chunks); we reply with <code className="text-foreground/85">media</code> / <code className="text-foreground/85">mark</code> / <code className="text-foreground/85">clear</code></p>
          </div>
        </details>
      </div>
    </Card>
  );
}

// ----- PSTN editor -----
function PstnEditor({ data, reload }: { data: PstnCfg; reload: () => Promise<Integrations> }) {
  const [enabled, setEnabled] = useState(data.enabled);
  const [provider, setProvider] = useState(data.provider ?? 'tata');
  const [accountId, setAccountId] = useState(data.accountId ?? '');
  const [authToken, setAuthToken] = useState(''); // empty = keep existing
  const [phonesRaw, setPhonesRaw] = useState((data.phoneNumbers ?? []).join(', '));
  const [endpointUrl, setEndpointUrl] = useState(data.endpointUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [testTo, setTestTo] = useState('');
  const [testCallerId, setTestCallerId] = useState('');
  const [testAsync, setTestAsync] = useState(true);
  const [calling, setCalling] = useState(false);
  const [callResult, setCallResult] = useState<{ ok: boolean; status: number; response: unknown } | null>(null);
  const [callError, setCallError] = useState<string | null>(null);

  const providerDefaults: Record<string, { urlHint: string; accountLabel: string; tokenLabel: string }> = {
    tata: {
      urlHint: 'https://api.tatateleservices.com/v1/c2c (or whatever your account exposes)',
      accountLabel: 'Account ID (optional for Tata)',
      tokenLabel: 'API key (sent as api_key in the request body)',
    },
    twilio: {
      urlHint: 'https://api.twilio.com/2010-04-01/Accounts/.../Calls.json',
      accountLabel: 'Account SID (ACXXXX…)',
      tokenLabel: 'Auth Token',
    },
    plivo: { urlHint: 'https://api.plivo.com/v1/Account/.../Call/', accountLabel: 'Auth ID (MAxxx…)', tokenLabel: 'Auth Token' },
    vonage: { urlHint: 'https://api.nexmo.com/v1/calls', accountLabel: 'API key', tokenLabel: 'API secret' },
    telnyx: { urlHint: 'https://api.telnyx.com/v2/calls', accountLabel: 'Account ID (optional)', tokenLabel: 'API key' },
    acefone: { urlHint: 'https://api.acefone.in/v1/cc', accountLabel: 'Account ID', tokenLabel: 'API key' },
    other: { urlHint: 'https://your-carrier.example.com/click-to-call', accountLabel: 'Account ID', tokenLabel: 'API key / secret' },
  };
  const defaults = providerDefaults[provider] ?? providerDefaults.other!;

  async function save() {
    setSaving(true);
    try {
      const phoneNumbers = phonesRaw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => /^\+?\d{6,15}$/.test(s));
      await api('/api/voice-integrations/pstn', {
        method: 'PUT',
        body: JSON.stringify({ enabled, provider, accountId, authToken, phoneNumbers, endpointUrl }),
      });
      setAuthToken('');
      setSavedAt(Date.now());
      await reload();
    } finally {
      setSaving(false);
    }
  }

  async function placeTestCall() {
    if (!testTo.trim()) return;
    setCalling(true);
    setCallResult(null);
    setCallError(null);
    try {
      const r = await api<{ ok: boolean; status: number; response: unknown }>(
        '/api/voice-integrations/pstn/call',
        {
          method: 'POST',
          body: JSON.stringify({
            customerNumber: testTo.trim(),
            callerId: testCallerId.trim() || undefined,
            async: testAsync ? 1 : 0,
          }),
        },
      );
      setCallResult(r);
    } catch (e) {
      setCallError((e as Error).message);
    } finally {
      setCalling(false);
    }
  }

  return (
    <Card className="p-6 mt-2">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="font-display text-2xl tracking-tight">PSTN / VoIP</h3>
          <p className="text-[12px] text-muted-foreground mt-1 max-w-xl leading-relaxed">
            Connect a carrier. Credentials persist here per tenant. Carrier-webhook wiring is
            deployment-pending — your numbers won't actually ring through until we finish that.
          </p>
        </div>
        <Toggle on={enabled} disabled={saving} onChange={setEnabled} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-5">
        <div>
          <Label>Provider</Label>
          <Select value={provider} onChange={(e) => setProvider(e.target.value)} className="mt-1.5">
            {PSTN_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{defaults.accountLabel}</Label>
          <Input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder={
              provider === 'twilio' ? 'AC…' :
              provider === 'plivo' ? 'MAxxx…' :
              provider === 'vonage' ? 'api_key' : 'account id'
            }
            className="mt-1.5"
          />
        </div>
      </div>

      <div className="mb-5">
        <Label>Carrier endpoint URL</Label>
        <Input
          value={endpointUrl}
          onChange={(e) => setEndpointUrl(e.target.value)}
          placeholder={defaults.urlHint}
          className="mt-1.5 font-mono text-[12px]"
        />
        <p className="text-[10px] text-muted-foreground/60 italic mt-1">
          POST target for outbound click-to-call requests. Tata gives you this in your account portal.
        </p>
      </div>

      <div className="mb-5">
        <Label>{defaults.tokenLabel}</Label>
        <Input
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
          type="password"
          placeholder={data.authToken ? `(stored: ${data.authToken}, type new value to replace)` : 'paste secret'}
          className="mt-1.5 font-mono"
        />
        <p className="text-[10px] text-muted-foreground/60 italic mt-1">
          Leave empty to keep the stored token. We don't display secrets in plaintext.
        </p>
      </div>

      <div className="mb-5">
        <Label>Phone numbers / DIDs (E.164, comma-separated)</Label>
        <Input
          value={phonesRaw}
          onChange={(e) => setPhonesRaw(e.target.value)}
          placeholder="+14155551234, 911244637992"
          className="mt-1.5 font-mono text-[12px]"
        />
        <p className="text-[10px] text-muted-foreground/60 italic mt-1">
          DIDs assigned to your account. The first is used as default caller_id when none is specified.
        </p>
      </div>

      <div className="flex items-center justify-end gap-3 pt-2 mb-6 border-t border-white/[0.05]">
        {savedAt && (
          <span className="text-[10px] uppercase tracking-[0.18em] text-emerald-400/80 mr-auto">
            Saved
          </span>
        )}
        <Button onClick={save} disabled={saving}>
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save'}
        </Button>
      </div>

      {/* Click-to-call test */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
          Test click-to-call
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            placeholder="customer +14155551234"
            className="font-mono text-[12px]"
          />
          <Input
            value={testCallerId}
            onChange={(e) => setTestCallerId(e.target.value)}
            placeholder="caller_id (optional)"
            className="font-mono text-[12px]"
          />
          <Button onClick={placeTestCall} disabled={calling || !testTo || !data.enabled}>
            {calling ? <><Loader2 className="h-4 w-4 animate-spin" /> Calling…</> : 'Place call'}
          </Button>
        </div>
        <label className="flex items-center gap-2 mt-2.5 text-[11px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={testAsync}
            onChange={(e) => setTestAsync(e.target.checked)}
            className="accent-aurora-1"
          />
          <span>async: 1 (return immediately, don't wait for connect)</span>
        </label>
        {callError && (
          <p className="text-[11px] text-red-400 mt-2">{callError}</p>
        )}
        {callResult && (
          <div className={cn(
            'mt-3 rounded-md border p-3 text-[11px]',
            callResult.ok ? 'border-emerald-500/25 bg-emerald-500/8' : 'border-red-500/25 bg-red-500/8',
          )}>
            <div className="flex items-center justify-between mb-1.5">
              <span className={callResult.ok ? 'text-emerald-400' : 'text-red-400'}>
                HTTP {callResult.status}
              </span>
            </div>
            <pre className="overflow-x-auto text-foreground/80 font-mono text-[10px] leading-relaxed">
              {JSON.stringify(callResult.response, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </Card>
  );
}

function EndpointRow({ label, url, onCopy, note }: { label: string; url: string; onCopy: () => void; note: string }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/65 min-w-[160px]">
          {label}
        </div>
        <code className="flex-1 rounded-md bg-white/[0.04] border border-white/[0.07] px-3 py-1.5 text-[11px] text-foreground/90 font-mono truncate">
          {url}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="h-8 w-8 rounded-md border border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.08] flex items-center justify-center"
          aria-label="Copy endpoint"
        >
          <Copy className="h-3 w-3" />
        </button>
      </div>
      <p className="text-[10px] text-muted-foreground/55 italic mt-1 ml-[168px]">{note}</p>
    </div>
  );
}

// ----- SIP editor -----
function SipEditor({ data, reload }: { data: SipCfg; reload: () => Promise<Integrations> }) {
  const [enabled, setEnabled] = useState(data.enabled);
  const [uri, setUri] = useState(data.uri ?? '');
  const [authMethod, setAuthMethod] = useState<'ip_allowlist' | 'digest'>(data.authMethod ?? 'ip_allowlist');
  const [allowedIpsRaw, setAllowedIpsRaw] = useState((data.allowedIps ?? []).join(', '));
  const [digestUser, setDigestUser] = useState(data.digestUser ?? '');
  const [digestPass, setDigestPass] = useState(''); // empty = keep existing
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    setSaving(true);
    try {
      const allowedIps = allowedIpsRaw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      await api('/api/voice-integrations/sip', {
        method: 'PUT',
        body: JSON.stringify({ enabled, uri, authMethod, allowedIps, digestUser, digestPass }),
      });
      setDigestPass('');
      setSavedAt(Date.now());
      await reload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6 mt-2">
      <div className="flex items-start justify-between mb-5">
        <div>
          <h3 className="font-display text-2xl tracking-tight">SIP Trunking</h3>
          <p className="text-[12px] text-muted-foreground mt-1 max-w-xl leading-relaxed">
            Point your SBC at our SIP URI. The SIP gateway component is deployment-pending —
            config is captured per tenant and will go live with that rollout.
          </p>
        </div>
        <Toggle on={enabled} disabled={saving} onChange={setEnabled} />
      </div>

      <div className="mb-5">
        <Label>SIP URI</Label>
        <Input
          value={uri}
          onChange={(e) => setUri(e.target.value)}
          placeholder="sip:tenant-name@calling-ai.com"
          className="mt-1.5 font-mono text-[12px]"
        />
      </div>

      <div className="mb-5">
        <Label>Authentication method</Label>
        <div className="mt-1.5 flex gap-1.5">
          {(['ip_allowlist', 'digest'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setAuthMethod(m)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-[11px] uppercase tracking-[0.18em] transition-all',
                authMethod === m
                  ? 'bg-white/[0.07] border-white/[0.12] text-foreground/95'
                  : 'border-white/[0.06] bg-white/[0.02] text-muted-foreground hover:text-foreground/90',
              )}
            >
              {m === 'ip_allowlist' ? 'IP allow-list' : 'SIP digest'}
            </button>
          ))}
        </div>
      </div>

      {authMethod === 'ip_allowlist' ? (
        <div className="mb-5">
          <Label>Allowed IPs (comma-separated CIDR / addresses)</Label>
          <Input
            value={allowedIpsRaw}
            onChange={(e) => setAllowedIpsRaw(e.target.value)}
            placeholder="203.0.113.0/24, 198.51.100.10"
            className="mt-1.5 font-mono text-[12px]"
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-5">
          <div>
            <Label>Digest username</Label>
            <Input
              value={digestUser}
              onChange={(e) => setDigestUser(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label>Digest password</Label>
            <Input
              type="password"
              value={digestPass}
              onChange={(e) => setDigestPass(e.target.value)}
              placeholder={data.digestPass ? `(stored: ${data.digestPass}, type new to replace)` : 'paste secret'}
              className="mt-1.5 font-mono"
            />
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/[0.05]">
        {savedAt && (
          <span className="text-[10px] uppercase tracking-[0.18em] text-emerald-400/80 mr-auto">
            Saved
          </span>
        )}
        <Button onClick={save} disabled={saving}>
          {saving ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Save'}
        </Button>
      </div>
    </Card>
  );
}

// ----- Toggle -----
function Toggle({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      className={cn(
        'relative h-6 w-11 rounded-full border transition-colors',
        on ? 'bg-aurora-1/30 border-aurora-1/50' : 'bg-white/[0.04] border-white/[0.08]',
        disabled && 'opacity-50',
      )}
      aria-label={on ? 'Disable' : 'Enable'}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[18px] w-[18px] rounded-full bg-foreground/95 transition-all',
          on ? 'left-[22px]' : 'left-[2px]',
        )}
      />
    </button>
  );
}
