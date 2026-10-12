# Question routing and matching — October 12, 2026

Two findings from an outside review of the prompts and evidence handling. Both concerned questions disappearing or going unexamined without anyone resolving them.

## Saved answers wait for a full round before a focused update

**Before.** A focused NFPA or standards update refused a simultaneous clarification or location change, but not saved answers. It still took the answers into its research context, which cleared the "saved answers not yet used" state, while jurisdiction and contacts stayed complete with their earlier findings. In the reviewer's reproduction, an answer saying the parcel was outside city limits and governed by different county and fire authorities was folded into a focused NFPA update. The stage meant to resolve it never ran.

**Now.** While any saved answer or dismissal has not been used in research (`questionUpdatesPending`):

- `engine.resume` refuses a focused update with a message pointing to **Research with saved answers**, which reopens every stage. Nothing changes and the answers stay pending.
- Chat cannot propose the focused update. The proposal returns an error telling the model to point the user to **Research with saved answers**. An already-recorded card is still refused when applied, because apply goes through `engine.resume`.
- The **Research NFPA standards** (or referenced standards) button on Codes & standards is replaced by a note saying the same thing.

Once a full round has used the answers, the focused update is available again. The trade-off is that an answer that only concerns NFPA editions also needs the full round.

## A resolved question covers a finding by its own text, never by an answer

**Before.** `resolvedQuestionText` returned a resolved question's text plus, for an answered one, its answer. Four checks matched names and standard designations against that text to decide whether a generated follow-up was already covered:

- unverified jurisdiction and code rows in `validateReport` (`lib/prompts.mjs`);
- NFPA and referenced-standards confirm questions;
- standards a research checklist found but the report omitted (both in `lib/screening.mjs`).

So an answer merely mentioning a standard removed its edition question. In the reviewer's case, "Wet-pipe sprinklers designed to NFPA 13 are proposed. The adopted edition is unknown" removed the NFPA 13 adopted-edition question, while the standard itself correctly stayed unverified. The same rule let "Example District is the jurisdiction", given in reply to "Which authority governs this site?", remove the governing-jurisdiction question.

**Now.** `resolvedQuestionText` returns only the question's own text. A follow-up is covered when:

- the same question was answered, dismissed or closed (matched by question ID, unchanged); or
- a resolved question whose own wording names the finding exists, for example "Which edition of NFPA 13 applies?"

An answer is user-provided context: research still receives it, and answers still add screening targets. It no longer resolves a different question.

**Deliberate behavior change.** This reverses part of the October 1 change that recorded closure reasons. That change let an answer naming a standard and edition (for example "The project uses NFPA 13, 2019 edition", given to a scope question) keep the NFPA 13 confirm question from returning. An answer cannot distinguish "2019 per the AHJ letter" from "edition unknown" or "does not apply" without interpretation the validator should not make. The confirm question now returns once. Answering or dismissing that question settles it by its ID from then on.

## Validation

All seven tests below fail on the previous code.

- **New, item 5.** `tests/questions.test.mjs` refuses a focused update while an answer is pending. It leaves stages and the pending flag unchanged, lets **Research with saved answers** reopen every stage, and accepts the focused update afterward. `tests/chat-actions.test.mjs` refuses the chat proposal with the same guidance.
- **Rewritten, item 6.** In `tests/fire-protection.test.mjs`, `tests/discipline-screening.test.mjs` and `tests/questions.test.mjs`, an answer naming NFPA 13, ASHRAE 62.1, CSA C282 or the jurisdiction leaves the follow-up open. A resolved question naming it, or a dismissal or answer of the question itself, still covers it.

These are deterministic tests; no paid requests are made. The Codes & standards note is browser UI and is exercised by CI's UI checks, not by a dedicated assertion.
