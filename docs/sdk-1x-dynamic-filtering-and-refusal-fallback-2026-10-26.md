# Anthropic SDK 1.x, dynamic-filtering web tools and refusal fallback

Three API-level changes that earlier reviews left for a human decision were made together:

1. `@anthropic-ai/sdk` moved from 0.128.0 to 1.3.0, and every request now uses API version `2026-10-21`.
2. Research and project chat use the dynamic-filtering web tools, `web_search_20260209` and `web_fetch_20260209`.
3. Real-time requests on Sonnet 5.5 and Opus 5.5 opt into server-side refusal fallback (`fallbacks: "default"`).

The unit and browser tests cover each change against the shapes Anthropic documents. **Before releasing, run the live check** (`npm run live-check -- --yes`, below). It is the only way to confirm that the API accepts the app's exact request shapes. Unit tests cannot spend money; the live check does, a few cents.

## 1. SDK 1.3.0 and API version 2026-10-21

**What changed.**

- `package.json` pins `@anthropic-ai/sdk` 1.3.0. The lockfile adds its new dependency, `@opentelemetry/api`. The SDK is now Apache-2.0 licensed; earlier versions were MIT.
- SDK 1.x sends `anthropic-version: 2026-10-21` on streamed messages. The app's own requests (token counts, batches, batch polling and results, the model list) now send the same version (`API_VERSION` in `lib/provider.mjs`), so every request and every new batch result reads one version. Batches created before the upgrade still finish under the version they were created with.
- SDK 1.x sends the key as `Authorization: Bearer`. The app's own requests still send `x-api-key`; the API accepts either. The base URL is fixed at `https://api.anthropic.com`, so no proxy reads the header.
- The streaming client sets `openTelemetry: false`. SDK 1.x traces requests when a global OpenTelemetry tracer is registered. None is, and request bodies carry project evidence, which diagnostics never record.

**Breaking changes checked.** The 2026-10-21 version rejects `temperature`, `top_p` and `top_k` (the app sends none), `document` blocks directly in an `assistant` message (the app sends none; web fetch results nest their documents, which stays valid), and `text` blocks with `citations` in a `user` message. Chat's citable `search_result` blocks carry only the `citations: {enabled: true}` setting, which stays valid. Prior replies go back as plain text. The Admin API is not used. Of the SDK's own breaking changes, only bearer authentication applies. The others are message-type unions, removed Text Completions, the tool runner's compaction, `betas` on the models methods and one credential per client. The app is JavaScript, calls `messages.stream` directly and passes a single key.

**Stream handling.** `lib/provider.mjs` depends on `stream.on('streamEvent')`, `finalMessage()`, `request_id` and the error's `status`, `error`, `headers` and `requestID`. Between 0.128.0 and 1.3.0 these are unchanged. `MessageStream` now ignores events that arrive before `message_start` (0.128.0 threw) and passes unknown event types through. The app already counts a stream as started only at `message_start` and complete only at `message_stop`, so cost accounting is unchanged. `message_delta`'s `usage.iterations` still comes from the app's own accumulation of raw usage, which the SDK snapshot does not keep.

## 2. Dynamic-filtering web tools

**What changed.** `searchTool` and `fetchTool` (`lib/research-tools.mjs`) return `web_search_20260209` and `web_fetch_20260209` with `allowed_callers: ["code_execution_20260120"]`, the default for these versions, set explicitly. Claude calls them from code execution, which the API provisions for the request without a separate code execution tool, so only what that code keeps reaches the model's context. Code execution used this way adds no charge beyond its tokens.

**Response shapes.** A filtered call returns a `server_tool_use` block named `code_execution` and a `code_execution_tool_result` block. Each search or fetch that code makes still comes back as its own `server_tool_use` and `web_search_tool_result` or `web_fetch_tool_result` pair, at the top level of `content`, with a `caller` field naming the code execution call. The existing source capture, fetch capture, fetched-PDF replay bound, search-error checks and checkpoints read those blocks by type, so they handle both direct and code-made calls. `pendingServerTool` treats an unanswered `code_execution` call like any server tool, so the next request carries only tool results.

**Saved conversations.** Tools cannot change within a conversation. A research stage saved with the earlier, basic web tools continues from its checkpoint instead (`webToolsChanged`; Activity: "the web search and fetch tools were updated"). This happens once per open stage, the first time it runs after the upgrade. Chat history is plain text, so the next reply only rebuilds its prompt cache once.

**Chat steps.** While a reply runs, chat shows **Filtering web results…** for the code execution call and **Reviewing the filtered web results…** for its result.

**Trade-offs.** Dynamic filtering is not eligible for zero data retention. Before it, the basic tools called directly were eligible. The `_20260318` versions add `response_inclusion` to drop the code-made result blocks from responses. They are not used: the app needs those blocks to register search results as leads and fetched pages as sources.

## 3. Server-side refusal fallback

**What changed.** `withFallbacks` (`lib/provider.mjs`) adds `fallbacks: "default"` to Sonnet 5.5 and Opus 5.5 requests. Research, the evidence check and the final review add it only in real-time mode, because Message Batches reject the parameter. Every chat request is real time and adds it. Requests that carry it send the `server-side-fallback-2026-07-01` beta header beside the progress-updates header. Token counts never carry it.

**What it covers.** Default routing re-runs a declined request in the same call on the model Anthropic recommends for that refusal category. On Sonnet 5.5 that covers `cyber` and `frontier_llm` declines, which go to Sonnet 5. It does not cover `bio`, `reasoning_extraction` or `general_harms`. On Opus 5.5 the permitted targets are Opus 5 and Opus 4.8, and `reasoning_extraction` has no fallback. A request the whole chain declines still ends with `stop_reason: "refusal"`. Chat then shows **Declined by Claude** with **Try again with Premium/Standard**, as before. For about an hour, sticky routing sends later requests in the same conversation straight to the fallback model.

**History.** A turn that fell back is sent back as the API documents (`echoContent` in `lib/conversation.mjs`). The `fallback` block stays where it was. Thinking, connector text, client tool calls and unanswered server tool calls before the last `fallback` block are dropped, since the model that continued never saw them. Only tool calls after the handoff run. Text the fallback model continued is joined without a separator, so a report's JSON split at the handoff still parses.

**Pricing.** `usage.iterations` records each attempt at its own model. The top-level counts describe only the attempt that returned the message. `costMicros` prices each declined attempt from its iteration, a fallback model that declined in turn included, and the serving attempt from the top-level counts, each at its own model's list rate. The rates come from `MODELS` or the fallback-candidate table in `lib/config.mjs`. Where the record is incomplete, the estimate is conservative:

- A decline before any output is always counted. Anthropic bills it only in some refusal categories, and the response does not name the declined attempt's category.
- Unitemized cache writes in a declined attempt are priced as one-hour writes.
- A model without a listed rate gets the highest listed rate.
- Searches that ran before the decline count once.

Every request that fell back is marked estimated. A stream that fails after a fallback is estimated at the higher of the two models' rates (`servedBy` on the error). Reservations still use the requested model's rates.

**Visibility.** Research Activity records the fallback ("Jurisdiction: Claude Sonnet 5 answered through server-side fallback, because Anthropic's safeguards declined this conversation on Claude Sonnet 5.5. Its cost is estimated at each model's rates."). A completed chat reply says which model answered. While it streams, the step reads "Anthropic's safeguards declined this request; continuing on …". Diagnostics record `request.fallback` or `chat.fallback`, the requested and serving models, `fallbacks` in the request summary, and the response's `model`.

## Live check

`scripts/live-check.mjs` (`npm run live-check`) sends small real requests through the app's own provider and request builders. Without `--yes` it only describes them. A run costs about $0.05 to $0.40.

- **Model list and capabilities** on 2026-10-21. It prints each model's `allowed_fallback_models`.
- **Error paths, free.** An invalid key must map to HTTP 401, and an unknown model to a clean rejection before generation.
- **Research request.** A research request built exactly as the app builds it, from a synthetic project in a temporary folder: Sonnet 5.5, `thinking.display: "updates"`, strict client tools, both dynamic-filtering web tools and `fallbacks: "default"`. It must be accepted.
- **Web search.** A small search request must run a search and return result URLs that source capture registers. It reports whether the calls came from code.
- **Structured output.** A small structured-output request on Opus 5.5 with fallbacks must return valid JSON.
- **`--batch`** also submits a one-request batch without fallbacks and waits up to 30 minutes for its result.
- **`--ab`** answers one AHJ question with the basic and with the dynamic-filtering web tools, and prints their tokens, searches, cost and answers side by side. This is a single-question comparison, not a substitute for comparing whole projects.

Run in this session with an invalid key, the script reached the API, and every check stopped at authentication. That confirms SDK 1.3.0's bearer-authenticated requests on 2026-10-21 reach Anthropic, and that a 401 maps to the app's message with a request ID. The paid checks have not been run.

## Verification

- `tests/fallback.test.mjs`: per-model fallback pricing (the documented example, unitemized writes, an unlisted model, sticky routing, searches before a decline, batch arithmetic); stream-failure estimates after a fallback; history echo and text joining; the beta headers on generation versus token counts; `servedBy` on a stream that fails after the handoff.
- `tests/evidence-recovery.test.mjs`:
  - A stage that falls back mid-turn runs only the call after the handoff, saves the documented echo, records the event and the per-model cost, and is marked estimated.
  - Batch requests carry no `fallbacks`.
  - Searches and fetches made by dynamic filtering join the register.
  - A conversation saved with the basic web tools restarts from its checkpoint.
- `tests/chat.test.mjs`:
  - A reply that falls back keeps its partial answer, answers only the lookup after the handoff and names the model that answered.
  - Dynamic filtering shows its steps and registers the code-made results.
  - The pinned tool definitions are updated.
- `tests/provider.test.mjs`: every request sends API version 2026-10-21 and the key. `tests/trust.test.mjs` pins the token-count timeout to its new source line.
- The full suite passes, apart from one test that needs the pinned Node 24 (this session ran Node 22). The browser UI tests pass, and so do the desktop tests.
