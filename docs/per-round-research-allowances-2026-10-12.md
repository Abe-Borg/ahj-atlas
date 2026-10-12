# Per-round research allowances — October 12, 2026

A later research round could have nothing left to retrieve. The 80-search and 100-read project allowances, and the Opus evidence check's own 15 searches and 20 reads, were counted across the project's lifetime. After one complete run, a continuation with a corrected address, a clarification or saved answers reopened the stages and dispatched paid requests, but the search and fetch tools were omitted and source reads were refused. The verification assignment still told the model it had "15 searches and 20 source reads for this stage". An outside review of the prompts reproduced both cases offline; this change follows it.

## What changed

| Before | Now |
| --- | --- |
| Searches and reads counted across the project's lifetime. | They count within the current **research round**. A round starts with the project and again at a continuation that adds context or saved answers, corrects the address, country or site description, or runs a focused NFPA or standards update. A plain continuation and a partial report keep the current round. |
| The evidence check's 15 searches and 20 reads summed every attempt the stage ever made. | They sum the stage's attempts in the current round. |
| The verification assignment stated the fixed stage allowance. | It states what remains: "N of its 15 searches and M of its 20 source reads remain in this research round." The project line now reads "remain in this research round" instead of "across the project". |
| The Continue research and NFPA dialogs showed only the estimated cost. | They also show the searches and reads left in the current round, and whether the action starts a new round. |

Each request records its round in `attempts.research_round`; `projects.research_round` is the current one. `store.project` returns `roundSearches` and `roundReads` beside the lifetime `searches` and `reads`, which stay in Activity's spending record and the diagnostics report. `remainingSearches`, `remainingReads`, the reserve-time search check, the read refusals and the diagnostic pools all read the round values. Activity records "A new research round started with a fresh search and read allowance." when a continuation starts one, and the `project.resumed` diagnostic carries `researchRound` and `newRound`.

## What did not change

- The ceilings themselves: 80 searches, 100 reads, 4 searches and 3 fetches per request, 15 and 20 for the evidence check. They remain runaway guards for one round, not spending limits.
- Chat's per-reply allowance, which never counted toward research.
- Signed conversations in flight. A round starts only through `engine.resume`, which refuses while a request is outstanding, and allowances already shrink or grow only at a fresh conversation segment.
- Existing databases: the migration adds the two columns with a default of 0, so every earlier request belongs to round 0 and the project's usage reads exactly as before until its next context-changing continuation.

## Validation

`node --test tests/resource-exhaustion.test.mjs` covers a spent first round, a plain continuation that keeps it, a clarification that starts the next one with the tools restored and the verification assignment stating the restored allowance, and the partial-report, location and focused-NFPA paths. `tests/core.test.mjs`, `tests/address-correction.test.mjs` and `tests/fire-protection.test.mjs` assert the round on their continuation paths. These use the fake provider; no paid requests are made, and they do not measure research quality.
