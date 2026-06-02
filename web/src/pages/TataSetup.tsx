import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Network,
  PhoneOutgoing,
  Radio,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

function useCopyable() {
  const [copied, setCopied] = useState<string | null>(null);
  return {
    copied,
    copy(text: string) {
      navigator.clipboard?.writeText(text).catch(() => {});
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    },
  };
}

interface CodeProps { value: string; lang?: string; multiline?: boolean }
function Code({ value, lang, multiline }: CodeProps) {
  const { copied, copy } = useCopyable();
  const isThisCopied = copied === value;
  if (multiline) {
    return (
      <div className="relative rounded-lg bg-white/[0.03] border border-white/[0.07] overflow-hidden">
        {lang && (
          <div className="px-3 py-1.5 border-b border-white/[0.05] text-[10px] uppercase tracking-[0.18em] text-muted-foreground/65 flex items-center justify-between">
            <span>{lang}</span>
            <button
              onClick={() => copy(value)}
              className="text-[10px] flex items-center gap-1 text-muted-foreground hover:text-foreground/95 transition-colors"
            >
              {isThisCopied ? <><Check className="h-3 w-3" /> Copied</> : <><Copy className="h-3 w-3" /> Copy</>}
            </button>
          </div>
        )}
        <pre className="px-4 py-3 text-[12px] text-foreground/90 font-mono leading-relaxed overflow-x-auto">
          {value}
        </pre>
      </div>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.04] border border-white/[0.07] px-2 py-0.5 text-[12px] font-mono text-foreground/90">
      <code>{value}</code>
      <button
        onClick={() => copy(value)}
        className="text-muted-foreground/60 hover:text-foreground/95 transition-colors"
        aria-label="Copy"
      >
        {isThisCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}

interface StepProps {
  n: number;
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}
function Step({ n, title, icon, children }: StepProps) {
  return (
    <Card className="p-6">
      <div className="flex items-start gap-4 mb-4">
        <div className="shrink-0 h-12 w-12 rounded-xl bg-aurora-1/15 border border-aurora-1/20 flex items-center justify-center text-aurora-1">
          {icon}
        </div>
        <div className="flex-1">
          <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70 mb-0.5">
            Step {n}
          </div>
          <h3 className="font-display text-2xl tracking-tight text-foreground/95">{title}</h3>
        </div>
      </div>
      <div className="text-[13px] text-muted-foreground leading-relaxed space-y-3">
        {children}
      </div>
    </Card>
  );
}

export function TataSetup() {
  const wsHost = typeof window !== 'undefined' ? window.location.host : 'YOUR-DOMAIN';
  const wsProto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsCarrier = `${wsProto}://${wsHost}/voice/stream`;
  const clickToCallUrl = `${typeof window !== 'undefined' ? window.location.origin : 'https://your-domain'}/api/voice-integrations/pstn/call`;

  const curlExample = `curl -X POST ${clickToCallUrl} \\
  -H "Authorization: Bearer YOUR_DASHBOARD_JWT" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customerNumber": "919800000000",
    "callerId": "911244637992",
    "async": 1
  }'`;

  const wsClientExample = `// Tata-side configuration in the carrier portal — typically a URL field
// plus a custom Authorization header.

URL:    ${wsCarrier}
Header: Authorization: Bearer cai_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx

// Wire envelope (Tata sends to us):
//   { "event": "connected" }
//   { "event": "start",   "streamSid": "MZ…", "start": { … }, "sequenceNumber": "1" }
//   { "event": "media",   "streamSid": "MZ…", "media": { "payload": "<base64 μ-law>", "chunk": "1", "timestamp": "20" } }
//   { "event": "stop",    "streamSid": "MZ…", "stop":  { "reason": "…" } }
//
// We reply with:
//   { "event": "media",   "streamSid": "MZ…", "media": { "payload": "<base64 μ-law>", "chunk": N } }
//   { "event": "mark",    "streamSid": "MZ…", "mark":  { "name": "hello-played" } }
//   { "event": "clear",   "streamSid": "MZ…" }   ← used to interrupt playback`;

  return (
    <div className="fade-up max-w-[920px]">
      <Link
        to="/integrations"
        className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground/90 transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Voice integrations
      </Link>

      <header className="mb-10">
        <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/80 mb-3">
          Integration guide · Tata Teleservices
        </div>
        <h1 className="font-display text-5xl tracking-tight leading-[0.95]">
          Enable <span className="italic text-aurora">Tata</span>.
        </h1>
        <p className="mt-4 text-[13px] text-muted-foreground max-w-xl leading-relaxed">
          15-minute setup. You'll configure Tata's bidirectional WebSocket streaming to point at
          our endpoint, and the click-to-call REST API to use stored credentials from this dashboard.
          Carrier-side and dashboard-side steps are interleaved — work top to bottom.
        </p>
      </header>

      {/* What you need */}
      <Card className="p-5 mb-6 bg-aurora-1/[0.04] border-aurora-1/15">
        <div className="text-[10px] uppercase tracking-[0.22em] text-aurora-1 mb-3">Prerequisites</div>
        <ul className="text-[13px] text-foreground/85 space-y-1.5 leading-relaxed">
          <li>• A live Tata Teleservices account with at least one DID (Direct Inward Dialing number).</li>
          <li>• Bidirectional Audio Streaming enabled for your account (raise a ticket with Tata if it's not).</li>
          <li>• Your Tata <em>Click-to-Call Support API</em> key (the one you'd pass as <code className="text-foreground/95">api_key</code> in their request body).</li>
          <li>• Your Tata Click-to-Call REST endpoint URL (visible in Tata's developer portal).</li>
        </ul>
      </Card>

      <div className="space-y-5">
        <Step n={1} title="Generate a calling-ai streaming API key" icon={<KeyRound className="h-5 w-5" />}>
          <p>
            Open the <Link to="/integrations" className="text-aurora-1 hover:underline">Voice integrations</Link> page,
            expand the <strong>Voice Streaming</strong> card, and click <strong>Generate API key</strong>.
            You'll get a one-time-displayed key in the form <Code value="cai_live_…" />.
          </p>
          <p className="text-muted-foreground/85">
            <AlertTriangle className="h-3.5 w-3.5 inline align-text-bottom text-amber-400/85 mr-1" />
            Copy it immediately. We store only the hash — if you lose it, rotate to get a new one.
          </p>
        </Step>

        <Step n={2} title="Send Tata the streaming endpoint" icon={<Radio className="h-5 w-5" />}>
          <p>
            In Tata's portal, configure your DID's bidirectional streaming URL to point at:
          </p>
          <Code value={wsCarrier} multiline lang="WebSocket URL" />
          <p>
            Auth goes in <strong>any</strong> of these headers (use whichever Tata's portal lets you set):
          </p>
          <ul className="space-y-1 text-[12px] font-mono ml-2">
            <li>• <code className="text-foreground/95">Authorization: Bearer cai_live_…</code></li>
            <li>• <code className="text-foreground/95">X-Api-Key: cai_live_…</code></li>
            <li>• <code className="text-foreground/95">?key=cai_live_…</code> as a URL query parameter</li>
          </ul>
          <p className="text-muted-foreground/85">
            Tata expects μ-law/8000 audio with the standard <Code value="connected" /> → <Code value="start" /> → <Code value="media" /> → <Code value="stop" /> envelope.
            We already speak it — no settings to tune on their side.
          </p>
        </Step>

        <Step n={3} title="Verify the live agent loop" icon={<Check className="h-5 w-5" />}>
          <p>
            Trigger a test call to the DID you just configured. On answer, the caller hears your agent
            greet them, then can have a full back-and-forth — Flux STT transcribes their voice in real
            time, the LLM responds in conversation context, and the reply is streamed back as μ-law/8000
            audio. Speaking over the agent triggers a <Code value="clear" /> event so playback flushes
            immediately.
          </p>
          <p>
            Check your call shows up under <Link to="/calls" className="text-aurora-1 hover:underline">Call Logs</Link> with
            <Badge className="mx-1.5 align-middle">tata:&lt;reason&gt;</Badge>
            as the end-reason. The full transcript is attached to the call detail page.
          </p>
          <p className="text-muted-foreground/85">
            <AlertTriangle className="h-3.5 w-3.5 inline align-text-bottom text-amber-400/85 mr-1" />
            The agent's voice + system prompt come from the most-recently-updated agent for your tenant
            under <Link to="/agents" className="text-aurora-1 hover:underline">Agents</Link>. If you
            have no agents, a friendly fallback is used.
          </p>
        </Step>

        <Step n={4} title="Store Tata credentials for outbound calling" icon={<PhoneOutgoing className="h-5 w-5" />}>
          <p>
            Back in <Link to="/integrations" className="text-aurora-1 hover:underline">Voice integrations</Link>,
            expand the <strong>PSTN / VoIP</strong> card and fill in:
          </p>
          <ul className="space-y-1.5 ml-2">
            <li>• <strong>Provider:</strong> Tata</li>
            <li>• <strong>Carrier endpoint URL:</strong> the Tata Click-to-Call URL from their portal</li>
            <li>• <strong>API key:</strong> the value Tata wants as <Code value="api_key" /> in the request body</li>
            <li>• <strong>Phone numbers / DIDs:</strong> all DIDs assigned to your Tata account, comma-separated</li>
          </ul>
          <p>
            Toggle <strong>Enabled</strong> on and hit <strong>Save</strong>. Secrets are redacted to last-4 on read;
            leaving the API key field empty on a future save preserves the stored value.
          </p>
        </Step>

        <Step n={5} title="Place a test outbound call" icon={<PhoneOutgoing className="h-5 w-5" />}>
          <p>
            On the PSTN card, scroll to the <strong>Test click-to-call</strong> panel:
          </p>
          <ul className="space-y-1.5 ml-2">
            <li>• Enter the customer number you want to dial (E.164: <Code value="+919800000000" /> or local: <Code value="9800000000" />)</li>
            <li>• Optionally pick a <Code value="caller_id" /> — must be one of your saved DIDs, otherwise Tata rejects it</li>
            <li>• Leave <Code value="async: 1" /> checked unless you specifically need to wait for the connect</li>
            <li>• Click <strong>Place call</strong></li>
          </ul>
          <p>
            The carrier's raw JSON response shows up inline. <Code value="HTTP 200" /> means Tata accepted the request and is dialing.
            If you see <Code value="Please provide a valid caller_id" />, the DID you passed isn't assigned to your account.
          </p>
        </Step>

        <Step n={6} title="(Optional) Call from your own backend" icon={<Network className="h-5 w-5" />}>
          <p>
            Once Tata is configured here, your backend can place calls via our proxy without ever touching Tata's
            URL or your <Code value="api_key" /> directly. The proxy auths with your calling-ai JWT and uses the
            stored Tata credentials:
          </p>
          <Code value={curlExample} multiline lang="POST click-to-call (server-to-server)" />
        </Step>

        <Step n={7} title="Wire-protocol cheat sheet (for debugging)" icon={<Radio className="h-5 w-5" />}>
          <p>
            If you're chasing a handshake issue with Tata's NOC, here's exactly what each side sends:
          </p>
          <Code value={wsClientExample} multiline lang="Tata bidirectional streaming protocol" />
        </Step>
      </div>

      {/* Troubleshooting */}
      <Card className="p-6 mt-6">
        <h2 className="font-display text-2xl tracking-tight mb-4">Troubleshooting</h2>
        <div className="space-y-4 text-[13px] text-muted-foreground leading-relaxed">
          <Trouble
            symptom="Tata gets HTTP 401 on the WebSocket upgrade."
            cause="The API key in the carrier-side config doesn't match what's stored in our voice_integrations table."
            fix={<>Regenerate the key here (Voice Streaming → Rotate) and update Tata's portal. Plaintext is shown <strong>once</strong> at rotation; we only store the hash.</>}
          />
          <Trouble
            symptom="Tata gets HTTP 403 on the WebSocket upgrade."
            cause="Streaming is disabled for the tenant."
            fix={<>Flip the toggle on the Voice Streaming card to enabled.</>}
          />
          <Trouble
            symptom="Click-to-call returns 409 with 'carrier endpoint URL is not configured'."
            cause="The Carrier endpoint URL field is empty in PSTN config."
            fix={<>Paste your Tata Click-to-Call URL into the PSTN editor and save.</>}
          />
          <Trouble
            symptom="Click-to-call returns 502 with Tata's response embedded."
            cause="Tata rejected the request — usually a bad caller_id or wrong api_key."
            fix={<>Read the response body shown inline. <Code value="Please provide a valid caller_id" /> means the DID isn't on your account; re-check the value or pick a stored DID from the list.</>}
          />
          <Trouble
            symptom="Caller hears the greeting but talkback gets no response."
            cause="The tenant has no agent configured, so the LLM is using the built-in fallback prompt; OR the LLM/TTS provider key is missing."
            fix={<>Create at least one agent under <Link to="/agents" className="text-aurora-1 hover:underline">Agents</Link> — its system prompt + voice become the live phone agent. For OpenAI-tier agents, ensure <Code value="OPENAI_API_KEY" /> is set as a Worker secret.</>}
          />
        </div>
      </Card>

      <div className="mt-8 text-center">
        <Button asChild>
          <Link to="/integrations"><ArrowLeft className="h-4 w-4" /> Back to Voice integrations</Link>
        </Button>
        <p className="mt-3 text-[10px] uppercase tracking-[0.22em] text-muted-foreground/55">
          Tata Teleservices · bidirectional audio streaming + click-to-call
        </p>
        <a
          href="https://www.tatatelebusiness.com/products/contact-center-solutions"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/65 hover:text-foreground/90 mt-2 transition-colors"
        >
          tatatelebusiness.com · contact-center docs <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}

function Trouble({ symptom, cause, fix }: { symptom: string; cause: string; fix: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg bg-white/[0.02] border border-white/[0.06] p-4')}>
      <div className="text-[10px] uppercase tracking-[0.22em] text-amber-400/85 mb-1.5 flex items-center gap-1.5">
        <AlertTriangle className="h-3 w-3" /> Symptom
      </div>
      <p className="text-foreground/90 mb-2">{symptom}</p>
      <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/65 mb-1">Cause</div>
      <p className="mb-2">{cause}</p>
      <div className="text-[10px] uppercase tracking-[0.22em] text-aurora-1 mb-1">Fix</div>
      <p className="text-foreground/85">{fix}</p>
    </div>
  );
}
