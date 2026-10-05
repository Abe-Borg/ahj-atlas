# Stable chat evidence cache

Project chat's opening evidence used to be rebuilt from live records for every message. Chat's web searches added discovery rows and refreshed existing URLs' `retrieved` timestamps in the register preview. Page reads and uploads also changed how the excerpt allowance was shared across sources. Each change rewrote bytes before the one-hour cache breakpoint, so a normal follow-up could pay to write the entire prefix again.

At 150,000 cached input tokens, a one-hour write costs about $0.60 on Sonnet 5.5 or $1.20 on Opus 5.5, against about $0.03 for a cache read. The TTL and rates are unchanged.

## Saved opening and source updates

`chatPayload` saves one opening per project in SQLite's new `chat_evidence` table. It contains the exact report/research/register preview and native `search_result` excerpt blocks, plus fingerprints of the source records. It survives app restarts, is shared across reply depths, and is deleted with its project. Existing projects build it on their first chat message after this update.

- **Stable between replies.** Chat searches, page reads, web fetches and document uploads do not rebuild this opening. Timestamp-only recaptures do not count as source changes. A metadata-only change, such as a search returning a different title, sends the updated register row without duplicating the retrieved excerpt.
- **Current sources still reach Claude.** New and changed source rows follow the earlier conversation's cache breakpoint, before the latest project context and user message. Newly retrieved or changed text follows as native citable excerpts under its saved source ID. Discovery-only rows have no citable blocks. Project lookups still provide the full current register and omitted text.
- **Research refreshes the opening.** A new non-chat research attempt or a change to the saved report, briefs or checkpoints rebuilds it. Attempt IDs distinguish research requests even if their timestamps and final report are identical. Chat charges, question responses and report notes stay outside this revision.
- **Large updates are folded in once.** When the serialized source-update tail exceeds 80,000 characters, the next reply rebuilds the opening from current evidence and resets the tail. That bound includes register metadata and citation-block overhead, and allows an ordinary 60,000-character page read. The opening retains its existing 400,000-character excerpt allowance and per-source selection.
- **Nothing changes mid-reply.** The snapshot is chosen once when the reply starts. Searches and reads during the reply append their normal results to the same payload. Opaque signed blocks, system instructions, tool definitions and the one-hour cache markers remain fixed within that reply.

## Native citations

Opening excerpts, source updates and lookup results all use the same `resultBlock` and `reference()` digest. `chatAnswer` already counts `search_result` blocks across user messages in order, including successful nested tool results, so tail citations use their position after the opening blocks. Validation compares the submitted excerpt and digest, rather than substituting newer source text or trusting a model-provided title. No citation-mapping or TTL change is needed.

## Confirming a live cache read

The tests make no paid API calls. To check a live account during your own normal chat use:

1. On a project with enough saved evidence to meet Anthropic's cache minimum, send a message that searches and reads a page. Let the reply finish.
2. Within an hour, send a short follow-up in the same project and reply depth, without running research between messages. Keep source additions below the 80,000-character tail threshold for this check.
3. Open **API & spending → Diagnostics**, select the project under **Show records for**, and choose **Download diagnostics**. In `projects[].attempts[]`, locate the first `stage: "chat"` request created for that follow-up and inspect its `usage.cache_read_input_tokens` (also retained under `response.usage`). It should include the large saved opening, rather than being zero while `cache_creation.ephemeral_1h_input_tokens` includes that whole opening again. Some new history, tool results and tail text can still incur cache writes or ordinary input charges; the read count need not equal the previous request's total input.
4. Compare that request with the first request of the preceding reply. A model change, cache expiry, research refresh or tail compaction can legitimately require a new write. `response.cacheDiagnostics` provides the provider's cache-miss reason when returned.

## Validation

Fake-provider tests drive a search with new URLs and a previously registered URL, then a 60,000-character page read that pushes retrieved text over the 400,000-character excerpt budget. The next payload's opening, excluding `cache_control`, deep-equals the first opening even though regenerating excerpts from the live register would change them. New page, discovery and upload rows appear after cached history, and native citations resolve both opening and tail excerpts.

Additional regressions cover timestamp-only and title-only recaptures, changed text on an existing source ID, persistence across a reopened store, isolation from another project, a large upload triggering one rebuild followed by reuse, a research request refreshing the snapshot even at an unchanged timestamp, and project deletion cleaning up the snapshot.

The trust page's fact snapshot and cache explanation also reflect the new tail bound.

On Node 24.19.0, `npm test` passes 304 of 305 tests. The only failure is the known Windows-only desktop path comparison on Linux (`tests/desktop.test.mjs:168`). `npm run check`, syntax checks of the changed modules, and `git diff --check` pass. No dependencies changed and no paid requests were made.
