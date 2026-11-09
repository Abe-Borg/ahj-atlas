# Claude API updates review (November 2026)

This review checked the Claude API and SDK changes up to early November 2026 against AHJ Atlas. Most were already in place from the SDK 1.x work ([SDK 1.x, dynamic filtering and refusal fallback](sdk-1x-dynamic-filtering-and-refusal-fallback-2026-10-26.md)). Three small changes were made. The rest were considered and not adopted, for the reasons below.

## Changed

### 1. `@anthropic-ai/sdk` 1.3.0 to 1.6.0

The three minor releases add typed error classes and fields (`errorCode`, `details`, `apiMessage` on `APIError`, a class per HTTP status, `RampLimitExceededError`), error codes for ramp limits, and faster server-sent-event decoding ("decode server-sent events once per chunk"). The rest is Admin API surface the app does not use. Neither the API version (`2026-10-21`) nor the SDK's dependencies changed.

`lib/provider.mjs` depends on `messages.stream`, `stream.on('streamEvent')`, `finalMessage()`, `stream.request_id`, and the error's `status`, `error`, `headers`, `requestID` and `type`. All are unchanged in 1.6.0. The lockfile changes only the SDK's own entry.

### 2. Clearer reasons for 409, 413 and ramp-limit 429 responses

`providerError` (`lib/provider.mjs`) now names three responses that used to read only "Anthropic rejected the request." or "Anthropic rate limits were reached.":

| Response | Message | Retried |
| --- | --- | --- |
| 409 `conflict_error` (new in the API's error list) | The request conflicted with the current state of an Anthropic resource. | No (unchanged) |
| 413 `request_too_large` | The request was larger than Anthropic accepts. | No (unchanged) |
| 429 with `error_code: ramp_limit_exceeded` (usage grew faster than Anthropic allows) | Anthropic is limiting how quickly this account’s usage can grow. | Yes, after `retry-after` (unchanged) |

A batch result carries only the error type, so `conflict_error` and `request_too_large` also map to their statuses. A 413 comes from Anthropic's edge before the API, so its body can be HTML. The status alone produces the message, on both the streaming and REST paths.

### 3. Request size wording

The Messages and token-counting endpoints now accept requests up to 128 MB (batches 256 MB, Files 500 MB). The README and the `CHAT_LIMITS` comment said 32 MB. Chat's 20 MB cap on resent image data stays, because it limits how much earlier image data each request resends. It was never set by the API limit.

## Already in place

| Item | Status in AHJ Atlas |
| --- | --- |
| `temperature`, `top_p`, `top_k` removed (API version `2026-10-21`; Python SDK 1.x) | No request sends them. The app is JavaScript, and the Python notes do not apply. |
| API version `2026-10-21` | Every request sends it. |
| Server-side refusal fallback | `fallbacks: "default"` on real-time Sonnet 5.5 and Opus 5.5 requests. |
| Files API and Skills out of beta | Neither is used. |
| Minimum cacheable prompt 512 tokens on 5.x models | No app logic depends on the minimum. Shorter prefixes now cache with no change. |
| Change effort per message, not mid-conversation | Effort is fixed per research stage and per chat depth. It never changes inside a conversation. |
| 401 whose message mentions CORS | Requests come from the local Node server, never from a browser, so they carry no `Origin` header. |
| Tool search pays off above ~10K tokens of tool definitions | Chat's tools are about 2,300 tokens. |
| Least privilege, approval before risky actions, spending caps | Chat proposals wait for **Apply**. The model has no command runner, filesystem or key-reading tool. Every request reserves its estimated cost first. |
| Embedded prices | They match the live pricing page on 2026-11-09, including Sonnet 5.5 cache reads at $0.10 and Opus 5.5 at $0.20 per million tokens. |

## Considered, not adopted

- **Message threads (beta `message-threads-2026-08-12`).** The server keeps the conversation, so each request sends only new messages. Pricing is the same; the gain is lower, steadier time to first token in long loops. Research rounds and chat's tool loop could use threads, but:
  - Message Batches don't support threads, so batch-mode research could not.
  - Token counting doesn't support threads either. The app would keep counting the full conversation, as it does now.
  - Some requests change fields a thread must keep fixed, so each starts a new thread with the full conversation:
    - the final-answer request (`tool_choice: none`);
    - a checkpoint restart;
    - a turn that fell back to another model (the API does not store it).
  - Threads are not eligible for zero data retention. Dynamic filtering already isn't.

  Adopt threads only after measuring time to first token with and without them (the `--ab` pattern in `scripts/live-check.mjs`).
- **On-demand compaction (`compact-2026-09-04`).** Research already restarts from its own checkpoints, which pin the reviewer's lookups and evidence. Server compaction would replace that mechanism and cannot be combined with threads.
- **Fast mode on Opus 5.5** (generally available, $8 / $40 per million tokens, twice the standard price, up to 2.5 times the output speed). Premium chat, the evidence check and the final review could finish sooner. It doubles their token cost, so it is a product decision. If adopted, it would be an explicit choice the user makes, not a default.
- **Cache pre-warming** (`max_tokens: 0`) when chat opens. Nothing the app does costs money until the user acts. A pre-warm charges the cache write even when no message follows.
- **Task budgets (beta).** Research and chat already pace themselves with round, lookup and time allowances, and they warn the model as each runs low.

One existing trade-off is related: chat's final-answer request sets `tool_choice: none`, which keeps the tools and system cache but rewrites the messages cache. It happens only when a reply reaches its lookup allowances, and it is the same trade-off [the final review](final-review-keeps-lookups-2026-10-12.md) makes.

## Verification

- `tests/provider.test.mjs` covers the new mappings: a type-only 409 batch result, a 413 with an HTML body on the streaming and REST paths, and a ramp-limit 429 that keeps its `retry-after` and stays retryable.
- On SDK 1.6.0 the full suite passes, apart from the one stream-deadline test that needs the pinned Node 24. This session had Node 22, and that test was cancelled the same way on 1.3.0. Run `npm test` on Node 24 before releasing.
- The paid live check (`npm run live-check -- --yes`) has not been run with 1.6.0. It needs an API key.
