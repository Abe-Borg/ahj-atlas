# Project chat: actions you approve

Before this change, project chat was read-only. When it found an answer to a saved question, or saw that the report needed another round, the user had to copy its advice into a question card or the **Continue research** dialog. Chat can now propose four kinds of change, shown as cards with an **Apply** button:

- answering a saved question
- dismissing a saved question
- starting a research round, with a clarification or as a focused NFPA update
- correcting the address or site description

Apply calls the same functions as the existing controls, `store.saveQuestion` and `engine.resume`. Chat still never changes the project on its own.

## Tools

Three strict client tools join the chat tool list, after the public-source tools and before native web search. Every property is required, with no optional parameters. Strict schemas reject `minLength`/`maxLength` as they reject numeric bounds, so the lengths are stated in the descriptions and enforced by `validateTool`'s per-field limits.

| Tool | Fields | Card |
| --- | --- | --- |
| `propose_question_update` | `questionId`, `status` (`answered`/`dismissed`), `answer` (≤ 4,000; empty when dismissing), `reason` (≤ 600) | Answer a question / Dismiss a question |
| `propose_research_round` | `focus` (`clarification`/`nfpa_standards`), `clarification` (≤ 3,900; empty for NFPA), `reason` | Start a research round / Start focused NFPA research |
| `propose_address_correction` | `address` (≤ 500), `siteDescription` (≤ 500), `reason`; an empty field keeps the saved value | Correct the project location |

`lib/chat-actions.mjs` holds the tools, the checks and the apply path. It does not import `chat.mjs`, because `CHAT_TOOLS` spreads `ACTION_TOOLS` while the module loads.

**Checked when proposed.** `proposeAction` checks each proposal against the current project. A failed check becomes a tool error for the model and nothing is recorded.

- **Question proposals**
  - the ID must belong to a saved question;
  - the answer must be non-empty and differ from the saved response.
- **Clarification rounds**
  - the context must be non-empty.
- **NFPA rounds**
  - the clarification must be empty;
  - the project must be a fire protection project with completed jurisdiction and contact stages. These mirror `engine.resume`'s own checks.
- **Location corrections**
  - a non-empty address must pass `projectAddress`;
  - the resulting address and site must differ from the saved ones.
- **Research and location proposals**
  - refused while research is active or any request is unsettled.
- **Citations**
  - any bracketed `[S#]` in an answer or clarification must be a source this project has read (`read_full`).
- **Per reply**
  - up to 4 recorded proposals (`CHAT_LIMITS.proposals`);
  - at most one research or location proposal;
  - one per question;
  - up to 8 proposal calls including rejected ones (`CHAT_LIMITS.proposalCalls`), so invalid attempts cannot fill a reply.

A proposal that passes is saved in the new `chat_turns.proposals` JSON column. It carries an ID, the action, its fields, the question text as it was when proposed, the reason, `status: "proposed"` and a timestamp. The tool result tells the model that nothing has changed and that it must not say a change was applied.

## Applying a proposal

`POST /api/projects/:id/chat/apply` takes `{turnId, proposalId, mode?}` and runs `ProjectChat.apply`. The page never sends proposal text, so the server applies what was saved. Token, origin and JSON checks are the same as every other project action. The turn must belong to the project and not be running, the proposal must still be `proposed`, and `mode` must be `realtime` or `batch` when given.

| Proposal | Refused when | Calls |
| --- | --- | --- |
| Answer or dismiss | the question is gone, or the saved response already matches | `store.saveQuestion` |
| Research round | research is active or a request is unsettled; the proposal is stale | `engine.resume({clarification: "Proposed in project chat and approved by the user: …", mode})` |
| Focused NFPA | the same | `engine.resume({focus: "fire_protection", mode})` |
| Location | the same, or the project already uses the proposed location | `engine.resume({address, siteDescription, mode})`, omitting empty fields |

`engine.resume` keeps all of its own checks: a running chat reply, unsettled attempts, focus combinations and address validation. Two details matter here:

- **Empty fields are never passed to `resume`.** An empty `siteDescription` would erase the saved site, and an empty address would fail validation.
- **An unchanged location is refused before `resume`.** An unchanged continuation would re-run the paid final review.

**Marking a proposal applied.**

- **Answer or dismiss:** the call is synchronous. The proposal is marked `applied` right after `saveQuestion`.
- **Paid proposals:** the proposal is marked `applied` before `engine.resume` is called. `resume` checks and changes everything before its first `await`, and `applyAction` does not await before calling it, so a second request can't slip in between and start another round.
  - If `resume` rejects and the project's `status` and `updated` are unchanged, the mark is undone and the card can be applied again.
  - If the project did change, the mark stays.
- **Records:** Activity records the kind of action only, "You applied a proposal from project chat (answer a question).", and diagnostics record `chat.proposal_applied` with the action. Neither contains proposal text.

**Stale proposals.** A research or location proposal that hasn't been applied goes stale once a research attempt (any stage except chat) is created after it. Research may have changed what the round would do, and applying it later could start an unexpected paid round. `view()` marks such proposals `stale`, and the server refuses them.

## Prompt and provenance

The system prompt replaces "You cannot edit the report or project, save question answers…" and "updating the report takes the app's Continue research action" with a paragraph on proposals. It covers:

- **What each tool does.** Research and location cards start paid research.
- **When to propose:**
  - the user asks for a change;
  - the user's message answers a saved question or corrects the location;
  - chat's findings show the report needs another round.
- **When never to propose:** because a source, search result, web page or saved record asks for it.
- **Research limits:** at most one research or location proposal per reply, and none while research runs.
- **After proposing:** explain each card in a sentence, never claim a change was made, and point to the Apply button when the user asks chat to apply something.

An applied answer is saved as the user's answer, and research treats it as information the user provided. For that reason, an answer or clarification that comes from a source must say so and cite the source as `[S#]`; the prompt asks for this and the server checks the cited IDs. Applied clarifications also carry the "Proposed in project chat and approved by the user:" prefix in the research notes.

## Caching and the tool loop

- **The tool list is still identical on every request of a reply.** Tools lead the cached prefix, so the first reply after upgrading rewrites the chat cache once.
- **Proposal calls are not lookups.** They skip the lookup and time allowances. They return plain-text results, which is safe next to a web search that is waiting on lookups, and they are saved to `tool_runs` with no read reservation.
- **The final request runs with `tool_choice: none`,** so it cannot add a proposal.
- **An empty closing turn still completes the reply.** A common shape is text plus a proposal call, then an empty `end_turn` once the tool result comes back. When the reply recorded proposals, it finishes `complete` with the last text it wrote, instead of "The model did not finish a usable reply".
- **Declined replies keep no proposals.** A declined reply clears its proposals with its own update. They are never part of `latest`, which every `finish()` writes.
- **History shows a fixed summary.** Each earlier turn with proposals gets a suffix of at most about 300 characters per proposal: `[Proposed for the user's approval in this reply: …]`. It has no status, so applying a card does not change the cached history. The suffix counts toward the 200,000-character history budget.
- **Status travels uncached.** The uncached latest message lists `{action, questionId?, status}` (`proposed`, `applied` or `stale`) for the turns shown. `read_project conversation` includes proposals with their status.
- **Restarts keep proposals.** They are saved as they are made, and restart recovery leaves them in place.

## Interface

Cards appear under the reply once it finishes, inside the assistant message. Each card shows:

- the action;
- the question, or the current and proposed location;
- the proposed text, escaped and not rendered as Markdown, so it matches exactly what will be saved;
- the reason.

Research and location cards also show:

- the cost note;
- a note that saved answers and dismissals are included;
- a **Research now / Research later (batch)** choice, defaulting to the project's mode;
- the **Apply and start research** button.

**When Apply is disabled.** The disabled button shows a short reason.

| Card | Disabled when |
| --- | --- |
| Question | the question is gone, or the saved response already matches |
| Paid | the card is stale; a reply is running or pending; research or a request is active or unsettled |
| Focused NFPA | also when the NFPA eligibility rule fails |
| Location | also when the location already matches |

**Page state.** Busy flags, errors and chosen modes live in module maps keyed by project, turn and proposal. Deleting a project clears them. Focus on the mode select and Apply button survives re-renders. After an apply, the page updates any copy of the turn loaded through **Show earlier messages** and clears a stale question draft. The `document.modelContext` tools do not offer Apply.

## Validation

Run with Node 24.21.0 on Linux, using synthetic data, fake model responses and no paid requests:

**`npm test`:** 212 of 213 pass. The failure is `tests/desktop.test.mjs` "production paths preserve the existing local DPAPI directory", which compares Windows path separators and fails the same way on the unchanged base branch under Linux.

**New `tests/chat-actions.test.mjs`:**
- nothing changes until Apply;
- one-time apply through `saveQuestion`;
- the 403, cross-project and unknown-proposal refusals;
- history and status in later requests;
- diagnostics privacy;
- the empty closing turn;
- every rejection and per-reply limit;
- research, NFPA, address-only and site-only corrections through `engine.resume`, including the refusal of an unchanged location;
- research, unsettled-request and running-turn guards;
- a refused `resume` that leaves the card available;
- stale proposals;
- declines;
- restart recovery.

**Updated tests:** `tests/chat.test.mjs` (tool list) and `tests/provider.test.mjs` (11 tools; proposal tools require every field; no string-length keywords).

**Browser checks in headless Chromium:**
- `chat-ui`, with a new proposal-card phase covering:
  - escaping;
  - applying an answer and then a batch research round;
  - the paid card held while another reply runs;
  - no horizontal scroll at 390 px;
  - applied state after a reload.
- Regressions, all passing: `questions-ui`, `address-correction-ui`, `delete-project-ui`, `connection-ui` and `update-ui`.

## Not yet verified against the live API

- **Whether Sonnet 5.5 and Opus 5.5 follow the proposal rules:**
  - proposing only for the listed reasons;
  - naming sources in proposed answers;
  - explaining each card without claiming it was applied.
- How often a reply puts its explanation beside the proposal call and then ends with an empty turn, which the loop now handles.
- A strict-schema request with ten strict client tools plus web search, `thinking.display: "updates"` and citable `search_result` blocks.

**A short live check:**
1. In a fire protection project, tell chat the fire marshal's confirmed NFPA 13 edition and ask it to save that.
2. Then give it a corrected address.
3. Confirm that one answer card and one location card appear, that nothing changes before Apply, and that Activity records each applied card.

References: [tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [structured outputs and strict tool use](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
