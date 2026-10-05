# Settle interrupted research streams automatically

A real-time response that ended after `message_start` previously discarded its partial usage and became an `unknown` attempt. The project stayed in attention until the user checked Anthropic Console and entered a charge. That protected the former spending limits; with costs now displayed as estimates, it unnecessarily stopped research after a dropped connection, stream deadline or SDK error.

## Partial usage and estimated cost

`Anthropic.messageOnce` now attaches `partialUsage` and `streamedCharacters` to errors after generation starts. It keeps input, cache and search counters from `message_start` and subsequent usage events. The character count includes generated text, thinking updates and tool JSON, excluding opaque signatures and retrieved server-tool results. Failed draft content is not attached to the error or applied as research/tool output.

Research and chat use the same cost calculation. Output is estimated at one token per four received characters, rounded up, and never below a reported output-token count. The existing calculator prices this output together with partial input, cache writes/reads and searches, preserving its cache-breakdown arithmetic. If input or output information is unusable, including a stream that starts but sends no output or positive output count, the original reservation becomes the recorded estimate instead.

The estimate is recorded in the existing integer-microdollar ledger with a charge timestamp, releasing pending cost and search reservations. Attempts remain `errored` so they count toward the existing retry bound, with a new `estimated` flag. Existing attempts migrate with that flag off. Activity marks the request and its warning line as estimated; its usage summary identifies interrupted estimates. Diagnostics retain the flag, partial usage and character count without retaining failed draft content.

These figures are display estimates. Thinking updates do not include all hidden thinking; generation and server tools may continue after a connection drops. Partial input/search counters and received output can therefore understate the final invoice. The reservation fallback is also an estimate, not a billing ceiling. Anthropic's invoice remains authoritative.

## Retry and chat behavior

Started-stream failures requeue research through the existing `errored` / `tries <= 2` path. Backoff starts at 30 seconds, then 60 seconds, honoring a longer provider retry delay when supplied. The third recorded error blocks the stage in attention. The count includes earlier errored attempts for that stage, as before; retries remain subject to the stage's request cap and the project's active-time allowance. Failed started streams add their elapsed request time to the latest project total before a retry is queued, preserving time accumulated by parallel stages. Retry backoff does not count as active time, and completed requests are not counted again on the failure path. The allowance is checked before the next dispatch, so an in-flight request can exceed 45 minutes; the final report retains its existing exception. Saved conversation and evidence are reused; incomplete output and tool calls are not executed.

Chat records the same estimate and ends the turn as failed with a clear cost note and an instruction to send a new message. Its live draft is cleared. It does not automatically retry, and research status remains independent of the reply.

## Pre-start uncertainty and batches

Failures before `message_start` retain today's distinction: confirmed provider rejections follow their existing error handling, while ambiguous transport/submission failures keep their reservation and require manual charge reconciliation. Without a start event there is no usage evidence or confirmation that Anthropic accepted the request. Keeping this path avoids automatically replacing a request whose execution is wholly unknown; removal of spending limits does not establish its outcome.

Batch submission, polling, result application, restart recovery and manual reconciliation are unchanged. Already-saved unknown attempts are not automatically converted or resubmitted by this update. No dependencies changed.

## Validation

Fake-stream tests cover partial input/cache/search billing, delayed retry admission and successful recovery, third-failure blocking, pre-start transport/empty-stream uncertainty, reservation fallback, partial output counters, thinking/tool-JSON character counts, an actual synthetic body-stream error, both chat models and unchanged batch ambiguity. A store regression checks migration defaults and persistence of the estimate marker. A fake-clock regression simulates two 30-minute failed streams and confirms the active-time limit prevents a third research request; retry waits are excluded and a successful retry contributes its duration once. The real short-deadline regression also checks elapsed time in the project counter. The provider deadline test checks that a started timeout retains partial usage and becomes retryable without an SDK retry. These tests make no paid API calls.

On Node 24.19.0, `npm test` passes 350 of 351 tests, including all 15 new fake-stream/migration cases and the updated started-deadline regression. The only failure is the known Windows-only desktop path comparison on Linux (`tests/desktop.test.mjs:168`). The suite runs with local networking enabled for its localhost servers. `npm run check`, syntax checks of changed modules and tests, and `git diff --check` pass. No dependencies changed and no paid requests were made.
