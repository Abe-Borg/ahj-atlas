# Bound fetched documents in research and project chat

Anthropic's `web_fetch_20250910` applies `max_content_tokens` to text, not binary PDFs. A fetched PDF comes back as a complete base64 document block. Previously research replayed that block until its 200,000-token checkpoint, and project chat could replay it throughout its 20 requests with one-hour cache writes. Source capture already extracts fetched PDFs into the source register, so later requests can use saved text instead.

## Research

Before counting or dispatching the next request, inspect the assistant turns in the current conversation. Any successful fetched base64 PDF triggers the existing `freshContext` path. Fetched text totaling at least 120,000 characters in the current conversation triggers it too. Small text fetches continue with their exact original prefix.

The checkpoint keeps fetched source IDs, progress notes, saved claims and questions. The fresh request includes bounded source excerpts, and `read_saved_source` accepts the fetched URL for further passages. Detection uses the returned document block, independently of PDF extraction: a scanned or malformed PDF still triggers the restart. Real-time research, native batches and the Opus evidence check share this path.

This is a new conversation, not an edited continuation of the old one. Earlier messages, opaque thinking/signatures, the system prompt and tools in the original attempt remain unchanged. The raw PDF stays in its original response record, but is absent from subsequent request payloads and token-count requests. The restart uses the existing four-restart allowance; exceeding it reserves the next request for completion, and no extra rounds are added.

Activity describes continuing from saved findings after saving a fetched PDF or large fetched text. Diagnostics record `context.checkpoint` with reason `fetched_content`, plus `resource.exhausted` with outcome `degraded`: `fetched_pdfs` (zero raw PDFs retained across a restart) or `fetched_history_characters` (120,000-character limit).

## Chat policy

Chat cannot remove the PDF while continuing the same signed conversation. Any fetched PDF therefore ends lookups, regardless of its reported token count. Fetched text totaling 120,000 characters within the reply does the same. The next eligible request appends the existing final-answer instruction and sets `tool_choice: none`. The exact previous messages, system prompt and tool definitions are preserved, including the PDF. If the fetching response already finishes the answer, no extra request is made.

A paused or pending server-tool turn requires an unchanged continuation before a final-answer instruction can be appended. Allow at most one such continuation after the fetched-content bound is reached. If the provider still needs another continuation, stop with **Limit reached**, retain saved sources and explain that the user can follow up. Otherwise the next eligible request answers with tools off. Activity records both the bound and a stop for a repeatedly pending turn.

**Why this policy.** A token threshold alone would leave small PDFs replaying through many requests and would depend on the provider's accounting for binary content. Detecting any PDF bounds replay directly. Ordinary fetched text stays useful across requests until its cumulative volume warrants a bound. 120,000 characters is roughly 30,000 tokens for typical English text, but this is a character guard, not a tokenizer estimate or billing ceiling. Keeping three fetch uses per request preserves fallback reading for ordinary pages; reducing that to one would not bound later replay of an already fetched PDF.

Normally the PDF appears as input only in the final-answer request after fetching. A mandatory pending continuation may add one more pass. This does not cap the initial PDF size, server-tool iterations within a request, or the provider's charges. It bounds application-level replay. Later chat replies start from saved text and the stored answer, without the old binary or thinking blocks.

## Validation

Fake-provider regression tests use real synthetic PDFs encoded in `web_fetch_tool_result` blocks, with no paid API requests:

- Research: fresh payloads and token counts without binary/signature replay; preserved original attempt records; extracted text and URL lookups; real-time, batch and evidence-check paths; malformed PDFs; restart allowance; and the exact cumulative text boundary.
- Chat: final-answer request with the original prefix/system/tools intact; citable PDF text lookup; a later reply without the binary; one unchanged pending continuation, including tool-results-only turns; repeated pauses stopping; and small text fetches continuing until the cumulative boundary.

On Node 24.19.0, `npm test` ran 315 tests: 314 passed. The only failure is the existing Windows-only desktop path test (`tests/desktop.test.mjs`, "production paths preserve the existing local DPAPI directory and isolate development"), which compares Windows and host-native separators on Linux and was explicitly allowed to be ignored. `npm run check` and `git diff --check` passed. The changed library modules also passed `node --check`.

No dependencies changed. The fetch tool's text cap remains 60,000 tokens and its per-request fetch allowance remains three.
