# Haiku 5.5 Economy chat

AHJ Atlas offers **Economy — Claude Haiku 5.5, medium reasoning** in the project chat reply-depth selector. Standard remains the default Sonnet 5.5 option; Premium remains Opus 5.5. Research, the evidence check and final reports continue to use Sonnet and Opus.

Economy suits summaries and straightforward questions grounded in the project's saved evidence. It retains the same source lookups, web search, public-page readers, native citations and proposed-action cards as the other depths. Applying a proposed action follows the existing project validation and approval flow.

## Context and continuity

Economy initially includes up to 40,000 characters of report, 40,000 of research briefs/checkpoints, 20,000 of source register and 80,000 of retrieved-source excerpts. Recent conversation uses up to 60,000 characters. These are character budgets for opening context; the lookup tools can retrieve complete saved records and additional source passages. Source updates above 20,000 serialized characters refresh the opening between replies.

The project keeps one persisted evidence snapshot with its context profile recorded. Switching between Economy and Standard/Premium refreshes that opening before the next reply. Earlier completed replies carry forward as user/answer text. Signed thinking and tool transcripts from another model are not replayed. An in-flight request or paused tool continuation retains its original model, system, tools, messages and pricing; the app does not rewrite signed history or switch models mid-reply.

Economy has no forced 100,000-token cap. Source reads and conversation growth can take a request into Haiku's higher pricing tier. The normal model-context, request, lookup and web allowances still apply.

## Pricing

Embedded list prices were checked October 7, 2026. All token prices below are dollars per million tokens.

| Model / prompt size | Input | Output | Cache read | 1-hour cache write |
| --- | ---: | ---: | ---: | ---: |
| Haiku 5.5, up to 100,000 prompt tokens | 0.10 | 0.50 | 0.01 | 0.20 |
| Haiku 5.5, above 100,000 prompt tokens | 0.50 | 2.50 | 0.05 | 1.00 |
| Sonnet 5.5 | 2.00 | 10.00 | 0.10 | 4.00 |
| Opus 5.5 | 4.00 | 20.00 | 0.20 | 8.00 |

The Haiku tier counts uncached input plus cache reads and cache writes. Above the threshold, the higher input, output and caching rates apply to the whole prompt and its output. Native web tools can run several prompts within one API request. Complete returned iteration usage prices each prompt separately. If that breakdown is missing and cumulative usage makes the tier ambiguous, the app conservatively estimates the higher tier and labels the charge estimated in Activity. Reservations and interrupted-stream accounting also use conservative estimates. Newly submitted attempts save their pricing snapshot so later reconciliation uses the rates at submission. Existing recorded costs are not rewritten.

All chat runs in real time, including chat on a batch research project. Native web search stays $10 per 1,000 searches plus result tokens. Batch model tokens are half price when used by the research workflow; search fees are unchanged. Displayed costs are estimates; the Anthropic invoice remains authoritative.

## API compatibility

- Model: `claude-haiku-5-5`; adaptive thinking with medium effort.
- Thinking display: `omitted`; no progress-update beta for Haiku. The UI still streams answer text and shows the app's search/read/tool status messages.
- No manual `budget_tokens`, custom sampling controls or assistant prefill is added.
- Responses are read by block type, preserving native citations and hidden signed thinking for continuations.
- A Haiku decline offers **Try again with Standard**. Retrying requires a click and creates a new paid reply; no automatic provider fallback is enabled.

## Verification

Fake-provider and browser tests cover Economy selection, payload settings, context profiles, switching models, source/citation tools, refusal retry, both pricing tiers, cached-input thresholds, estimates and saved-request reconciliation. They do not make paid API calls or establish live account access or AHJ research accuracy.

For a live check, use a project with known saved official sources: ask for a short cited summary in Economy, ask a follow-up within an hour, inspect the supporting passages, and compare the recorded input/cache/output usage and request IDs with Anthropic Console. Compare harder jurisdiction and adoption questions with Standard before broadening Economy's role.

References: [Haiku overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview), [migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide), [pricing](https://platform.claude.com/docs/en/about-claude/pricing), [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking).
