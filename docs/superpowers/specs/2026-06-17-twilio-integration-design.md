# Full Twilio integration — design

**Date:** 2026-06-17
**Scope:** PSTN inbound, PSTN outbound, SIP trunking, Voice Streaming hardening
**Model:** BYO Twilio per tenant · guided manual setup (no number-provisioning API)

## Context

`calling-ai` is a real-time voice agent on Cloudflare Workers. The live media
handler `src/worker/voice-stream-tata.ts` **already speaks the exact Twilio
Media Streams protocol** (μ-law 8 kHz base64; `connected`/`start`/`media`/`mark`/
`clear`/`stop`; barge-in via `clear`). The full STT→LLM→TTS pipeline downstream
is carrier-agnostic. So the media plane needs no format work — the gaps are all
in the **signaling/control plane**.

Per-tenant Twilio credentials already have a home: `voice_integrations.pstn_*`
(`provider='twilio'`, `pstn_account_id`=Account SID, `pstn_auth_token`=Auth
Token), and the dashboard already lists Twilio with the right fields.

### Gaps to close

1. **Inbound**: Twilio never opens a WebSocket itself. A call to a Twilio number
   POSTs to a **Voice webhook** expecting **TwiML** back; only then does Twilio
   open the Media Stream. That webhook, DID→tenant routing, and
   `X-Twilio-Signature` validation do not exist.
2. **Outbound**: the current generic proxy sends `{api_key, customer_number,…}`
   JSON — Twilio needs a **form-encoded POST to `/Calls.json`** with Basic auth
   (`AccountSid:AuthToken`) and `To`/`From`/`Twiml`/`StatusCallback`.
3. **SIP**: config-only. Via Twilio **Elastic SIP Trunking**, a customer
   SBC/PBX routes through Twilio into Programmable Voice, which hits the *same*
   inbound TwiML webhook — so SIP reuses the inbound path, no SIP gateway needed.
4. **Streaming auth**: `/voice/stream` authenticates with a long-lived streaming
   API key whose plaintext we don't store (only a hash). Twilio `<Stream>` can't
   set headers. Need a per-call mechanism.

## Architecture

### Core idea: per-call signed stream tokens

The TwiML webhook mints a **short-lived HMAC token** bound to the call and
embeds it in the `wss://…/voice/stream?token=…` URL it hands Twilio. The WS
handler validates the token instead of the streaming API key. This:
- avoids needing the plaintext streaming key (we only store its hash),
- is per-call and expiring (≈60 s to connect) → tighter than a static key,
- carries `{tenantId, agentId, callSid, direction, exp}` signed with a new
  worker secret `STREAM_TOKEN_SECRET`, so routing is tamper-proof.

The existing streaming API key path stays for raw-PCM / non-Twilio users.

### Inbound flow (PSTN and SIP both land here)

```
Call to +1415… (or SIP via Twilio trunk)
  → POST /twilio/voice  (form-encoded: CallSid, From, To, AccountSid, Direction)
     1. resolve tenant+agent by To via did_routes        → 404 if unknown
     2. validate X-Twilio-Signature with tenant AuthToken → 403 if bad
     3. mint stream token {tenant, agent, callSid, inbound, exp}
     4. return TwiML:
        <Response><Connect>
          <Stream url="wss://<host>/voice/stream?token=…">
            <Parameter name="from" value="…"/>
            <Parameter name="to" value="…"/>
            <Parameter name="callSid" value="…"/>
          </Stream>
        </Connect></Response>
  → Twilio opens wss /voice/stream?token=…
     WS handler validates token → tenant/agent → existing pipeline (unchanged)
```

### Outbound flow

```
POST /api/voice-integrations/pstn/call {agentId, customerNumber, callerId}
  provider=twilio →
    1. mint stream token {tenant, agent, outbound, exp}
    2. POST https://api.twilio.com/2010-04-01/Accounts/{Sid}/Calls.json
       Authorization: Basic base64(Sid:AuthToken)   (form-encoded)
       To=customerNumber, From=callerId,
       Twiml=<Connect><Stream url="wss://…/voice/stream?token=…">…</Stream></Connect>,
       StatusCallback=https://<host>/twilio/status, StatusCallbackEvent=…
    3. return Twilio JSON (CallSid, status)
  → on answer, Twilio connects media to our WS via the inline TwiML
  → POST /twilio/status updates the calls row (queued→ringing→in-progress→completed)
```

### SIP Trunking via Twilio

No new media path. Tenant creates a Twilio **Elastic SIP Trunk**, points its
Origination/Voice webhook at our `/twilio/voice`, and their SBC/PBX sends calls
into Twilio. Twilio normalizes SIP → Programmable Voice → our inbound webhook.
Backend work is minimal: store the trunk SID / SIP domain for display in
`sip_*`, add a guided setup page, and flip the card from PREVIEW to configurable.

## Components

### New routes (`src/worker/twilio.ts`, wired in `index.ts`)
- `POST /twilio/voice` — inbound TwiML webhook (PSTN + SIP).
- `POST /twilio/status` — outbound call status callbacks → `calls` table.
- Both validate `X-Twilio-Signature`.

### Stream tokens (`src/worker/stream-token.ts`)
- `mintStreamToken(payload)` / `verifyStreamToken(token)` — HMAC-SHA256 over
  `base64url(json).exp`, secret `STREAM_TOKEN_SECRET`. Pure, unit-tested.

### Twilio helpers (`src/worker/twilio.ts`)
- `validateTwilioSignature(url, params, authToken, sig)` — HMAC-SHA1 per Twilio
  spec (sorted params concatenated onto the URL), Web Crypto. Unit-tested with
  Twilio's documented vectors.
- `buildConnectStreamTwiml({wssUrl, params})` — TwiML string builder.
- `placeTwilioCall({sid, token, to, from, twiml, statusCallback})` — outbound
  REST adapter (Basic auth, form-encoded).

### WS handler change (`voice-stream-tata.ts`)
- Accept `?token=` (and `start.customParameters.token`): if present, verify via
  `verifyStreamToken` and use its `tenantId`/`agentId` for routing, bypassing the
  streaming-API-key check. Falls back to the existing key path otherwise.

### Outbound adapter change (`voice-integrations.ts`)
- In the click-to-call handler, branch `provider==='twilio'` to `placeTwilioCall`
  instead of the generic JSON proxy.

### Data model
- **New `did_routes` table**: `did TEXT PRIMARY KEY, tenant_id, agent_id, updated_at`.
  Maintained whenever `pstn_phone_numbers` or `agents.inbound_dids` change.
  O(1) inbound tenant+agent resolution for *all* carriers (general improvement).
  Migration `0017_did_routes.sql` + backfill from existing JSON arrays.
- `calls`: add `carrier_call_id TEXT` to correlate Twilio CallSid (migration 0017).
- New worker secret `STREAM_TOKEN_SECRET` (wrangler).
- SIP: store trunk SID in `sip_extra` (no schema change; JSON blob exists).

### UI (`web/src/pages/`)
- `TwilioSetup.tsx` (modeled on `TataSetup.tsx`): shows the tenant's inbound
  webhook URL to paste into the Twilio Console, the signature note, and a test
  call button.
- SIP card: guided Elastic SIP Trunk setup; flip PREVIEW → configurable.
- Surface the per-tenant inbound webhook URL in the PSTN editor.

## Security
- `X-Twilio-Signature` validated on `/twilio/voice` and `/twilio/status` using
  the resolved tenant's Auth Token. Tenant is resolved from `To` (inbound) before
  validation; unknown DID → 404, bad signature → 403.
- Media WS authed by per-call expiring signed token; routing claims are signed.
- Secrets stay server-side, redacted in UI (already implemented).

## Testing
- Unit: `validateTwilioSignature` (Twilio's published test vectors),
  `mintStreamToken`/`verifyStreamToken` (round-trip, expiry, tamper),
  `buildConnectStreamTwiml` (snapshot), `placeTwilioCall` (form body + Basic auth
  header shape, mocked fetch), DID resolution from `did_routes`.
- Integration: `/twilio/voice` → asserts 404/403/TwiML; WS handshake accepts a
  valid token and rejects an expired/forged one.

## Phasing
1. **Inbound** — `did_routes` + migration, stream tokens, `/twilio/voice`,
   signature validation, WS token auth. (Receiving calls works end-to-end.)
2. **Outbound** — `placeTwilioCall`, `/twilio/status`, `calls.carrier_call_id`.
3. **SIP** — guided Elastic SIP Trunk setup; reuse inbound path; flip the card.
4. **UI + hardening** — `TwilioSetup.tsx`, webhook-URL surfacing, streaming docs.

## Out of scope
- Platform-managed Twilio subaccounts / automated number purchase (BYO + manual).
- Running our own SIP gateway (Twilio Elastic SIP Trunk handles SIP).
- Call recording routing changes (existing recorder path unaffected).
```