# Voice-Calling Options

Reference for how customers and agents will actually talk to each other once
`calling-ai` is wired into the phone network. Today the system runs on
WebSocket-only — browser to Worker, no PSTN. This doc covers the three
mainstream integration modalities a B2B telephony platform exposes
(PSTN/VoIP, Voice Streaming, SIP Trunking), the trade-offs between them, and
how each would land in our existing Durable Object architecture.

---

## At a glance

| Option | Latency floor | Carrier billing | Standards | Customer fit | calling-ai status |
|---|---|---|---|---|---|
| **PSTN / VoIP** | ~250–400 ms one-way | Per-minute, you pay carrier | Vendor-specific REST + media WS | Outbound dialer, inbound numbers, SMB | **Not yet** — phase-2 in `plan.md` |
| **Voice Streaming** | Network-bound (≤100 ms) | None (you bring own media) | Vendor's media-stream protocol (Twilio MS, Vonage MediaSocket, Acefone Stream) | "BYOC" — customer keeps their telephony, we plug in AI | **Already supported in spirit** — current `/call` WebSocket is this shape |
| **SIP Trunking** | ~100–250 ms one-way | Customer's carrier bills | RFC 3261 (SIP) + RFC 3550 (RTP) | Enterprise, custom PBX, regulated industries | **Not yet** — needs SIP gateway in front |

---

## 1. PSTN / VoIP

### What it is

A turnkey path to dialed/answered phone calls. The platform owns:

- The DID (phone number) the user dials in to.
- Outbound dialing — initiate a call from the AI side to a user's phone.
- The carrier relationship (Twilio, Vonage, Plivo, Telnyx, Acefone, etc.).
- Media bridging — converting the carrier's audio frames (mulaw / G.711) to
  something the agent loop can chew on.

### When to choose it

- You want to *be* a number. Customers dial `+1 415 …`, hear an AI agent.
- You're building an outbound dialer — campaigns, reminders, surveys.
- Customer doesn't have their own SIP infrastructure and never will.

### Integration shape for calling-ai

- Carrier sends a webhook (e.g. Twilio `<Stream>` or Acefone webhook) when a
  call arrives, including a media WebSocket URL.
- Worker accepts the carrier's media WebSocket and bridges into the existing
  `CallSession` Durable Object.
- Audio is mu-law 8 kHz from the carrier — needs resample to 16 kHz linear16
  for Flux STT, and resample/encode back to mu-law for the carrier on the
  reply path.
- Outbound: REST call to carrier to initiate, then carrier opens the same
  media WebSocket to us.

### Trade-offs

- Highest CO operational burden — toll-fraud, A2P registration, STIR/SHAKEN,
  carrier outages.
- Pricing margin is thin (carrier per-minute + platform fee).
- Adds 150–250 ms of carrier-side latency that we can't shave.

### Provider notes

| Vendor | Strengths | Watch-outs |
|---|---|---|
| Twilio | Best docs, global coverage, `<Stream>` is industry default | Most expensive |
| Vonage | Solid EU presence | Less ergonomic API |
| Plivo / Telnyx | 30–50% cheaper than Twilio | Smaller ecosystem |
| Acefone | Strong APAC/India coverage | Smaller third-party tooling |

---

## 2. Voice Streaming

### What it is

The customer keeps their telephony. We provide a streaming-audio endpoint
(WebSocket). The customer's existing PBX or contact-center connects to us,
streams the caller's audio in, and plays our agent's audio out.

This is what `calling-ai`'s `/call` endpoint already does for the browser
demo — same shape, different transport on the customer side.

### When to choose it

- Customer already has a contact center (Genesys, Five9, NICE, Talkdesk,
  Acefone) and just wants AI in front of certain queues.
- "BYOC" (Bring Your Own Carrier) — they keep carrier relationships, billing,
  numbers, compliance.
- They need ultra-low latency and tight control over the media path.

### Integration shape for calling-ai

Already 95% there. The work:

- Document the wire protocol (frame size, codec, sample rate, JSON event
  envelope) under `docs/protocols/voice-stream-v1.md`.
- Add per-tenant API key auth on the WebSocket upgrade (currently JWT-only).
- Resampler at the WebSocket boundary so customers can ship 8 kHz mulaw or
  16 kHz linear16 transparently.

### Trade-offs

- We don't own the number → no inbound monetization, no STIR/SHAKEN
  responsibility, no outbound dialing without customer cooperation.
- Latency floor is whatever the customer's network + carrier give us — often
  better than our PSTN option because no extra hop.
- Hardest to demo on day one — needs the customer to wire up their PBX.

### Provider notes

These platforms expose a media-stream interface we can plug into without
becoming a carrier ourselves:

| Vendor | Stream protocol | Codec |
|---|---|---|
| Twilio Media Streams | WebSocket + JSON envelope | mulaw 8 kHz |
| Vonage MediaSocket | WebSocket + JSON | mulaw/PCM 8/16 kHz |
| Genesys AudioHook | WebSocket + binary frames | mulaw/PCM 8 kHz |
| Acefone Stream | WebSocket + JSON | mulaw 8 kHz |

---

## 3. SIP Trunking

### What it is

We expose a SIP URI (e.g. `sip:agent@calling-ai.com`). Customer's SBC or PBX
points a trunk at it. SIP handles call setup; RTP carries the media.

### When to choose it

- Enterprise with a real SBC (Session Border Controller) — Cisco, Oracle,
  AudioCodes — and an ops team that thinks in trunks.
- Regulated environments where the customer wants the media path to traverse
  their own carrier and their own network policies.
- Multi-tenant resellers who already speak SIP fluently.

### Integration shape for calling-ai

- Workers don't speak SIP. Needs a SIP-to-WebSocket gateway in front:
  - Self-hosted: Asterisk/FreeSWITCH on a VM, converts SIP+RTP → WebSocket
    media that talks to our existing `/call` endpoint.
  - Managed: Twilio SIP Interface, JamBonz, Telnyx Voice API SIP — they hand
    us a media WebSocket on the other side.
- Auth on the SIP side via IP allow-list or SIP digest (per-trunk shared
  secret).
- RTP is UDP, jitter buffers matter — different operational shape from
  WebSocket.

### Trade-offs

- Biggest deployment lift — needs the gateway component, real-time RTP
  expertise, network rules for the gateway's public IP.
- Best fit for the largest customers who pay for it.
- Once it works, near-zero per-call platform cost (carrier billing is
  customer's problem).

---

## Recommendation for calling-ai

A defensible rollout order:

1. **Voice Streaming first (this quarter).** It's mostly already built —
   formalize the protocol, harden auth, ship as the BYOC offering. Captures
   contact-center integrators without becoming a carrier.

2. **PSTN/VoIP via Twilio Media Streams (next quarter).** Add a thin Worker
   route that accepts a Twilio `<Stream>` connection and forwards into the
   existing `CallSession`. Lets us own inbound numbers and outbound dialing
   without writing a SIP stack.

3. **SIP Trunking (when one enterprise asks for it).** Stand up a JamBonz or
   FreeSWITCH gateway. Don't build this speculatively — it only pays off when
   a paying customer requires it.

Every option terminates in the same `CallSession` Durable Object — the
WebSocket boundary is the abstraction. Only the audio-codec resampler and
the auth handshake change per transport.

---

## Related

- `plan.md` §1, "Non-goals (phase 1)" — PSTN is explicitly deferred.
- `plan.md` §4, latency budget — every option above must fit inside the
  700 ms p50 voice-to-voice target.
- `src/worker/call-session.ts` — the Durable Object every transport
  bridges into.
