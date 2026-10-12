# Ask Atlas cards change only what they name — October 12, 2026

An outside review of the prompts found that unanswered questions could disappear from the active follow-up list. One mechanism was the Ask Atlas auto-dismissal; this change removes it. The other mechanism, matching a resolved answer's body, was fixed separately; see `question-routing-and-matching-2026-10-12.md`.

## Before

A reply started with **Ask Atlas** is about one saved question. When the user applied a free card from that reply that did not touch the question, `applyAction` also dismissed the asked question. Such a card could be a report note or an answer to a different question. The dismissal carried the reason "Resolved with Ask Atlas: you applied its proposal to …".

In the reviewer's reproduction, the user asked which NFPA 13 edition was adopted. They saved a note saying the edition remained unknown and required written confirmation, and the question became dismissed. The interface disclosed the dismissal, so nothing was hidden, but the meaning was wrong. Saving an unresolved finding does not resolve its question.

## Now

- **A card changes only what it names.** Only an answer or dismissal card for the asked question resolves it. A note, an answer to another question, a research round and a location correction all leave it open. `dismissesAskedQuestion` and the `askedQuestionId` argument to `applyAction` are removed.
- **Chat is told the rule.** The system prompt now says that a note or an answer to a different question leaves a saved question open. When a reply settles a saved question, chat should propose an answer or dismissal for that question itself, and it should not propose a dismissal while the question is unresolved.
- **The card says so.** While the asked question is open, a card from the Ask Atlas reply that does not touch it reads "This leaves the question you asked Atlas about open. Answer or dismiss it on its card when it is settled." This replaces "Applying also dismisses the question you asked Atlas about." The confirmation toast no longer adds a dismissal sentence.
- **Earlier dismissals are left alone.** Questions already dismissed this way keep their "Resolved with Ask Atlas: …" reason and can be reopened on Overview. They were the user's applied decisions under the earlier rule, so they are not changed automatically.

## Validation

- **Server tests.** `tests/ask-atlas.test.mjs` covers the reviewer's case: a note leaves the asked question open, with no reason and no dismissal event. It also checks that an answer to another question leaves the asked one open, and that a dismissal card for the asked question still dismisses it with its own reason.
- **Browser test.** `tests/chat-ui.mjs` covers the card wording, the plain toast, and the question staying open on Overview.
- **Both fail on the previous code.** All seven browser UI suites pass. They ran in the cloud container with a Chromium wrapper that adds `--no-sandbox`, which the container needs as root. No paid requests are made.
