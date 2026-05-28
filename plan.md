# Cloudflare-Native Serverless AI Calling Product — System Design

**Date:** 2026-05-29
**Status:** Approved design (pre-implementation)

> **Primary constraint: latency.** For a calling agent, conversational
> voice-to-voice latency is the single most important quality metric. Every
> decision in this document is subordinate to it — **where latency and cost
> conflict, latency wins.** See §4.

## 1. Overview

A multi-tenant, serverless conversational voice-AI platform running entirely on
Cloudflare. Clients sign up, build voice agents in a dashboard (identity, voice,
role, system prompt with dynamic variables, tools), and those agents hold
real-time, full-duplex voice conversations with end users. Conversations are
never forgotten: a per-tenant knowledge graph gives agents long-term memory via
vectorless retrieval. All inference uses open models hosted on Cloudflare
Workers AI, with optional escalation to external frontier models through AI
Gateway. The system is optimized first for **low conversational latency**, then
for cost, at 10k+ concurrent calls.

### Goals
- 100% Cloudflare serverless (Workers, Durable Objects, Workers AI, AI Gateway,
  D1, KV, R2, Queues, Analytics Engine, Pages).
- **Lowest achievable voice-to-voice latency** (primary; target p50 ≤ 700ms).
- Real-time voice agent: STT → LLM → TTS duplex loop with natural turn-taking
  and barge-in.
- Multi-tenant with strict data isolation and per-tenant usage/cost attribution.
- In-app agent builder: identity, voice, role, templated system prompt with
  dynamic variables, tool calling.
- Persistent memory ("never forget") via a vectorless knowledge graph.
- Built-in `end_call` tool plus tenant-defined webhook tools.
- Observability: dashboard with all call logs, transcripts, summaries, cost,
  and per-stage latency.
- Lowest cost (secondary to latency), best quality, 10k+ concurrent.

### Non-goals (phase 1)
- PSTN / phone numbers (no native Cloudflare PSTN). Designed as a drop-in later
  via a Twilio Media Streams → Worker adapter; the AI core is transport-agnostic.
- Multi-party calls (1:1 human↔AI only; no SFU needed in phase 1).
- WebRTC transport (phase 2 upgrade for tail-latency on lossy networks — see §5).

## 2. Cloudflare building blocks

| Capability | Primitive | Model / detail |
|---|---|---|
| Speech-to-text | Workers AI | `@cf/deepgram/flux` (WS-only, **semantic end-of-turn detection**, built for voice agents); `@cf/deepgram/nova-3` for general/multilingual transcription |
| Text-to-speech | Workers AI | `@cf/deepgram/aura-1` (WS streaming, 13 voices, Opus output, $0.015/1k chars) |
| LLM (fast default) | Workers AI | small/fast open model for low TTFT (e.g. Llama 3.1 8B); larger model only when needed |
| LLM (escalation) | AI Gateway | route to OpenAI / Gemini for hard turns; caching, fallback, BYOK, cost logs |
| Call orchestration | Durable Objects | one DO per call (state machine, WS fan-in/out), kept warm during active calls |
| Memory graph | Durable Objects (SQLite) / D1 | per-tenant knowledge graph, vectorless traversal |
| Edge/signaling | Workers | stateless WS termination, auth, routing |
| Structured data | D1 (SQLite) | tenants, users, agents, call records, transcripts |
| Hot config | KV | agent configs, prompts, cached static replies/openers |
| Recordings / blobs | R2 | call audio, large transcript JSON |
| Async work | Queues | post-call summary, memory extraction, webhooks |
| Metrics | Workers Analytics Engine | volume, **per-stage latency**, cost-trend dashboards |
| Dashboard UI | Pages | agent builder + logs/transcripts/summaries/latency |

## 3. High-level architecture

```
                       Browser / App Client SDK
        mic → client-side VAD → Opus encode → WSS    audio frames → jitter buffer → playback
                                   │  ▲
                                   ▼  │
                    ┌───────────────────────────────┐
                    │   Signaling Worker (stateless) │  JWT auth · tenant routing · concurrency caps
                    └───────────────┬───────────────┘
                                    │ routes to (tenant-namespaced)
                                    ▼
        ┌─────────────────────────────────────────────────────────────┐
        │   Call Session Durable Object   (1 per call, warm during call)│
        │                                                               │
        │   Flux STT (WS) ──► turn loop ──► LLM router ──► Aura TTS (WS) │
        │      ▲  partials/end-of-turn        │  default: fast Workers AI│
        │      │                              │  escalate: AI Gateway →  │
        │   linear16/16kHz                    │           OpenAI/Gemini  │
        │                                     ▼                          │
        │                            Tool executor                       │
        │                  built-ins (end_call, recall_memory, …)        │
        │                  + tenant webhook tools (via Worker)           │
        │                                     │                          │
        │   Memory client ◄───────────────────┘                         │
        └───────────────┬───────────────────────────────┬───────────────┘
                        │ live recall / fact writes      │ on call end
                        ▼                                 ▼
              Memory DO (per-tenant KG, SQLite)      Queue → Post-call Worker
              entities + relations (vectorless)      summary · KG extraction · webhook
                                                         │            │
                                                         ▼            ▼
                                                   D1 (calls,    R2 (recording)
                                                   transcripts)  Analytics Engine

        Dashboard (Pages): agent builder · call list · transcript · summary · cost · latency
```

**Core principle:** the **Call Session Durable Object** is the per-call
orchestrator and the only stateful component on the hot path. Everything else is
stateless (Workers) or managed (Workers AI, AI Gateway, storage). 10k concurrent
calls = 10k DOs — sharding is automatic, no central bottleneck. The DO, the Flux
WS, the Aura WS, and LLM inference are **colocated in one region** to keep the
turn loop tight (§4).

## 4. Latency — the primary design constraint

Voice-to-voice latency — the moment the user stops speaking to the moment they
hear the agent — is the single most important metric for a calling product.
Humans notice gaps above ~300–500ms; beyond ~1s the conversation feels broken.
A slightly-less-accurate agent that responds instantly beats a smarter one that
lags. Every other concern, including cost, is subordinate.

**Targets:** voice-to-voice **p50 ≤ 700ms, p95 ≤ 1.2s**; stretch p50 ~500ms.

**Latency budget (p50, pipelined):**

| Stage | Budget | Lever |
|---|---|---|
| Last speech frame → edge | 20–40ms | 20ms Opus frames, anycast edge proximity |
| End-of-turn detection (endpointing) | 150–300ms | Flux semantic endpointing (vs ~500–800ms fixed-silence) |
| STT final transcript | ~0–50ms | partials already streamed; overlaps endpoint |
| LLM time-to-first-token (TTFT) | 150–350ms | fast model, prompt-cache prefill, tight prompt |
| First speakable chunk | +30–80ms | eager chunking (first clause/comma, not full sentence) |
| TTS first audio byte (Aura) | 100–200ms | streaming TTS over a warm WS |
| Edge → client + playback start | 30–60ms | minimal jitter buffer |

Stages overlap via pipelining, so realized p50 is well under the serial sum.
**The two dominant, controllable levers are endpointing and LLM TTFT.**

**Optimizations:**
1. **Flux semantic endpointing** — detect end-of-turn on acoustic + semantic
   cues, not a fixed silence timeout; saves 300–500ms vs naive VAD. Tunable per
   agent (snappier for transactional, more patient for open-ended).
2. **Speculative generation** — start LLM inference on a stable partial / the
   predicted end-of-turn before it's confirmed; cancel and rerun if the user
   keeps talking. Trades a little compute for a big latency cut; gate on
   endpoint confidence.
3. **Eager TTS chunking** — stream the first speakable unit (clause/comma or
   first N words) to Aura immediately; first audio starts while the LLM is still
   generating.
4. **Latency-first model selection** — TTFT matters more than throughput for
   first audio. Default to a fast small model; reserve the large/external model
   for turns that genuinely need it.
5. **Colocation / placement** — pin the Call DO, Flux WS, Aura WS, and LLM
   inference to the same region near an edge GPU. Each streaming hop pays RTT
   repeatedly; a cross-region split silently adds 50–150ms per turn. Use Smart
   Placement / location hints.
6. **Warm connections** — open the Flux and Aura WebSockets at call start
   (during the greeting) and keep them alive for the whole call; never pay
   connection setup mid-turn. **Do not hibernate the DO between turns of an
   active call** — inter-turn gaps are sub-second and waking would add latency;
   hibernate only for parked/idle calls (corrects the earlier cost-first stance,
   see §13).
7. **Prompt-prefill discipline** — long system prompts and bloated injected
   memory inflate prefill → higher TTFT. Inject only top-K memory facts; use
   prompt caching so the static system prompt isn't reprocessed each turn.
8. **Escalation without stalling** — routing to an external model adds egress +
   provider latency. When escalating, mask it: emit a short local-model filler
   ("let me check that…") via the fast path while the slower model runs, or
   stream the external response as it arrives. Never block silently on a slow
   upstream.
9. **Pre-synthesized openers** — cache the greeting and common filler lines
   (KV/R2) so the call opens with zero synthesis latency.
10. **Fast barge-in** — small client VAD frames; on interruption the client
    mutes playback locally *immediately* and signals the DO to cancel TTS, so
    the user never talks over a bot that won't stop.

**Transport & latency:** on good networks the WS (TCP) transport adds little. On
lossy/mobile networks, TCP head-of-line blocking inflates *tail* latency
(p95/p99); WebRTC's UDP media path avoids this and is the main latency reason to
adopt the Cloudflare Realtime upgrade (§5) for mobile.

**Instrumentation:** every stage above is timestamped per turn and reported to
Analytics Engine; voice-to-voice p50/p95/p99 is a first-class SLO on the
dashboard (§12), with alerts on regression. You cannot optimize what you don't
measure.

## 5. Transport decision — WebSocket-native (Approach A)

The browser SDK captures mic audio via an AudioWorklet, runs **client-side VAD**
to gate out silence, Opus-encodes, and streams raw audio frames over a single
WebSocket to the Call Session DO. The DO transcodes to linear16/16kHz only at the
STT boundary, runs the agent loop, and streams synthesized audio back over the
same socket. Playback uses a small jitter buffer; browser `echoCancellation`
handles most echo.

**Why WS over WebRTC for a 1:1 voice agent:** lowest cost, simplest, fully
serverless, and matches the WS-only Deepgram models. On good networks, transport
latency is small relative to endpointing + LLM TTFT (§4), so WS-native is the
right MVP. WebRTC's strengths (multi-party SFU, UDP tail-latency on lossy links,
aggressive packet-loss recovery) come with a WebRTC→PCM media bridge that adds
complexity and cost. The SDK abstracts transport, so **Cloudflare Realtime
(WebRTC)** can be added in phase 2 — primarily to cut p95/p99 on mobile — without
touching the AI core.

## 6. Multi-tenancy

A **tenant** is a customer account. Every record, DO, and model call is scoped to
a `tenant_id`.

- **Identity & auth:** dashboard users authenticate via JWT carrying
  `tenant_id` + role/scopes; programmatic access via per-tenant API keys
  (hashed, scoped). The Signaling Worker validates and enforces on every request.
- **Data isolation:** `tenant_id` on every D1 row with mandatory query filters;
  DO names are namespaced (`t:{tenant}:call:{callId}`, `t:{tenant}:mem`); KV/R2
  keys prefixed by tenant. At very large scale, tenants can be promoted to a
  **D1-per-tenant** database for hard isolation.
- **Quotas & metering:** per-tenant concurrency cap (enforced at the Signaling
  Worker), per-tenant usage meters (STT/TTS minutes, LLM tokens, $). Each tenant
  gets its own AI Gateway (or gateway tag) for cost attribution and optional
  **BYOK** for external models.
- **Noisy-neighbor protection:** overflow async work goes to per-tenant Queues;
  new calls beyond the cap are rejected with `retry-after`.

## 7. Agent builder

Agents are tenant-owned configuration objects, edited in the dashboard, stored in
D1 (system of record) and cached in KV (hot config for fast DO cold-start).

An agent config:
- **Identity:** `agent_id`, name, avatar, description.
- **Voice:** Aura-1 voice selection (Angus, Asteria, Arcas, Orion, …) +
  rate/format options.
- **Role / persona:** short role descriptor used in prompt assembly.
- **System prompt template:** free text with `{{variable}}` placeholders.
- **Variables schema:** declares each dynamic variable — name, type, and
  **source**: `static` (default value), `call_init` (supplied in the
  start-call payload, e.g. `customer_name`), `memory` (resolved from the
  knowledge graph at call start), or `webhook` (fetched from a tenant endpoint).
  Resolved at call start; variables marked `live` are re-resolved each turn.
- **Tools:** list of enabled built-in tools + tenant-defined tool definitions
  (see §8).
- **LLM tier policy:** fast default model + escalation rule (when to route to a
  larger/external model via AI Gateway), tuned with latency in mind (§4).

**Prompt assembly at call start:** load agent config → resolve variables →
inject relevant memory (vectorless recall, §10, top-K only for prefill speed) →
produce the final system prompt for the turn loop.

## 8. Tool calling

The DO exposes the agent's enabled tools to the LLM (function-calling JSON
schema). On a tool call, the DO executes and returns the result into the
conversation.

**Built-in tools:**
- **`end_call(reason)`** — graceful termination. The DO speaks an optional
  closing line via Aura, flushes the transcript, enqueues the post-call job, and
  destroys itself. (Explicitly required.)
- **`recall_memory(query)`** — on-demand vectorless lookup against the tenant
  knowledge graph (§10).
- **`save_fact(subject, predicate, object)`** — explicit write into the memory
  graph during a call.
- **`get_variable` / `set_variable`** — read/update dynamic context mid-call.
- **`transfer_call(target)`** — stub for phase 2 (requires telephony/routing).

**Tenant-defined tools:** a JSON-schema function definition + a target webhook.
On invocation the DO calls the tenant's HTTPS endpoint through a Worker
(signed request, per-tenant secret, timeout + retry), and feeds the response back
to the LLM. Because tool calls add a round trip mid-turn, the agent should emit a
brief filler line while a slow tool runs (§4.8). This lets agents perform real
actions (book, look up an order, create a ticket) without custom platform code.

## 9. Call orchestration — DO turn loop

The Call Session DO is a state machine holding: the client WS, the Flux STT WS,
the Aura TTS WS, the LLM client, and live conversation state.

1. Client VAD detects speech → Opus frames → client WS → DO.
2. DO transcodes to linear16/16kHz → streams to **Flux** STT WS.
3. Flux emits partial transcripts + a **semantic end-of-turn** event.
4. On (or speculatively before, §4.2) end-of-turn: DO assembles transcript +
   history + tools → LLM (fast model default; escalate via AI Gateway per
   policy) → **streams tokens**.
5. DO buffers tokens into **speakable chunks** (eager, §4.3) → streams each to
   **Aura** TTS WS → receives audio chunks.
6. DO streams audio back over the client WS → jitter buffer → playback.
   Steps 4–6 pipeline to minimize **time-to-first-audio**.
7. **Tool call** instead of/with text → DO executes (§8), returns result, may
   continue the turn or end the call (emit filler if slow).
8. **Barge-in:** if client VAD fires during playback, the client mutes locally
   and sends an interrupt → DO cancels the TTS stream and flushes → loop restarts
   at step 2.
9. **Call end** (`end_call`, hangup, or timeout): DO flushes transcript to D1,
   enqueues the post-call job, persists the R2 recording if enabled, destroys.

**The DO stays warm for the duration of an active call** — turn gaps are
sub-second and waking from hibernation would add latency to every turn (§4.6).
The Flux and Aura WebSockets are opened at call start and kept alive.
Hibernation is reserved for parked/idle calls only.

## 10. Memory — vectorless knowledge graph ("never forget")

**Recommendation: a Cloudflare-native knowledge graph, vectorless.** To honor
the "everything on Cloudflare" constraint, the graph lives in **SQLite-backed
Durable Objects**, sharded per tenant (with per-caller subgraphs at scale). D1
serves as an optional durable mirror for analytics/export.

> **Alternative considered — FalkorDB:** a Worker can proxy to a managed
> FalkorDB instance (fast graph + built-in vector). It is purpose-built and
> capable, but it is **external to Cloudflare** (egress + a non-serverless
> dependency), which conflicts with the core constraint and adds per-query
> latency on the hot path. Kept as a documented fallback if graph query needs
> outgrow DO-SQLite.

**Graph model (vectorless):**
- **Nodes:** `Caller`, `Agent`, `Tenant`, `Call`, `Fact`, `Topic`,
  `Preference`, plus custom `Entity` types.
- **Edges:** `PARTICIPATED_IN`, `MENTIONED`, `STATED`, `PREFERS`,
  `FOLLOWS_UP_ON`, `RELATES_TO`, with properties (`call_id`, `ts`,
  `confidence`, `source`).
- **Retrieval is vectorless:** by entity identity + 1–2 hop graph traversal and
  structured/keyword filters (SQLite FTS5 over fact text) — **no embeddings, no
  vector index**. Retrieve by reasoning over a structured graph rather than
  vector similarity.

**Latency note:** recall sits on the call-start critical path, so it is bounded —
resolve the caller node + a shallow traversal, return **top-K** facts only, and
inject a tight summary into the prompt (§4.7). Deep/expensive traversal is
reserved for the async `recall_memory` tool, not call init.

**Write path:** the post-call Worker runs an LLM extraction step over the
transcript, pulling entities + relations + facts, deduping against existing
nodes, and upserting into the tenant's Memory DO. Mid-call, `save_fact` and
high-confidence detections can write immediately (off the hot path).

**Read path:** at call start, resolve the caller's node → shallow traverse to
preferences, prior-call summaries, and salient facts → inject top-K into the
system prompt. During the call, the agent can pull more via `recall_memory(query)`.

**Sharding:** memory is sharded by tenant; per-caller subgraphs keep each
traversal small and fast, so "never forget" scales without a single hot graph.

## 11. Storage map

| Data | Store | Notes |
|---|---|---|
| Tenants, users, API keys | D1 | control plane |
| Agent configs | D1 (+ KV cache) | KV for fast DO cold-start |
| Live call state | DO storage | ephemeral, per call |
| Call records (id, agent, caller, times, status, end_reason, cost, summary, tool_calls, latency stats) | D1 | logs/dashboard source |
| Transcripts | D1 (small) / R2 (large JSON) | turn-by-turn, speaker-labeled, timestamps |
| Recordings | R2 | optional, signed-URL playback |
| Knowledge graph | Memory DO (SQLite) | vectorless; D1 mirror optional |
| Static replies / openers | KV | greetings, fillers, FAQ lines (pre-synthesized) |
| Post-call jobs | Queues | summary, KG extraction, webhooks |
| Metrics | Analytics Engine | volume, per-stage latency, cost |

## 12. Observability — logs dashboard

A Pages dashboard, scoped per tenant:
- **Call list:** filter by agent/date/outcome/cost/latency; columns for duration,
  status, end reason, cost, voice-to-voice p50.
- **Call detail:** full **transcript** (turn-by-turn, speaker-labeled,
  timestamped), **LLM-generated summary**, cost breakdown (STT / TTS / LLM),
  **per-stage latency breakdown** (endpoint, TTFT, TTS TTFB, total per turn),
  tools invoked + results, and **recording playback** (R2 signed URL).
- **Aggregates:** call volume, **voice-to-voice p50/p95/p99**, cost trends,
  external-escalation rate — from Workers Analytics Engine, with latency-SLO
  alerts.
- **Live tail:** real-time structured logs via Workers Logs for active calls.

Summaries are generated post-call by the LLM in the Queue consumer. AI Gateway
per-call usage logs feed the cost breakdown and per-tenant attribution.

## 13. Cost optimization (secondary to latency)

Cost is optimized only where it does not regress latency. STT is the dominant
per-minute cost because it runs whenever the mic is open, so optimization centers
there:
1. **Client-side VAD** — never stream silence to STT; callers are silent ~50% of
   a call → roughly halves STT minutes. (No latency cost.)
2. **Flux endpointing** — turn-taking on the model side, no server-side VAD
   compute, fewer wasted LLM/TTS invocations. (Also a latency win, §4.1.)
3. **DO warm-during-call, hibernate-when-parked** — keep the DO warm for the
   active call (latency, §4.6); hibernate only genuinely idle/parked calls. Call
   wall-clock cost is small relative to the latency penalty of cold turns.
4. **Tiered LLM** — fast small model on Workers AI by default (in-network, $0
   egress, cheap, **and** low TTFT); escalate to a larger/external model only
   when policy triggers, masking the added latency with a filler (§4.8).
5. **AI Gateway caching** — prompt caching for the system prompt (also cuts
   TTFT); exact/semantic caching for FAQ-style replies; KV for static lines.
6. **Opus on the wire**, transcoded to linear16 only at the STT boundary —
   minimal bandwidth.
7. **Placement hints** to colocate DO + edge GPU + caller (primarily a latency
   lever, §4.5; also avoids egress).

Indicative per-minute envelope: STT ~$0.009 (less after VAD gating), TTS
$0.015/1k chars only while the agent speaks, LLM cents-or-less on Workers AI.
VAD gating + tiered LLM are the biggest cost levers.

## 14. Quality optimization (best output)

(Latency is covered separately in §4 as the primary constraint.)
1. **Flux end-of-turn accuracy** — natural turn-taking; no cutting users off or
   awkward dead air.
2. **Barge-in** — instant TTS cancel on interruption feels human (§4.10).
3. **Tiered LLM** — route hard turns to a larger/frontier model via AI Gateway.
4. **Aura context-aware prosody** + per-agent voice selection.
5. **Persistent memory** — recalling prior context makes the agent feel
   continuous and personal across calls.

## 15. Scale — 10k+ concurrent

- **DO-per-call** = horizontal sharding by design; the Signaling Worker is
  stateless and auto-scales.
- **Memory** sharded per tenant, per-caller subgraphs.
- **Multi-region** via placement hints; route each call to the nearest region
  that has GPU capacity, and colocate its DO + models there (§4.5).
- **Account limits:** watch per-account Workers AI / AI Gateway rate limits →
  request quota, use multiple gateways, or BYOK; enforce per-tenant concurrency
  caps and push overflow async work to Queues.

## 16. Error handling

- **STT/TTS WS drop** → DO reconnects with backoff and replays recent context.
- **LLM timeout/error** → AI Gateway provider fallback + a canned "one moment"
  line while retrying (the filler also covers latency, §4.8).
- **Client WS drop** → DO holds state for a short reconnect window (session
  token); otherwise finalizes the call.
- **Tool/webhook failure** → return a structured error to the LLM so it can
  recover gracefully in-conversation.
- **Overload** → Signaling Worker rejects new calls with `retry-after`;
  per-tenant caps prevent one tenant exhausting capacity.

## 17. Security

- JWT (dashboard) + hashed scoped API keys (programmatic); tenant claim enforced
  on every request.
- Strict tenant scoping on all storage access; optional D1-per-tenant isolation.
- Tenant webhook calls are signed with a per-tenant secret, timeout-bounded.
- BYOK secrets stored encrypted; external model traffic flows through AI Gateway.
- Recording/transcript retention is per-tenant configurable (compliance).

## 18. Testing

- **Unit:** DO state machine — turn transitions, speculative-generation cancel,
  barge-in, tool dispatch, end_call — with mocked STT/TTS/LLM WebSockets.
- **Integration:** synthetic audio fixtures → assert transcript, reply, audio
  out, and **per-stage latency budgets** (§4); memory write/read round-trip;
  dynamic-variable resolution; tenant isolation (cross-tenant access denied).
- **Load:** N concurrent WS clients → **voice-to-voice p50/p95/p99**, STT/TTS
  minutes, $/call, DO scaling behavior. Latency under load is the key gate.
- **Eval:** conversation-quality harness over recorded transcripts — turn
  accuracy, interruption handling, tool-calling correctness, hallucination
  checks, memory-recall relevance.

## 19. Data model sketch (D1)

```sql
tenants(id PK, name, plan, concurrency_cap, created_at)
users(id PK, tenant_id FK, email, role)
api_keys(id PK, tenant_id FK, key_hash, scopes, created_at)
agents(id PK, tenant_id FK, name, avatar, voice, role,
       system_prompt_template, variables_schema JSON, tools JSON,
       llm_tier_policy JSON, created_at, updated_at)
calls(id PK, tenant_id FK, agent_id FK, caller_ref, started_at, ended_at,
      duration_s, status, end_reason, cost_usd, summary, tool_calls JSON,
      latency_p50_ms, latency_p95_ms)
transcripts(call_id PK/FK, tenant_id FK, turns JSON)   -- or R2 pointer if large
-- knowledge graph lives in per-tenant Memory DO (SQLite); optional D1 mirror
```

## 20. Phased plan

1. **Phase 1 (MVP):** WS transport, single-tenant happy path — Flux STT (tuned
   endpointing), fast Workers AI LLM, Aura TTS, DO turn loop, **eager TTS
   chunking, warm WS connections, per-stage latency instrumentation**, barge-in,
   `end_call`. Basic call records + transcript. Latency SLO measured from day one.
2. **Phase 2:** multi-tenancy, agent builder (identity/voice/role/prompt +
   dynamic variables), tool calling (built-ins + tenant webhooks), logs
   dashboard with summaries + latency breakdown; **speculative generation**.
3. **Phase 3:** vectorless knowledge-graph memory (write + recall), AI Gateway
   tiered LLM escalation + caching, cost/usage metering per tenant.
4. **Phase 4:** scale hardening (sharding, multi-region routing, quotas),
   WebRTC/Cloudflare Realtime transport option (tail-latency on mobile), optional
   PSTN via Twilio adapter.

## 21. Open questions

- Memory store: confirm **CF-native DO-SQLite graph** (recommended) vs
  **FalkorDB** external.
- Latency SLO: confirm target (proposed voice-to-voice p50 ≤ 700ms, p95 ≤ 1.2s).
- Recording: on by default, opt-in, or per-tenant compliance setting?
- External LLM escalation policy: confidence-based, intent-based, or
  per-agent manual? (Note the latency cost — §4.8.)
