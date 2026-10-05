# Complete research stages from the live conversation

The last research request previously discarded the conversation and wrote the stage brief from `save_progress`, earlier output and a bounded evidence package. That reconstruction could omit the decisive passages the model had actually read, as the MKE40 investigation demonstrated. It also created a new cache prefix for the brief used by the Opus evidence check and final report.

## Live wrap-up and reserved fallback

Jurisdiction, contacts/process and codes/standards now start wrap-up on request 11 of 12. The Opus evidence check does so on request 5 of 6. The request reuses the conversation's original model, system, tools, thinking settings, cache markers and earlier messages, including actual tool results and opaque signed blocks. A new `system` message after that history asks for `finish_research` alone, with coverage, source-linked findings, unresolved questions and any required NFPA checklist. A valid completion ends the stage immediately.

The request leaves tool choice automatic. Forced `finish_research` is unsupported on these models, and removing retrieval tools would invalidate the conversation. Claude may therefore call another tool or return text. A response that does not complete the stage queues the existing fresh-context, finish-only request in the final round. Exhausted text-only follow-ups, a rejected completion or a truncated wrap-up cannot consume an extra round or prevent this reserved fallback. If the fallback also fails, the existing partial-stage and retained-evidence behavior applies. Final report generation keeps its existing flow.

The engine and Chat share `inlineNotes`, `rejectsSystemRole` and `pendingServerTool` through `lib/conversation.mjs`. A model that rejects the mid-conversation system role at the free token count receives the wrap-up as a reminder after the existing tool results. Original result blocks and prior assistant blocks remain unchanged. A server tool waiting for client results, or a paused provider turn, first continues with the exact history and tool list and no harness note. That continuation uses the penultimate round; if it does not finish, the last round still uses the fresh fallback.

Fresh-context handling remains for the counted input threshold, exhausted checkpoint restarts, reduced search/read allocations, and fetched PDFs or large fetched text. If such a restart occurs during wrap-up, it goes directly to fresh-context completion. Original requests and responses remain in their attempt records.

## Search-limit documentation review

On October 5, 2026, the official [web search tool guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) describes `max_uses` as limiting searches per request and documents `max_uses_exceeded`. The [server tools guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools) shows `pause_turn` continuation with the same `max_uses` and requires preserving the tool list while server tools are pending.

Neither guide explicitly states that each HTTP continuation of the same server-side turn resets its search allowance, or whether earlier searches in the resumed turn count toward it. The per-request wording alone does not explain the MKE40 continued-request errors. The `deniedSearch` / `search_limit` checkpoint restart is therefore retained when searches remain; this change does not assume that restarting is unnecessary or that a conversation-wide cap is documented. No paid provider contract test was run. The renewal behavior across continuations remains unverified.

## Validation

Fake-provider regressions cover all four research stages, unchanged live prefixes and legacy model settings, decisive tool-only evidence, immediate completion, text and extra-tool responses falling back, rejected/truncated completion, exhausted follow-ups, the round ceiling, system-role rejection at token count, waiting and paused server tools, fresh input/allocation/fetched-content paths, and native batch completion.

On Node 24.19.0, `npm test` passes 335 of 336 tests, including all 21 new fake-provider regressions. The only failure is the known Windows-only desktop path comparison on Linux (`tests/desktop.test.mjs:168`). The suite needs local networking enabled for its localhost test servers. `npm run check`, syntax checks of the changed modules and test file, and `git diff --check` pass. No dependencies changed and no paid API calls were made.
