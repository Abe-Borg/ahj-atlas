# Final review keeps its lookups — October 12, 2026

The final reviewer could retrieve a decisive passage and then lose it immediately before writing the report. An outside review of the prompts reproduced it offline: a long source held "Exception: Privately owned data centers are excluded from this paragraph." The reviewer's saved-source lookup returned that exception, and it was in the third request and the conversation afterward, but not in the fourth, final request. That request had no lookup tools.

## Cause

The review gets four requests (`LIMITS.reviewRounds`). The fourth was always a completion-only request, and completion-only requests started a fresh conversation. The fresh request was rebuilt from the evidence package plus the review's checkpoint, and the checkpoint keeps only the first 2,400 characters of each of the last five lookups. A passage further into a lookup result, or outside the package's excerpt for that source, was gone.

## What changed

| Before | Now |
| --- | --- |
| The last review request discarded the conversation and rebuilt from saved evidence without tools. | It keeps the conversation, tools, system prompt and model unchanged, sets `tool_choice: {type: "none"}`, and appends a system note (`REVIEW_FINAL` in `lib/prompts.mjs`) saying lookups have ended. |
| A rebuilt review package held each lookup only as 2,400 characters of checkpoint text. | When the kept conversation would exceed the 300k input ceiling, the request is still rebuilt, but each passage the reviewer looked up in this run is pinned whole into its source's excerpt, ahead of the other passages, and its share of the allowance is funded first. |

**Why `tool_choice: none`.** Claude Opus 5.5 rejects the forced `any` and `tool` choices but accepts `none`, with adaptive thinking and with structured output. The history is only appended to, so the signed thinking blocks stay valid under preserved thinking. Changing `tool_choice` keeps the tools and system cache and rewrites the messages cache; the previous rebuild rewrote everything, so cost does not rise. If the model rejects the mid-conversation system message, the note moves into the last user turn as a reminder, as the research wrap-up already does.

**Pins.** `checkpointFromMessages` records, for the review stage only, each `read_saved_source` result's offsets and the first 80 characters of each passage (`checkpoint.pinned`, latest 40). `locatePins` finds the passage again in the current source text, by those opening characters when a later read grew the saved text at either end, and drops it when it cannot be found. `allocateEvidence` funds pinned passages first and lets them raise that source's cap; `selectPassages` selects them first and whole. Pins belong to one review run: a continuation or focused update clears them, as the review starts a new conversation and looks passages up again.

**Visibility.** The kept request records a `review.final_live` diagnostic and an Activity line. The request summary in diagnostics now includes `toolChoice`, and token counting sends `tool_choice` so the count matches the request.

## Validation

`node --test tests/evidence-recovery.test.mjs` adds the outside review's case in both paths: a 153,000-character source with the exception 5,000 characters into a lookup made in round one and outside the initial package. The kept path asserts the fourth request has the same tools and system prompt, extends the third request's messages unchanged, ends with the note, contains the exception, and produces the report. The rebuilt path forces the kept conversation over the input ceiling and asserts the rebuilt package carries the exception and that a later continuation clears the pins. A unit test covers pin recording, relocation after the saved text grows, whole selection and first funding.

Run against the previous code, the same scenario lost the exception from the final request in both paths. These tests use the fake provider; no paid requests are made, and they do not measure research quality.
