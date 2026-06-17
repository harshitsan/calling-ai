import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Network,
  PhoneIncoming,
  PhoneOutgoing,
  ShieldCheck,
  Webhook,
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

export function TwilioSetup() {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-domain';
  const voiceWebhook = `${origin}/twilio/voice`;
  const clickToCallUrl = `${origin}/api/voice-integrations/pstn/call`;

  const curlExample = `curl -X POST ${clickToCallUrl} \\
  -H "Authorization: Bearer YOUR_DASHBOARD_JWT" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customerNumber": "+14155551212",
    "callerId": "+14158675309",
    "async": 1
  }'

# Behind the scenes we POST to Twilio's REST Calls API:
#   POST https://api.twilio.com/2010-04-01/Accounts/<AccountSid>/Calls.json
#   Authorization: Basic base64(<AccountSid>:<AuthToken>)
#   To=<customer>&From=<your DID>&Twiml=<Connect><Stream .../></Connect>
#   &StatusCallback=${origin}/twilio/status
# On answer, Twilio connects the call's media to our bridge and the agent talks.`;

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
          Integration guide · Twilio
        </div>
        <h1 className="font-display text-5xl tracking-tight leading-[0.95]">
          Enable <span className="italic text-aurora">Twilio</span>.
        </h1>
        <p className="mt-4 text-[13px] text-muted-foreground max-w-xl leading-relaxed">
          Bring your own Twilio account. Inbound calls reach your agent through a TwiML Voice
          webhook; outbound calls go through Twilio's REST Calls API. The media itself already
          speaks Twilio Media Streams natively — there's nothing to tune on the audio side.
          Work top to bottom; carrier-side and dashboard-side steps are interleaved.
        </p>
      </header>

      {/* Prerequisites */}
      <Card className="p-5 mb-6 bg-aurora-1/[0.04] border-aurora-1/15">
        <div className="text-[10px] uppercase tracking-[0.22em] text-aurora-1 mb-3">Prerequisites</div>
        <ul className="text-[13px] text-foreground/85 space-y-1.5 leading-relaxed">
          <li>• A Twilio account with at least one voice-capable phone number (or a SIP Domain — see Step 5).</li>
          <li>• Your <strong>Account SID</strong> (<Code value="AC…" />) and <strong>Auth Token</strong> from the Twilio Console.</li>
          <li>• Access to the number's <em>Voice Configuration</em> in the Twilio Console.</li>
        </ul>
      </Card>

      <div className="space-y-5">
        <Step n={1} title="Store your Twilio credentials" icon={<KeyRound className="h-5 w-5" />}>
          <p>
            Open <Link to="/integrations" className="text-aurora-1 hover:underline">Voice integrations</Link>,
            expand the <strong>PSTN / VoIP</strong> card, and fill in:
          </p>
          <ul className="space-y-1.5 ml-2">
            <li>• <strong>Provider:</strong> Twilio</li>
            <li>• <strong>Account SID:</strong> your <Code value="AC…" /> identifier</li>
            <li>• <strong>Auth Token:</strong> the matching Auth Token (stored encrypted, redacted to last-4 on read)</li>
            <li>• <strong>Phone numbers / DIDs:</strong> every Twilio number you'll use, in E.164 (<Code value="+14155551212" />), comma-separated</li>
          </ul>
          <p>
            You can leave <strong>Carrier endpoint URL</strong> empty — for Twilio we derive it from your
            Account SID. Toggle <strong>Enabled</strong> and <strong>Save</strong>. Saving also registers
            your DIDs for inbound routing.
          </p>
        </Step>

        <Step n={2} title="Point your number's Voice webhook at calling-ai" icon={<Webhook className="h-5 w-5" />}>
          <p>
            In the Twilio Console: <strong>Phone Numbers → Manage → Active numbers → (your number) →
            Voice Configuration</strong>. Under <em>"A call comes in"</em>, choose <strong>Webhook</strong>,
            method <strong>HTTP POST</strong>, and set the URL to:
          </p>
          <Code value={voiceWebhook} multiline lang="Inbound Voice webhook (HTTP POST)" />
          <p>
            Save. When a call arrives, Twilio POSTs here; we look up the tenant + agent by the dialed
            number, verify Twilio's signature with your Auth Token, and return TwiML that streams the
            call into the live agent.
          </p>
          <p className="text-muted-foreground/85">
            <ShieldCheck className="h-3.5 w-3.5 inline align-text-bottom text-aurora-1 mr-1" />
            Every request is validated against <Code value="X-Twilio-Signature" /> using your stored
            Auth Token — forged webhooks are rejected with <Code value="403" />.
          </p>
        </Step>

        <Step n={3} title="Place a test inbound call" icon={<PhoneIncoming className="h-5 w-5" />}>
          <p>
            Call the number you just configured. On answer you'll hear your agent greet you, then have
            a full back-and-forth — STT transcribes in real time, the LLM replies in context, and the
            audio streams back. Talking over the agent flushes its playback immediately (barge-in).
          </p>
          <p>
            The call appears under <Link to="/calls" className="text-aurora-1 hover:underline">Call Logs</Link> with
            <Badge className="mx-1.5 align-middle">twilio:&lt;status&gt;</Badge> as the end-reason.
          </p>
          <p className="text-muted-foreground/85">
            <AlertTriangle className="h-3.5 w-3.5 inline align-text-bottom text-amber-400/85 mr-1" />
            The agent's voice + prompt come from the agent whose <strong>inbound DID</strong> matches the
            dialed number (set under <Link to="/agents" className="text-aurora-1 hover:underline">Agents → Integrations</Link>),
            else the most-recently-updated agent for your tenant.
          </p>
        </Step>

        <Step n={4} title="Place a test outbound call" icon={<PhoneOutgoing className="h-5 w-5" />}>
          <p>
            On the PSTN card, use the <strong>Test click-to-call</strong> panel: enter the customer
            number (E.164), pick a <Code value="callerId" /> that's one of your Twilio DIDs, and
            <strong> Place call</strong>. We call Twilio's REST API; on answer the callee is connected
            to your agent. Twilio's response (with the <Code value="CallSid" />) shows inline, and
            status callbacks close the call row when it completes.
          </p>
          <p>Or call it server-to-server with your dashboard JWT — no Twilio creds in your backend:</p>
          <Code value={curlExample} multiline lang="POST click-to-call (server-to-server)" />
        </Step>

        <Step n={5} title="(Optional) SIP via a Twilio SIP Domain" icon={<Network className="h-5 w-5" />}>
          <p>
            To bring SIP traffic from your own SBC/PBX, create a <strong>Programmable Voice SIP
            Domain</strong> in the Twilio Console (<Code value="yourco.sip.twilio.com" />) and set its
            Voice webhook to the <em>same</em> inbound URL:
          </p>
          <Code value={voiceWebhook} multiline lang="SIP Domain Voice webhook (HTTP POST)" />
          <p>
            Point your SBC at the SIP Domain. Twilio answers the SIP INVITE and invokes the webhook for
            TwiML exactly like a PSTN call — we extract the dialed number from the SIP URI
            (<Code value="sip:+14155551212@yourco.sip.twilio.com" />) and route it the same way. No
            separate SIP gateway for you to run.
          </p>
        </Step>
      </div>

      {/* Operator note */}
      <Card className="p-5 mt-6 bg-amber-400/[0.04] border-amber-400/15">
        <div className="text-[10px] uppercase tracking-[0.22em] text-amber-400/90 mb-2 flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3" /> Operator note
        </div>
        <p className="text-[13px] text-foreground/85 leading-relaxed">
          The deployment must have the <Code value="STREAM_TOKEN_SECRET" /> Worker secret set
          (<Code value="wrangler secret put STREAM_TOKEN_SECRET" />). It signs the short-lived per-call
          token embedded in the media-stream URL. Until it's set, <Code value="/twilio/voice" /> returns
          <Code value="503" /> by design (fail-closed).
        </p>
      </Card>

      {/* Troubleshooting */}
      <Card className="p-6 mt-6">
        <h2 className="font-display text-2xl tracking-tight mb-4">Troubleshooting</h2>
        <div className="space-y-4 text-[13px] text-muted-foreground leading-relaxed">
          <Trouble
            symptom="Calls fail and the webhook returns 503."
            cause="STREAM_TOKEN_SECRET isn't configured on the deployment."
            fix={<>Set it once with <Code value="wrangler secret put STREAM_TOKEN_SECRET" /> and redeploy.</>}
          />
          <Trouble
            symptom="The webhook returns 404 ('no tenant configured for this number')."
            cause="The dialed number isn't registered for inbound routing."
            fix={<>Add the number to your PSTN <strong>Phone numbers / DIDs</strong> (or an agent's inbound DIDs) and <strong>Save</strong> — saving rebuilds the routing index.</>}
          />
          <Trouble
            symptom="The webhook returns 403 ('invalid twilio signature')."
            cause="The Auth Token stored here doesn't match the Twilio account that owns the number, or a proxy rewrote the webhook URL."
            fix={<>Re-copy the Auth Token from the Console into the PSTN card. Ensure the webhook URL Twilio calls is exactly <Code value={voiceWebhook} /> (signatures are computed over the full URL).</>}
          />
          <Trouble
            symptom="Caller hears the greeting but talkback gets no response."
            cause="No agent is configured (built-in fallback prompt is used), or the LLM/TTS provider key is missing."
            fix={<>Create an agent under <Link to="/agents" className="text-aurora-1 hover:underline">Agents</Link>. For OpenAI-tier agents, ensure <Code value="OPENAI_API_KEY" /> is set as a Worker secret.</>}
          />
        </div>
      </Card>

      <div className="mt-8 text-center">
        <Button asChild>
          <Link to="/integrations"><ArrowLeft className="h-4 w-4" /> Back to Voice integrations</Link>
        </Button>
        <p className="mt-3 text-[10px] uppercase tracking-[0.22em] text-muted-foreground/55">
          Twilio · Programmable Voice + Media Streams
        </p>
        <a
          href="https://www.twilio.com/docs/voice"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/65 hover:text-foreground/90 mt-2 transition-colors"
        >
          twilio.com · Programmable Voice docs <ExternalLink className="h-3 w-3" />
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
