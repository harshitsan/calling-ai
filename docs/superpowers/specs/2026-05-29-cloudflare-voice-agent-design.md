# Cloudflare-Native Serverless AI Calling Product — System Design

**Date:** 2026-05-29
**Status:** Approved design (pre-implementation)

## 1. Overview

A multi-tenant, serverless conversational voice-AI platform running entirely on
Cloudflare. Clients sign up, build voice agents in a dashboard (identity, voice,
role, system prompt with dynamic variables, tools), and those agents hold
real-time, full-duplex voice conversations with end users. Conversations are
never forgotten: a per-tenant knowledge graph gives agents long-term memory via
vectorless retrieval. All inference uses open models hosted on Cloudflare
Workers AI, with optional escalation to external frontier models through AI
Gateway. The system is optimized for lowest cost and best output quality at
10k+ concurrent calls.

### Goals
- 100% Cloudflare serverless (Workers, Durable Objects, Workers AI, AI Gateway,
  D1, KV, R2, Queues, Analytics Engine, Pages).
- Real-time voice agent: STT → LLM → TTS duplex loop with natural turn-taking
  and barge-in.
- Multi-tenant with strict data isolation and per-tenant usage/cost attribution.
- In-app agent builder: identity, voice, role, templated system prompt with
  dynamic variables, tool calling.
- Persistent memory ("never forget") via a vectorless knowledge graph.
- Built-in `end_call` tool plus tenant-defined webhook tools.
- Observability: dashboard with all call logs, transcripts, summaries, cost.
- Lowest cost, best quality, 10k+ concurrent.

### Non-goals (phase 1)
- PSTN / phone numbers (no native Cloudflare PSTN). Designed as a drop-in later
  via a Twilio Media Streams → Worker adapter; the AI core is transport-agnostic.
- Multi-party calls (1:1 human↔AI only; no SFU needed in phase 1).
- WebRTC transport (phase 2 upgrade for adverse networks — see §4).

## 2. Cloudflare building blocks

| Capability | Primitive | Model / detail |
|---|---|---|
| Speech-to-text | Workers AI | `@cf/deepgram/flux` (WS-only, **end-of-turn detection**, built for voice agents); `@cf/deepgram/nova-3` for general/multilingual transcription |
| Text-to-speech | Workers AI | `@cf/deepgram/aura-1` (WS streaming, 13 voices, Opus output, $0.015/1k chars) |
| LLM (default) | Workers AI | Llama 3.3 (open model, in-network, $0 egress) |
| LLM (escalation) | AI Gateway | route to OpenAI / Gemini for hard turns; caching, fallback, BYOK, cost logs |
| Call orchestration | Durable Objects | one DO per call (state machine, WS fan-in/out), hibernation between turns |
| Memory graph | Durable Objects (SQLite) / D1 | per-tenant knowledge graph, vectorless traversal |
| Edge/signaling | Workers | stateless WS termination, auth, routing |
| Structured data | D1 (SQLite) | tenants, users, agents, call records, transcripts |
| Hot config | KV | agent configs, prompts, cached static replies |
| Recordings / blobs | R2 | call audio, large transcript JSON |
| Async work | Queues | post-call summary, memory extraction, webhooks |
| Metrics | Workers Analytics Engine | volume, latency, cost-trend dashboards |
| Dashboard UI | Pages | agent builder + logs/transcripts/summaries |

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
        │   Call Session Durable Object   (1 per call, hibernates)      │
        │                                                               │
        │   Flux STT (WS) ──► turn loop ──► LLM router ──► Aura TTS (WS) │
        │      ▲  partials/end-of-turn        │  default: Workers AI     │
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

        Dashboard (Pages): agent builder · call list · transcript · summary · cost · logs
```

**Core principle:** the **Call Session Durable Object** is the per-call
orchestrator and the only stateful component on the hot path. Everything else is
stateless (Workers) or managed (Workers AI, AI Gateway, storage). 10k concurrent
calls = 10k DOs — sharding is automatic, no central bottleneck.

## 4. Transport decision — WebSocket-native (Approach A)

The browser SDK captures mic audio via an AudioWorklet, runs **client-side VAD**
to gate out silence, Opus-encodes, and streams raw audio frames over a single
WebSocket to the Call Session DO. The DO transcodes to linear16/16kHz only at the
STT boundary, runs the agent loop, and streams synthesized audio back over the
same socket. Playback uses a small jitter buffer; browser `echoCancellation`
handles most echo.

**Why WS over WebRTC for a 1:1 voice agent:** lowest cost, simplest, fully
serverless, and matches the WS-only Deepgram models. WebRTC's strengths
(multi-party SFU, aggressive packet-loss recovery) aren't needed here, and a
WebRTC→PCM media bridge adds real complexity and cost. The SDK abstracts
transport, so **Cloudflare Realtime (WebRTC)** can be added in phase 2 for
clients on poor networks without touching the AI core.

## 5. Multi-tenancy

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

## 6. Agent builder

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
  (see §7).
- **LLM tier policy:** default Workers AI model + escalation rule (when to route
  to an external model via AI Gateway).

**Prompt assembly at call start:** load agent config → resolve variables →
inject relevant memory (vectorless recall, §9) → produce the final system prompt
for the turn loop.

## 7. Tool calling

The DO exposes the agent's enabled tools to the LLM (function-calling JSON
schema). On a tool call, the DO executes and returns the result into the
conversation.

**Built-in tools:**
- **`end_call(reason)`** — graceful termination. The DO speaks an optional
  closing line via Aura, flushes the transcript, enqueues the post-call job, and
  destroys itself. (Explicitly required.)
- **`recall_memory(query)`** — on-demand vectorless lookup against the tenant
  knowledge graph (§9).
- **`save_fact(subject, predicate, object)`** — explicit write into the memory
  graph during a call.
- **`get_variable` / `set_variable`** — read/update dynamic context mid-call.
- **`transfer_call(target)`** — stub for phase 2 (requires telephony/routing).

**Tenant-defined tools:** a JSON-schema function definition + a target webhook.
On invocation the DO calls the tenant's HTTPS endpoint through a Worker
(signed request, per-tenant secret, timeout + retry), and feeds the response back
to the LLM. This lets agents perform real actions (book, look up an order, create
a ticket) without custom platform code.

## 8. Call orchestration — DO turn loop

The Call Session DO is a state machine holding: the client WS, the Flux STT WS,
the Aura TTS WS, the LLM client, and live conversation state.

1. Client VAD detects speech → Opus frames → client WS → DO.
2. DO transcodes to linear16/16kHz → streams to **Flux** STT WS.
3. Flux emits partial transcripts + an **end-of-turn** event.
4. On end-of-turn: DO assembles transcript + history + tools → LLM (Workers AI
   default; escalate via AI Gateway per policy) → **streams tokens**.
5. DO buffers tokens into **sentence chunks** → streams each to **Aura** TTS WS
   → receives audio chunks.
6. DO streams audio back over the client WS → jitter buffer → playback.
   Steps 4–6 pipeline to minimize **time-to-first-audio** (<500ms target).
7. **Tool call** instead of/with text → DO executes (§7), returns result, may
   continue the turn or end the call.
8. **Barge-in:** if client VAD fires during playback, the client sends an
   interrupt → DO cancels the TTS stream and tells the client to flush its
   playback buffer → loop restarts at step 2.
9. **Call end** (`end_call`, hangup, or timeout): DO flushes transcript to D1,
   enqueues the post-call job, persists the R2 recording if enabled, destroys.

Between turns the DO **hibernates** (no idle compute billing) while keeping WS
connections via the hibernation API.

## 9. Memory — vectorless knowledge graph ("never forget")

**Recommendation: a Cloudflare-native knowledge graph, vectorless.** To honor
the "everything on Cloudflare" constraint, the graph lives in **SQLite-backed
Durable Objects**, sharded per tenant (with per-caller subgraphs at scale). D1
serves as an optional durable mirror for analytics/export.

> **Alternative considered — FalkorDB:** a Worker can proxy to a managed
> FalkorDB instance (fast graph + built-in vector). It is purpose-built and
> capable, but it is **external to Cloudflare** (egress + a non-serverless
> dependency), which conflicts with the core constraint. Kept as a documented
> fallback if graph query needs outgrow DO-SQLite.

**Graph model (vectorless):**
- **Nodes:** `Caller`, `Agent`, `Tenant`, `Call`, `Fact`, `Topic`,
  `Preference`, plus custom `Entity` types.
- **Edges:** `PARTICIPATED_IN`, `MENTIONED`, `STATED`, `PREFERS`,
  `FOLLOWS_UP_ON`, `RELATES_TO`, with properties (`call_id`, `ts`,
  `confidence`, `source`).
- **Retrieval is vectorless:** by entity identity + 1–2 hop graph traversal and
  structured/keyword filters (SQLite FTS5 over fact text) — **no embeddings, no
  vector index**. This is the "vectorless RAG" approach: retrieve by reasoning
  over a structured graph rather than vector similarity.

**Write path:** the post-call Worker runs an LLM extraction step over the
transcript, pulling entities + relations + facts, deduping against existing
nodes, and upserting into the tenant's Memory DO. Mid-call, `save_fact` and
high-confidence detections can write immediately.

**Read path:** at call start, resolve the caller's node → traverse to
preferences, prior-call summaries, and salient facts → inject into the system
prompt. During the call, the agent can pull more via `recall_memory(query)`.

**Sharding:** memory is sharded by tenant; per-caller subgraphs keep each
traversal small and fast, so "never forget" scales without a single hot graph.

## 10. Storage map

| Data | Store | Notes |
|---|---|---|
| Tenants, users, API keys | D1 | control plane |
| Agent configs | D1 (+ KV cache) | KV for fast DO cold-start |
| Live call state | DO storage | ephemeral, per call |
| Call records (id, agent, caller, times, status, end_reason, cost, summary, tool_calls) | D1 | logs/dashboard source |
| Transcripts | D1 (small) / R2 (large JSON) | turn-by-turn, speaker-labeled, timestamps |
| Recordings | R2 | optional, signed-URL playback |
| Knowledge graph | Memory DO (SQLite) | vectorless; D1 mirror optional |
| Static replies / prompts | KV | greetings, FAQ lines |
| Post-call jobs | Queues | summary, KG extraction, webhooks |
| Metrics | Analytics Engine | volume, latency, cost |

## 11. Observability — logs dashboard

A Pages dashboard, scoped per tenant:
- **Call list:** filter by agent/date/outcome/cost; columns for duration,
  status, end reason, cost.
- **Call detail:** full **transcript** (turn-by-turn, speaker-labeled,
  timestamped), **LLM-generated summary**, cost breakdown (STT / TTS / LLM),
  tools invoked + results, latency metrics, and **recording playback** (R2
  signed URL).
- **Aggregates:** call volume, p50/p95 time-to-first-audio, cost trends,
  external-escalation rate — from Workers Analytics Engine.
- **Live tail:** real-time structured logs via Workers Logs for active calls.

Summaries are generated post-call by the LLM in the Queue consumer. AI Gateway
per-call usage logs feed the cost breakdown and per-tenant attribution.

## 12. Cost optimization (lowest cost)

STT is the dominant per-minute cost because it runs whenever the mic is open, so
optimization centers there:
1. **Client-side VAD** — never stream silence to STT; callers are silent ~50% of
   a call → roughly halves STT minutes.
2. **Flux end-of-turn detection** — turn-taking on the model side, no server-side
   VAD compute, and fewer wasted LLM/TTS invocations.
3. **DO hibernation** between turns — no idle compute billing.
4. **Tiered LLM** — Llama 3.3 on Workers AI by default (in-network, $0 egress,
   cheap); escalate to an external model only when policy triggers.
5. **AI Gateway caching** — prompt caching for the system prompt; exact/semantic
   caching for FAQ-style replies; KV for fully static lines (greetings).
6. **Opus on the wire**, transcoded to linear16 only at the STT boundary —
   minimal bandwidth.
7. **Placement hints** to colocate DO + edge GPU + caller, reducing latency
   (latency drives perceived quality, not cost directly, but tighter loops mean
   shorter calls).

Indicative per-minute envelope: STT ~$0.009 (less after VAD gating), TTS
$0.015/1k chars only while the agent speaks, LLM cents-or-less on Workers AI.
VAD gating + tiered LLM are the biggest levers.

## 13. Quality optimization (best output)

1. **Flux end-of-turn accuracy** — the #1 voice-agent quality lever (no cutting
   users off, no awkward dead air).
2. **Barge-in** — instant TTS cancel on interruption feels natural and human.
3. **Full streaming pipeline** — LLM tokens → sentence chunks → Aura → playback
   for sub-500ms perceived first-audio.
4. **Tiered LLM** — route hard turns to a frontier model via AI Gateway.
5. **Aura context-aware prosody** + per-agent voice selection.
6. **Persistent memory** — recalling prior context makes the agent feel
   continuous and personal across calls.

## 14. Scale — 10k+ concurrent

- **DO-per-call** = horizontal sharding by design; the Signaling Worker is
  stateless and auto-scales.
- **Memory** sharded per tenant, per-caller subgraphs.
- **Multi-region** via placement hints; STT/LLM/TTS run at edge-GPU regions.
- **Account limits:** watch per-account Workers AI / AI Gateway rate limits →
  request quota, use multiple gateways, or BYOK; enforce per-tenant concurrency
  caps and push overflow async work to Queues.

## 15. Error handling

- **STT/TTS WS drop** → DO reconnects with backoff and replays recent context.
- **LLM timeout/error** → AI Gateway provider fallback + a canned "one moment"
  line while retrying.
- **Client WS drop** → DO holds state via hibernation for a short reconnect
  window (session token); otherwise finalizes the call.
- **Tool/webhook failure** → return a structured error to the LLM so it can
  recover gracefully in-conversation.
- **Overload** → Signaling Worker rejects new calls with `retry-after`;
  per-tenant caps prevent one tenant exhausting capacity.

## 16. Security

- JWT (dashboard) + hashed scoped API keys (programmatic); tenant claim enforced
  on every request.
- Strict tenant scoping on all storage access; optional D1-per-tenant isolation.
- Tenant webhook calls are signed with a per-tenant secret, timeout-bounded.
- BYOK secrets stored encrypted; external model traffic flows through AI Gateway.
- Recording/transcript retention is per-tenant configurable (compliance).

## 17. Testing

- **Unit:** DO state machine — turn transitions, barge-in, tool dispatch,
  end_call — with mocked STT/TTS/LLM WebSockets.
- **Integration:** synthetic audio fixtures → assert transcript, reply, audio
  out, and latency budgets; memory write/read round-trip; dynamic-variable
  resolution; tenant isolation (cross-tenant access denied).
- **Load:** N concurrent WS clients → p50/p95 time-to-first-audio, STT/TTS
  minutes, $/call, DO scaling behavior.
- **Eval:** conversation-quality harness over recorded transcripts — turn
  accuracy, interruption handling, tool-calling correctness, hallucination
  checks, memory-recall relevance.

## 18. Data model sketch (D1)

```sql
tenants(id PK, name, plan, concurrency_cap, created_at)
users(id PK, tenant_id FK, email, role)
api_keys(id PK, tenant_id FK, key_hash, scopes, created_at)
agents(id PK, tenant_id FK, name, avatar, voice, role,
       system_prompt_template, variables_schema JSON, tools JSON,
       llm_tier_policy JSON, created_at, updated_at)
calls(id PK, tenant_id FK, agent_id FK, caller_ref, started_at, ended_at,
      duration_s, status, end_reason, cost_usd, summary, tool_calls JSON)
transcripts(call_id PK/FK, tenant_id FK, turns JSON)   -- or R2 pointer if large
-- knowledge graph lives in per-tenant Memory DO (SQLite); optional D1 mirror
```

## 19. Phased plan

1. **Phase 1 (MVP):** WS transport, single-tenant happy path — Flux STT, Workers
   AI LLM, Aura TTS, DO turn loop, barge-in, `end_call`. Basic call records +
   transcript.
2. **Phase 2:** multi-tenancy, agent builder (identity/voice/role/prompt +
   dynamic variables), tool calling (built-ins + tenant webhooks), logs
   dashboard with summaries.
3. **Phase 3:** vectorless knowledge-graph memory (write + recall), AI Gateway
   tiered LLM escalation + caching, cost/usage metering per tenant.
4. **Phase 4:** scale hardening (sharding, multi-region, quotas), WebRTC/
   Cloudflare Realtime transport option, optional PSTN via Twilio adapter.

## 20. Open questions

- Memory store: confirm **CF-native DO-SQLite graph** (recommended) vs
  **FalkorDB** external.
- Recording: on by default, opt-in, or per-tenant compliance setting?
- External LLM escalation policy: confidence-based, intent-based, or
  per-agent manual?
