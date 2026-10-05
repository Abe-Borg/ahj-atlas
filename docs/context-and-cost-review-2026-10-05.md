# How context moves through AHJ Atlas, and where the money goes

Review of the code at commit `f2ddf52` (version 1.9.0), written 2026-10-05. Everything in sections 1 to 5 is read directly from `lib/*.mjs` and `server.mjs`; the design notes in `docs/` were used to understand intent. Nothing was run against a live key, and this checkout has no `data/` folder, so no real usage was measured. Prices and caching rules in section 6 were fetched from Anthropic's pricing and prompt-caching pages on 2026-10-05 and match `lib/config.mjs` (price date 2026-09-28).

This file is uncommitted. Keep it, move it, or delete it as you decide.

---

## 1. The short version

- Three functions build every model request: `researchPayload` (jurisdiction, contacts, codes, Opus evidence check), `reviewPayload` (final report) and `chatPayload` (Chat with Atlas). Everything else persists what came back or runs tools.
- Context is never handed from one stage to another in memory. Every handoff goes through SQLite: stage briefs (`stages.output`), checkpoints (`stages.checkpoint`), the source register (`sources`), the saved report (`projects.report`), question responses, and for chat a frozen opening snapshot (`chat_evidence`).
- Every model call re-sends its whole conversation. The app leans on prompt caching to make that cheap, and its prefix discipline is correct: stable material first, volatile material last, and the saved original request reused byte-for-byte inside a conversation.
- Verdict: the architecture is already where a careful cost review would push it. The remaining savings fall into three groups. (a) Two caching decisions (research TTL in real-time mode, and in batch mode) that can only be settled from the usage you already record; the queries are in section 9. (b) Three quality-neutral code changes: stop rebuilding the chat opening on every research round when someone chats mid-research; stop sending the final chat request with `tool_choice: none` if usage confirms it rewrites the whole conversation; trim duplicated brief text from fresh-context research requests. (c) The one large lever, effort, which is a quality trade and needs the small eval your own docs already sketch.

---

## 2. Where context lives

| Store (SQLite) | What it holds | Written by | Read into a prompt by |
|---|---|---|---|
| `projects.input` | name, address, discipline, scope, occupancy, permitDate, notes (including appended "User clarification: …"), country, siteDescription, `previousAddresses` (last 5), `questionResponses` snapshot taken at resume | `Store.create`, `Engine.resume` | `research_context.projectInputs`; `evidence_package.project`; chat `context` preview |
| `stages.messages` | the exact message array of the stage's current conversation segment: first user turn, assistant blocks (thinking notes, signatures, server tool results, tool calls), tool results | `Engine.applyOnce`; cleared by `freshContext` and `resume` | continuation rounds of `researchPayload` / `reviewPayload` |
| `stages.output` | the stage brief: the `finish_research` brief (plus NFPA checklist), or accumulated text for partial stages, up to 240,000 chars | `applyOnce`, `markPartial` | `priorJurisdictionBrief` (first 20,000 chars), `priorWorkingBrief` (last 24,000), `evidencePackage.stages[].findings` (first 80,000), chat `research` preview |
| `stages.checkpoint` | brief ≤ 6,000 chars, ≤ 12 quote-verified claims, ≤ 20 questions, ≤ 100 source IDs, ≤ 6 progress notes × 2,500 chars, ≤ 5 saved lookups × 2,400 chars | `save_progress` (validated), `checkpointFromMessages` | `research_context.checkpoint` (≤ 24,000 chars), `evidencePackage`, chat `research` preview |
| `attempts.payload / response / usage` | every request body and response verbatim, plus usage and cost | `Store.reserve`, `Engine.record`, chat | `latestAttemptPayload` (prefix reuse), `previousMessageId` (cache diagnostics), chat restart recovery, cost ledger |
| `sources` | url, title, text (≤ 180,000 chars for web and fetched pages, ≤ 2,000,000 for uploads), `read_full`, kind, retrieved, document_date | `ResearchTools` (read, render, fetch capture, upload, search capture) | `evidencePackage` excerpts, chat opening excerpts and tail, `read_saved_source`, `validateReport` quote checks |
| `known_links` | every link seen on a read page (≤ 1,000 per page) | `commitRead`, `render` | chat URL guard; report website validation |
| `question_responses` | open / answered / dismissed / closed per gap ID | `saveQuestion`, `closeQuestions`, chat Apply | `input.questionResponses` at resume; chat `questions` preview |
| `projects.report` | the validated report JSON | `saveReport` | chat opening `report` preview; question derivation; exports |
| `chat_turns` | user_text, answer, answer_parts (citations), proposals, status, note, live draft | `ProjectChat` | chat history; `read_project conversation` |
| `chat_evidence` | one frozen opening per project: revision digest, per-source fingerprints, the opening blocks | `savedChatEvidence` | `chatPayload` |
| `report_notes` | notes saved from chat | chat Apply | chat `notes` preview only; research and review never read them |
| `events`, `diagnostics` | activity lines; request summaries, usage, cache-miss reasons, `resource.exhausted` rows | everywhere | `read_project activity` (events only) |

Two things never enter any prompt: the API key (held in `KeyVault`, injected by `provider.mjs` as a header) and other projects' records (every store call is keyed by project ID chosen by the server, never by the model).

---

## 3. Anatomy of one model request

```
 ┌──────────────────────── one POST /v1/messages (streamed via the SDK) ────────────────────────┐
 │ model · max_tokens · thinking {adaptive, display} · output_config {effort [, format]}        │
 │ cache_control {ephemeral, ttl}   ← top-level: automatic breakpoint on the last block         │
 │ diagnostics {previous_message_id} ← cache-miss diagnosis, no charge                          │
 ├─────────────┬──────────────────────┬──────────────────────────────────────────────────────────┤
 │ tools[]     │ system               │ messages[]                                               │
 │ first in    │ second               │ user … assistant … user …                                │
 │ the prefix  │                      │ re-sent in full on every round of a conversation         │
 └─────────────┴──────────────────────┴──────────────────────────────────────────────────────────┘
   cache prefix = tools → system → messages, matched byte for byte up to each breakpoint
```

Before every paid request, two free calls run: `preflight` (the Models API, once per key, cached in memory) and `count_tokens` on the exact payload. The count gates the request (research 300,000 tokens, chat the model's context window less 128,000) and decides whether a research conversation restarts from its checkpoint (at 200,000).

| | Research stages | Opus evidence check | Final report | Chat Standard | Chat Premium |
|---|---|---|---|---|---|
| Model | Sonnet 5.5 | Opus 5.5 | Opus 5.5 | Sonnet 5.5 | Opus 5.5 |
| Effort | high (jurisdiction, codes), medium (contacts) | high | high | high | high |
| `thinking.display` | updates | updates | omitted | updates | updates |
| `max_tokens` (ceiling, not a target) | 60,000 | 60,000 | 100,000 | 128,000 | 128,000 |
| Cache TTL | 5m real-time / 1h batch | same | same | 1h | 1h |
| Explicit breakpoints | system block | system block | evidence_package block | opening end, history end | same |
| Structured output | no | no | `REPORT_WIRE_SCHEMA` | no | no |
| Tools | web_search (≤ 4), web_fetch (≤ 3), read_source, read_saved_source, render_page, inspect_pdf, locate_address, save_progress, finish_research | same, caps from the stage allowance | read_saved_source only | 3 project tools, 4 public-source tools, 4 proposal tools, web_search (4), web_fetch (3) | same |
| System prompt size | ~1,000 words, identical for all four stages | same | ~950 words, project-specific NFPA lines | ~1,250 words, names the model and effort | same |

---

## 4. The research pipeline

### 4.1 The round loop

A stage is an agentic loop, but each round is a separate dispatch through the scheduler rather than a tight `while` loop. That is what makes every round restartable from SQLite.

```
            every 1 s                       ┌───────────────────────────────────────────────┐
  tick ──────────────► choose a queued      │ dispatch(project, stage)                      │
   ▲   (≤ 2 stages    stage whose           │ 1 build payload: reuse the saved original     │
   │    at once)      dependencies are      │   request + stage.messages, or a fresh /       │
   │                  complete              │   finish-only context (section 4.5)           │
   │                                        │ 2 preflight (model capabilities, free)        │
   │                                        │ 3 count_tokens (free); rebuild smaller if     │
   │                                        │   ≥ 200k research / > 300k review             │
   │                                        │ 4 store.reserve → attempt row (estimate)      │
   │                                        │ 5 provider.message (stream) or .batch         │
   │                                        └──────────────────┬────────────────────────────┘
   │                                                           ▼
   │                                        ┌───────────────────────────────────────────────┐
   │  stage.messages = payload.messages     │ apply(attempt)                                │
   │    + assistant turn + tool results     │ · capture search results and web fetches      │
   │  stage.checkpoint = checkpointFrom…    │   into `sources`                              │
   │  stage.output / status / note          │ · run client tools (read_source in pairs)     │
   └────────────────────────────────────────┤ · validate finish_research / save_progress    │
                                            │ · save each tool result (tool_runs)           │
                                            └───────────────────────────────────────────────┘
```

Dependencies: contacts and codes wait for jurisdiction (complete or partial) and may run in parallel; the evidence check waits for all three; the final report waits for everything.

### 4.2 What the first request of a stage contains

The user message of a new conversation segment is one escaped JSON block followed by the assignment:

```
<research_context>
{ researchDate, projectInputs, [priorJurisdictionBrief], [checkpoint, priorWorkingBrief],
  [evidencePackage], [sourceLeads] }
</research_context>

<assignment>
Stage: … · task text · [FIRE PROTECTION COVERAGE checklist] · [location note]
Limits: at most N requests … searches and reads remaining · workflow text
</assignment>
```

| Field | Jurisdiction | Contacts | Codes | Evidence check |
|---|---|---|---|---|
| `researchDate` (date only, so it is stable within a day) | yes | yes | yes | yes |
| `projectInputs` (all of `projects.input`) | yes | yes | yes | yes |
| `priorJurisdictionBrief` (first 20,000 chars of the jurisdiction brief) | no | yes | yes | no |
| `checkpoint` (≤ 24,000) and `priorWorkingBrief` (last 24,000 chars of this stage's output) | only when the stage already has output or a checkpoint (resume, restart, fresh context) | same | same | same |
| `evidencePackage` (100,000 chars of ranked excerpts from `sources`, each non-review stage's brief ≤ 80,000 chars plus its checkpoint, the review checkpoint) | same condition | same | same | always |
| `sourceLeads` (id, url, title, readFull of every source) | no | no | fire-protection projects, first conversation only | no |

So a brand-new project's jurisdiction stage starts with nothing but the inputs and the assignment. Contacts and codes add the jurisdiction brief. Everything larger enters only when a stage resumes or restarts, or for the evidence check.

The system prompt is one fixed string for all four stages: role, trust and scope, source and applicability rules, evidence rules, research output rules, and the unattended-run rules. It carries no project data, which is what lets it sit at the front of the cache prefix.

### 4.3 What later rounds add

A continuation round reuses the saved original request (`store.latestAttemptPayload`) and replaces only `messages` with `stage.messages`, so model, system, tools, thinking settings and cache markers are byte-identical. The appended material is:

- The assistant turn: thinking blocks (under `display: updates` these carry the short progress notes, plus the opaque signature), text, `server_tool_use` + `web_search_tool_result` pairs (encrypted result content plus snippets), `web_fetch_tool_result` (a document block: up to 60,000 tokens of text, or a whole base64 PDF), and `tool_use` calls.
- The user turn: one `tool_result` per call.
  - `read_source` → JSON `{sourceId, retrieved, url, title, note, offset, totalCharacters, truncated, nextOffset, text, links}`; `text` is 8,000 chars by default and up to 60,000 on request, or matched passages when `query` is set; `links` is the 60 most relevant links.
  - `read_saved_source` → `{sourceId, url, title, readFull, totalCharacters, spans, text, nextOffset, note}` from the register, no network.
  - `render_page` → like `read_source` from a headless browser.
  - `inspect_pdf` → a short text plus a PNG of one page (long side ≤ 1,500 px).
  - `locate_address` → Census geographies for the current address.
  - `save_progress` → "Working progress saved…"; `finish_research` → "Investigation recorded." or the validation error.
  - Any failure → `is_error: true` with the message.
- Harness messages, only at the end of `messages`: a `continuationPrompt` user message after a text-only turn (at most 2 per stage, names the coverage still owed and up to 5 saved questions), and the `WRAP_UP` system-role message on request 11 of 12 (5 of 6 for the evidence check).

Search results and fetched pages are captured into `sources` on every round (`captureSearchSources`, `captureFetches`), which is how later stages and chat can cite them without the raw blocks.

### 4.4 Stage-to-stage handoff

```
 jurisdiction ── brief, first 20,000 chars ──► contacts ──┐
      │                                                   │
      └──────── brief, first 20,000 chars ──► codes ──────┤
                                                          ▼
  sources (register) ────────────────────► evidence check  [Opus]: evidencePackage =
  briefs + checkpoints of all stages ────►   100,000 chars of ranked excerpts
                                              + each brief ≤ 80,000 chars
                                                          │
                                                          ▼
  sources ──────────────────────────────► final report    [Opus]: evidencePackage =
  briefs + checkpoints ─────────────────►   600,000 chars of excerpts (fill mode,
                                              ≤ 100,000 per source) + briefs ≤ 80,000
                                                          │
                                                          ▼
                                   report JSON → decodeReport → validateReport → projects.report
                                                          │
                                                          ▼
                              chat opening snapshot (report, briefs, register, excerpts)
```

Excerpt selection (`allocateEvidence` + `selectPassages`) shares the character budget across sources that have retrieved text, ranks passages toward exact quotes in the findings, address and parcel terms, adoption clauses, NFPA references and contact patterns, and in fill mode spends the rest of each share on the document in order. Spans keep their original offsets, so later quote validation can match them.

The only path from chat back into research is a user-applied proposal: an answer or dismissal (→ `question_responses` → `input.questionResponses` at the next resume), a clarification (→ `input.notes`), or an address correction (→ `input.address`, `previousAddresses`). Report notes never reach research.

### 4.5 Context resets

```
 live segment (stage.messages)                           new segment (fresh = true)
 ┌──────────────────────────────────┐                    ┌──────────────────────────────────┐
 │ system + tools (original)        │ checkpointFrom     │ system + tools (rebuilt with the  │
 │ user: research_context           │ Messages keeps:    │   current search/fetch caps)      │
 │ assistant: searches, calls, notes│  brief, claims,    │ user: research_context with       │
 │ user: tool results (page text,   │  questions, source │   checkpoint ≤ 24k,               │
 │   fetched documents, …)          │  IDs, ≤ 6 notes,   │   priorWorkingBrief ≤ 24k,        │
 │ … up to 200,000 counted tokens   │  ≤ 5 saved lookups │   evidencePackage (ranked         │
 └──────────────────────────────────┘ drops: raw page    │   excerpts rebuilt from sources)  │
   (kept only in attempts.payload)    text, search       └──────────────────────────────────┘
                                      results, thinking
```

Triggers, checked before the next request is counted or sent: the count reaches 200,000 tokens; the segment contains any fetched PDF or ≥ 120,000 chars of fetched text; the search or fetch `max_uses` the conversation declared would have to shrink; a `max_uses_exceeded` search error while searches remain; and the finish-only fallback at the round limit. Each stage may restart four times; after that the next request may only finish. Restarts do not add rounds.

### 4.6 The final report request

```
 tools:  read_saved_source (strict)            none on the finish-only fallback
 system: common rules + <review_assignment> (+ NFPA review instructions)   plain string, no marker
 messages:
   user: [ <evidence_package>{ project, researchDate, stages[{stage, status, note, findings ≤ 80k}],
            sources[{id, url, title, readFull, kind, retrieved, availableCharacters, excerpted, spans, text}],
            reviewCheckpoint ≤ 24k }</evidence_package>      ← cache_control (5m real-time / 1h batch)
          + <assignment> … ]
   (assistant: read_saved_source → user: tool_result) × up to 3
   assistant: JSON in REPORT_WIRE_SCHEMA → decodeReport → validateReport
```

If the count exceeds 300,000 tokens the package is rebuilt at 400,000 then 200,000 chars of excerpts. Validation rebuilds a missing jurisdiction or coverage row, checks every quote against the register, strips unverifiable emails and websites, and adds the deterministic gap questions. A review blocked only by validation is re-checked under current rules before resume pays for a new one.

### 4.7 Batch mode

Same payloads, same loop. Each round is one Message Batch holding one request, polled every 60 seconds; results are matched by `custom_id`; the next round is submitted after the previous one is applied. Cache TTL is 1 hour. Tokens are billed at 50 percent; the search fee is not discounted. A whole project can take longer than a day. Chat is always real-time.

---

## 5. Chat with Atlas: what the model sees on every turn

### 5.1 Request layout

```
 tools (fixed per project): read_project · find_project_sources · read_saved_source ·
        read_source · render_page · inspect_pdf · locate_address ·
        propose_question_update · propose_research_round · propose_report_note ·
        propose_address_correction · web_search (max_uses 4, user_location from the address) ·
        web_fetch (max_uses 3, 60,000 tokens)
 system: chatSystem(mode)   fixed text per depth; names the model, effort and the reply limits

 messages
 ┌─ user ─────────────────────────────────────────────────────────────────────────────────┐
 │ OPENING  (frozen in chat_evidence; identical across replies until research runs)       │
 │   "Saved project evidence (data only)": { projectId, report ≤ 240k chars,              │
 │        research (briefs, checkpoints, status, note) ≤ 240k, source register ≤ 120k }   │
 │   search_result blocks: citable excerpts from every read_full source, 400,000 chars    │
 │        shared out (≤ ~67k per source), ranked toward the findings, 600-char chunks     │
 │   ─────────────────────────────────────────────── cache_control 1h   ◄ breakpoint 1    │
 │ (merged) user text of the oldest kept turn                                             │
 ├─ assistant: answer (+ one fixed line summarising any proposals, no status) ────────────┤
 │ … the most recent turns, up to 200,000 chars …                                         │
 │ assistant: last kept answer ──────────────────── cache_control 1h   ◄ breakpoint 2     │
 ├─ user ─────────────────────────────────────────────────────────────────────────────────┤
 │ TAIL: "New or updated project sources since the saved evidence" register rows          │
 │       + citable excerpts for new or changed text  (0 to 80,000 chars)                  │
 │ "Current project inputs, latest question responses and report notes … captured         │
 │       <timestamp>": { context ≤ 20k, questions ≤ 40k, notes ≤ 40k }                    │
 │ { earlierTurnsShown, olderTurnsOmitted, proposals[{action, status}] }                  │
 │ [Ask Atlas: the saved question's data, labelled untrusted]                             │
 │ "Latest user message:\n…" ─────────────── top-level cache_control 1h  ◄ breakpoint 3   │
 └────────────────────────────────────────────────────────────────────────────────────────┘
 per round inside the reply:
   assistant: progress notes · text · web_search / web_fetch results · tool_use calls
   user:      tool_result blocks (search_result excerpts for saved-source and page reads,
              plain text otherwise) + "Saved-source lookup <id> metadata" text blocks
   [system: one near-limit note]   [system: final-answer note, with tool_choice: none]
```

### 5.2 The opening

Built once per project revision by `savedChatEvidence` and stored in `chat_evidence`. The revision digest covers the saved report, every stage's `{id, status, output, note, checkpoint}`, and the ID of the latest non-chat attempt. Per-source fingerprints (metadata and text) decide what goes in the tail. The opening is rebuilt when the digest changes or when the serialized tail would exceed 80,000 chars. Chat's own searches, page reads, fetches and uploads never rebuild it; they arrive through the tail.

For a project with many retrieved sources the opening is large on purpose. Your own notes put a large project's first message near 300,000 tokens.

### 5.3 History

Earlier turns are real `user` / `assistant` messages: the user's text and the saved answer, plus a fixed one-line summary of any proposals without their status (so applying a card does not change cached bytes). The most recent turns are kept up to 200,000 chars. Tool results, progress notes and thinking from earlier replies are not re-sent; `read_project conversation` is the way back to older turns.

### 5.4 The volatile block

After the second breakpoint, in order: the tail, the current project context (status, estimated cost, inputs), the latest question responses, the report notes, a timestamp, turn counts, proposal statuses, the Ask Atlas question when one was chosen, and the user's message. All of it changes per reply, so it sits last.

### 5.5 Inside a reply

Up to 20 requests, 60 lookups, 20 searches, 30 page reads (fetches included) and about 20 minutes of lookups. Each round appends the assistant turn and the tool results; the payload's system, tools and earlier messages never change within a reply. Page reads join the register immediately and come back as citable `search_result` blocks under the saved source ID. One near-limit system note and one final-answer system note are the only harness text. A fetched PDF or 120,000 chars of fetched text ends lookups. The final request carries `tool_choice: none`.

### 5.6 What chat never sees

Other projects; the raw `stage.messages`; prior replies' tool results or thinking; the key; proposal statuses inside the cached region. Everything it can reach is bounded by the project ID the server chose.

---

## 6. The cost model

Prices fetched 2026-10-05, matching `lib/config.mjs`:

| | Sonnet 5.5 | Opus 5.5 |
|---|---|---|
| Input | $2 / MTok | $4 / MTok |
| 5-minute cache write | $2.50 | $5 |
| 1-hour cache write | $4 | $8 |
| Cache read (refreshes the timer) | $0.20 | $0.20 |
| Output, thinking included | $10 | $20 |
| Batch | 50 percent off every line above, cache reads and writes included | |
| Web search | $10 per 1,000; errored searches are not billed; results count as input tokens on every later round | |
| Web fetch | tokens only | |
| Token counting | no token charge | |

Caching rules that shape the numbers below (from Anthropic's prompt-caching page, 2026-10-05):

- The TTL is measured from the **start** of the request that wrote or last read the entry. Generation time counts. A 4-minute response leaves about 1 minute for the next request on a 5-minute entry.
- Each breakpoint looks back at most 20 positions for an earlier entry. A run of consecutive `tool_use` blocks is one position, as is a run of `tool_result` blocks; other blocks count individually.
- 1-hour breakpoints must precede 5-minute ones; the automatic top-level breakpoint and an explicit marker on the last block must agree on TTL.
- Minimum cacheable prefix is 512 tokens on both models.
- Server tools insert their own 5-minute writes after their results.
- Changing `tool_choice` keeps the tools and system caches but invalidates the messages cache. Changing `thinking` or top-level `effort` invalidates the messages cache. Changing model or tool definitions invalidates everything.

Per-round input cost ≈ (cached prefix × $0.20/M) + (new tokens × write rate) + (uncached tokens × input rate). Output cost = (visible + thinking tokens) × output rate. Everything below is arithmetic on the app's own limits, not a measurement.

**A. Real-time research round, Sonnet, 150,000-token conversation, 8,000 new tokens**

| | 5m TTL, cache hit | 5m TTL, cache expired | 1h TTL, cache hit |
|---|---|---|---|
| Prefix | 150k × $0.20/M = $0.030 | 150k × $2.50/M = $0.375 | $0.030 |
| New tokens | 8k × $2.50/M = $0.020 | 8k × $2.50/M = $0.020 | 8k × $4/M = $0.032 |
| Input total | **$0.05** | **$0.40** | **$0.06** |

The 1-hour TTL costs about one cent more per round and prevents a $0.35 miss. One avoided miss per ~35 rounds pays for it. Anthropic's published rule of thumb: switch to 1 hour once about 1 round in 20 follows a 5 to 60 minute gap; when nothing pauses, 5 minutes is about 15 percent cheaper.

**B. Opus evidence-check round, 120,000-token conversation, 8,000 new tokens**

5m hit $0.064 · 5m miss $0.60 · 1h hit $0.088. Break-even is one avoided miss per ~22 rounds.

**C. Chat, 300,000-token opening**

First write of the opening: Sonnet $1.20, Opus $2.40. Every later round of every reply re-reads it for $0.06 on either model. A 6-round reply therefore spends about $0.36 re-reading the opening before history, tool results, searches and output. A rebuild (research ran, tail above 80,000 chars, the other depth was chosen, or more than an hour idle) costs another $1.20 or $2.40.

**D. Batch research round, Sonnet, 150,000-token conversation**

1h hit $0.015 · 1h miss $0.30 · 5m miss $0.19. Because batch turnaround is rarely under 5 minutes, assume the 5-minute cache never hits in batch mode; the 1-hour TTL then wins only if at least about 40 percent of batch rounds hit it.

**E. Thinking**

At high effort a round's thinking can run to several thousand tokens. 10,000 thinking tokens cost $0.10 on Sonnet and $0.20 on Opus. Across a 40-round project that is the same order of magnitude as all the cache reads combined. Effort is the only control.

---

## 7. What is already right

These are the things a cost review normally has to fix, and they are already done:

- Stable prefixes. The system prompts carry no project data; tools are fixed for the life of a conversation; a continuation reuses the saved original request byte for byte; the only dates near the front are a day-granular research date and an evidence-package timestamp that is frozen with the first message of its segment.
- Breakpoints as recommended: an explicit marker on the static prefix plus automatic caching for the growing tail, with matching TTLs. Chat uses three of the four slots at exactly the three stability boundaries.
- The chat opening is frozen in SQLite and survives restarts; chat's own reads and uploads flow through the tail instead of invalidating it; proposal status travels uncached so applying a card does not disturb history.
- Harness instructions are appended as `role: system` messages at the end, never edited into the system prompt, with the documented user-turn fallback.
- Fetched documents are bounded: a PDF or 120,000 chars of fetched text restarts research from a checkpoint and ends chat lookups, so a large document is paid for once rather than every round.
- Checkpoint restarts at 200,000 counted tokens keep the quadratic cost of long loops in check while preserving verified claims.
- Batch mode exists and is the single largest zero-quality-cost lever (50 percent). The 1-hour TTL in batch mode is the right default to start from.
- `count_tokens` gates every request, so nothing is sent above the ceilings.
- The basic web tools are the right choice: the dynamic-filtering variants run through code execution and would complicate capture and citations.
- Usage, cache breakdowns, stop reasons and cache-miss reasons are stored per attempt. You can audit cache behaviour without spending anything (section 9).
- Effort is set explicitly everywhere, so model-default changes cannot silently shift spend.

---

## 8. Where money can be saved

Ranked by expected effect. Only the first group is quality-neutral by construction. Any change you make here also touches the trust surfaces, per the repo's own rule (`public/trust.js`, `public/trust-facts.js`, `docs/TRUST_CLAIMS.md`, README, help).

### 8.1 Quality-neutral; decide from your data

**1. Real-time research TTL: 5 minutes may be the wrong setting.** A research round's start-to-start gap is generation time (high effort, up to 4 searches and 3 fetches inside the turn) plus tool execution (paired page reads with 25-second timeouts, PDF parsing, rendering) plus `count_tokens` plus the tick. If that regularly exceeds 5 minutes, every such round rewrites the entire conversation at 1.25× (worked example A: $0.35 wasted per miss on Sonnet, $0.54 on Opus). Query 3 in section 9 shows the gaps and the rewrite signature directly. If more than roughly 1 round in 20 misses, change `cacheTTL` so real-time uses 1 hour too. It is a one-line change in `lib/config.mjs`; `reserveMicros` already prices either TTL. If misses are rare, leave it: 5 minutes is cheaper by about 15 percent of write cost.

**2. Batch-mode TTL: check the hit rate.** Each batch round is a separate submission polled every minute, so hits depend on Anthropic's turnaround. Query 2 restricted to `mode = 'batch'` gives the read share. Below about 40 percent, the 5-minute TTL would be cheaper in batch mode (worked example D) because a missed 1-hour write costs 2× instead of 1.25×.

**3. Stop rebuilding the chat opening on every research round.** The revision digest in `savedChatEvidence` includes each stage's `status` and `note` and the latest research attempt ID, all of which change on every research round. Anyone who chats while research is running therefore pays a full 1-hour write of the opening on every reply (worked example C: $1.20 or $2.40 each). The quality-neutral fix is to digest only what the opening actually needs to stay correct for citations, which is `report`, each stage's `output` and `checkpoint`, and move `status` and `note` into the uncached context block (they are already there as project status, and `read_project research` is live). Rebuild on stage completion and report change, not on every round.

**4. The final chat request and `tool_choice: none`.** Per Anthropic's invalidation rules, changing `tool_choice` invalidates the messages cache; your 2026-09-29 note says the same. If that holds, every reply that reaches the final-answer path (any fetched PDF, 120,000 fetched chars, 17+ searches, 28+ reads, the 20th request, or 17 minutes elapsed) rewrites the whole conversation including the opening at 1-hour rates: $1.20 to $2.40 on a large project, plus the history and the round's tool results. Confirm it first: query 5 lists each reply's rounds; on a reply that ended through the final path, compare the last round's `cache_creation.ephemeral_1h_input_tokens` with its `cache_read_input_tokens`. If the last round wrote the prefix again, replace `tool_choice: none` with the system-role instruction alone and answer any further tool call with an error result (the loop already finishes `limited` in that case). The hard guarantee becomes a soft one, bounded by the existing request cap; the saving is a full rewrite per affected reply. This is the one item here where the behaviour changes slightly, so I list it as "confirm, then decide".

**5. Duplicated text in fresh-context research requests.** When a stage resumes or restarts, `research_context` carries `priorWorkingBrief` (last 24,000 chars of the stage's output), `priorJurisdictionBrief` (20,000) and `checkpoint` (24,000), and `evidencePackage.stages[].findings` carries the same output (first 80,000 chars) and the same checkpoint again. Up to roughly 70,000 duplicated chars (about 17,000 tokens, $0.04 at the 5-minute write rate on Sonnet, $0.09 on Opus) per fresh request, up to five fresh requests per stage. Small, but free: drop the fields from `research_context` when the package is present, or exclude the current stage from the package's `stages` list.

**6. Pre-warm the chat cache while a project is open (optional).** A 1-hour entry dies if the next message comes 61 minutes later, and the next reply then rewrites the opening. A `max_tokens: 0`, non-streaming re-send of the next reply's prefix (opening, history including the finished turn, the same thinking and effort settings, a placeholder latest message) about 55 minutes after the last request started refreshes the opening for one cache read ($0.06 at 300,000 tokens) and writes the new turn at a few cents. It pays off whenever there is more than about a 5 percent chance (Sonnet) or 2.5 percent (Opus) that the user continues within the next hour. The trade is a paid request without a click, which the trust pages currently describe as not happening outside the listed automatic behaviours; it would need to be a visible, probably opt-in, behaviour. Chat has no structured output or batch, so none of the rejected combinations apply.

**7. Know about the 20-position lookback.** A search-heavy research round can produce an assistant turn with more than 19 positions (each `server_tool_use`, each search or fetch result, each progress note and text block counts; only runs of `tool_use` and of `tool_result` collapse). The next round's automatic breakpoint then fails to find the previous entry and rewrites the whole conversation even though nothing changed. Query 3's rewrite signature on short gaps (under 5 minutes) is how it would show up. If it does, there is no clean marker fix because the extra blocks are the model's; the mitigation is fewer server-tool uses per request, which is a behaviour change. Measure before worrying.

### 8.2 Quality trades; need the eval first

**8. Effort.** This is the largest lever by far and the only one that touches rigour. Facts: Sonnet 5.5's effort levels were recalibrated at launch and the published starting points are `medium` for multistep tool use and `low` for plain chat and search; Opus 5.5's default is `medium`, and Anthropic reports it beating Opus 5 at `high` on knowledge work. Atlas runs Sonnet `high` for jurisdiction, codes and Standard chat, and Opus `high` for the evidence check, the final report and Premium chat, one notch above each published starting point. Anthropic's measured research curves (on Fable 5.1, not Sonnet 5.5, so directional only) are nearly flat: `medium` matched the default's accuracy at 70 to 87 percent of the cost, and `low` gave up 1 to 3 points for a third to a half off. Your own 2026-09-29 note already lists the comparison cases and the scoring rubric. The minimal eval: 20 to 30 saved projects or chat questions, frozen; run each at `high` and `medium` in separate conversations (effort must not change inside one); score citation correctness, unsupported verified claims, required coverage and cost per completed stage or reply; keep the lower level only where the score holds. Nothing here changes caching: effort is already fixed per conversation and per reply.

**9. Chat opening size.** The 400,000-char excerpt allowance, the 240,000-char report and research previews, and the 120,000-char register are the dial behind worked example C. They were raised deliberately on 2026-09-30 for quality. Query 5 shows the real opening sizes and rounds per reply; if typical replies use many rounds on very large openings, a smaller opening with the existing on-demand tools would cut the per-round read cost proportionally, but the model would see less up front. Decide only with the numbers and the eval.

**10. `fetchContentTokens` versus the 120,000-char bound.** A single web fetch may return 60,000 tokens (about 240,000 chars) of text, which by itself exceeds the 120,000-char restart bound. So any large fetch forces a checkpoint restart and spends one of the four. Aligning the fetch cap with the bound (around 30,000 tokens) would avoid that, at the cost of less text from very long blocked pages. Fetched text is also saved to the register, so `read_saved_source` recovers the rest; still a trade.

### 8.3 Considered and not recommended

- Switching to the `_20260209` web tools: they add code-execution blocks, are not ZDR-eligible, and code execution is only free when paired with those tools; no saving, more complexity.
- Server-side compaction or context editing: both rewrite cached history and invalidate preserved thinking; Anthropic's own runs show context editing costing more than it saves.
- Lowering `max_tokens`: a backstop, not a lever; a truncated round is paid for and then redone.
- A cheaper model tier (Haiku) for any stage: a capability change, not an optimization, and the Opus stages exist precisely to check Sonnet's work.
- Server-side refusal fallbacks: already rejected in your 2026-09-30 note for sound billing and category reasons.
- Removing the `count_tokens` call: it is free and it is what keeps requests under the ceilings.

---

## 9. Measure it with the data you already have

Every request's usage is in `attempts.usage` (JSON) and `attempts.response` (JSON, includes `stop_reason` and the cache-miss diagnosis). The database is `data/atlas.sqlite` for a source install and `%LOCALAPPDATA%\AHJ Atlas\data\atlas.sqlite` for the installed app. Close the app or copy the file first (it uses WAL). These queries spend nothing. The Diagnostics download in **API & spending** has the same per-attempt usage if you prefer JSON.

Run them with any SQLite client, or with Node 24's built-in driver:

```
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.table(db.prepare(require('fs').readFileSync(process.argv[2],'utf8')).all())" "%LOCALAPPDATA%\AHJ Atlas\data\atlas.sqlite" query.sql
```

**Query 1. Per-request ledger**

```sql
SELECT project_id, stage_id, mode, model_key, created,
  json_extract(usage,'$.input_tokens')                           AS uncached,
  json_extract(usage,'$.cache_read_input_tokens')                AS cache_read,
  json_extract(usage,'$.cache_creation.ephemeral_5m_input_tokens') AS write_5m,
  json_extract(usage,'$.cache_creation.ephemeral_1h_input_tokens') AS write_1h,
  json_extract(usage,'$.output_tokens')                          AS output,
  json_extract(usage,'$.server_tool_use.web_search_requests')    AS searches,
  json_extract(response,'$.stop_reason')                         AS stop_reason,
  json_extract(response,'$.diagnostics.cache_miss_reason.type')  AS miss_reason,
  actual/1e6                                                     AS usd
FROM attempts WHERE state='settled'
ORDER BY project_id, stage_id, created;
```

**Query 2. Cache health by stage and mode.** Healthy agent loops read 80 percent or more of their input from cache; Anthropic's bar for a well-built loop is full price on under 1 percent of input.

```sql
SELECT stage_id, mode, model_key, COUNT(*) AS requests,
  SUM(json_extract(usage,'$.cache_read_input_tokens'))     AS reads,
  SUM(json_extract(usage,'$.cache_creation_input_tokens')) AS writes,
  SUM(json_extract(usage,'$.input_tokens'))                AS uncached,
  ROUND(100.0*SUM(json_extract(usage,'$.cache_read_input_tokens'))
    /NULLIF(SUM(json_extract(usage,'$.cache_read_input_tokens'))
           +SUM(json_extract(usage,'$.cache_creation_input_tokens'))
           +SUM(json_extract(usage,'$.input_tokens')),0),1)    AS read_pct,
  SUM(json_extract(usage,'$.output_tokens'))               AS output,
  SUM(actual)/1e6                                          AS usd
FROM attempts WHERE state='settled'
GROUP BY stage_id, mode, model_key ORDER BY usd DESC;
```

**Query 3. Suspected whole-conversation rewrites and the gap that preceded them.** A legitimate rewrite follows a `context.checkpoint` event; everything else is a cache miss. Gaps over 5 minutes in real-time mode point at item 1; short gaps point at item 7.

```sql
WITH r AS (
  SELECT id, project_id, stage_id, mode, created,
    json_extract(usage,'$.input_tokens')                u,
    json_extract(usage,'$.cache_read_input_tokens')     rd,
    json_extract(usage,'$.cache_creation_input_tokens') wr,
    LAG(created) OVER (PARTITION BY project_id, stage_id ORDER BY created, rowid) prev_created
  FROM attempts WHERE state='settled' AND stage_id!='chat')
SELECT project_id, stage_id, mode, created,
  ROUND((julianday(created)-julianday(prev_created))*1440,1) AS gap_minutes,
  u, rd, wr, ROUND(100.0*wr/NULLIF(u+rd+wr,0),0) AS write_pct
FROM r
WHERE prev_created IS NOT NULL AND wr >= 0.8*(u+rd+wr)
ORDER BY created;
```

**Query 4. Resets and exhausted resources, by reason**

```sql
SELECT json_extract(details,'$.reason') AS reason, COUNT(*) AS n
FROM diagnostics WHERE event='context.checkpoint' GROUP BY reason;

SELECT json_extract(details,'$.resource') AS resource, json_extract(details,'$.outcome') AS outcome, COUNT(*) AS n
FROM diagnostics WHERE event='resource.exhausted' GROUP BY 1,2 ORDER BY n DESC;
```

**Query 5. Chat: rounds per reply, opening size, and what the last round did.** `max_read` approximates the opening plus history; `first_write_1h` is the opening write when a reply rebuilt it; compare the last round's writes with its reads to test item 4.

```sql
WITH rounds AS (
  SELECT chat_turn_id, project_id, created,
    json_extract(usage,'$.cache_read_input_tokens')                 rd,
    json_extract(usage,'$.cache_creation.ephemeral_1h_input_tokens') w1h,
    json_extract(usage,'$.input_tokens')                            u,
    json_extract(usage,'$.output_tokens')                           o,
    json_extract(payload,'$.tool_choice.type')                      tool_choice,
    actual,
    ROW_NUMBER() OVER (PARTITION BY chat_turn_id ORDER BY created, rowid) rn,
    COUNT(*)     OVER (PARTITION BY chat_turn_id)                       n
  FROM attempts WHERE stage_id='chat' AND state='settled')
SELECT chat_turn_id, MIN(created) AS started, MAX(n) AS rounds,
  MAX(rd) AS max_read,
  MAX(CASE WHEN rn=1 THEN w1h END) AS first_write_1h,
  MAX(CASE WHEN rn=n THEN w1h END) AS last_write_1h,
  MAX(CASE WHEN rn=n THEN rd  END) AS last_read,
  MAX(CASE WHEN rn=n THEN tool_choice END) AS last_tool_choice,
  SUM(o) AS output, SUM(actual)/1e6 AS usd
FROM rounds GROUP BY chat_turn_id ORDER BY started;
```

**Query 6. Chat replies whose first round rewrote the opening while research had run in the previous hour (item 3)**

```sql
WITH first_round AS (
  SELECT chat_turn_id, project_id, MIN(created) AS created
  FROM attempts WHERE stage_id='chat' AND state='settled' GROUP BY chat_turn_id)
SELECT f.project_id, f.chat_turn_id, f.created,
  json_extract(a.usage,'$.cache_creation.ephemeral_1h_input_tokens') AS write_1h,
  json_extract(a.usage,'$.cache_read_input_tokens')                 AS cache_read,
  EXISTS(SELECT 1 FROM attempts r
         WHERE r.project_id=f.project_id AND r.stage_id!='chat'
           AND julianday(r.created) BETWEEN julianday(f.created)-1.0/24 AND julianday(f.created)) AS research_in_prior_hour
FROM first_round f
JOIN attempts a ON a.chat_turn_id=f.chat_turn_id AND a.created=f.created
ORDER BY f.created;
```

If a response includes `usage.output_tokens_details.thinking_tokens`, `json_extract(usage,'$.output_tokens_details.thinking_tokens')` separates thinking from visible output for item 8.

---

## 10. Suggested order

1. Run queries 1 to 6 on your real database (no cost). Read: cache read share per stage, rewrite rows and their gaps, chat rounds and opening sizes, how often chat ran during research, how often replies ended through the final path.
2. Settle the two TTL questions (items 1 and 2) from those numbers; each is a one-line config change plus trust-page wording.
3. Implement item 3 (opening digest) and item 5 (duplicate text); both are small and quality-neutral.
4. If query 5 confirms the final-request rewrite, decide on item 4.
5. Decide whether item 6 (pre-warm) fits the product's "nothing runs without you" posture.
6. Only then, run the effort eval (item 8). It is the one lever large enough to change the bill materially, and the one that must not be taken on faith.
