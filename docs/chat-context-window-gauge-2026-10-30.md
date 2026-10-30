# Chat context window gauge — October 30, 2026

**Before.** Chat with Atlas counted every request's tokens before sending it (`provider.count`, the free `/v1/messages/count_tokens` call) and refused one that would not fit the model's context window less the output allowance, ending the reply with "This conversation filled the model's context window." That count was used once and discarded. Nothing in the panel said how large a reply's context was, how close it came to the limit, or that older messages had stopped being sent, so the first sign of a full context was a reply that ended with **Limit reached**.

**Now.** The panel tracks the context window the way Build-a-Spec's header pill does (`142k / 1M context`), adapted to how Atlas builds a reply. Every count is saved on the reply, the panel shows the latest one as a gauge below the cost line, and each finished reply shows its own figure.

## How Atlas's context differs from Build-a-Spec's

Build-a-Spec's chat carries one growing conversation, so its gauge is the final request's prompt plus the retained reply: what the next turn starts with. Atlas rebuilds every reply from the saved evidence snapshot, the most recent 200,000 characters of conversation (`CHAT_LIMITS.historyChars`) and the new message; a reply's lookup results are not resent with the next message (pages it read join Sources, which feed the saved evidence). Within a reply, every request only adds to the previous one (assistant blocks, tool results, wrap-up notes), so the latest counted request is also the largest. The gauge therefore reports, per reply:

- **tokens**: the latest counted request, which is the reply's largest, including a request refused over the limit (it shows why the reply ended);
- **opening**: the first counted request, the size the reply started from before any lookup;
- **window** and **limit**: the window the count was checked against (the one the Models API reports for the key, otherwise `CHAT_LIMITS.contextWindow`, 1,000,000) and the input limit (the window less `CHAT_LIMITS.output`, 128,000);
- **turnsShown** and **turnsOmitted**: how many earlier turns were sent as conversation and how many older ones were left out; Atlas reads those with `read_project conversation`. These are the same numbers the latest message already gives the model (`earlierTurnsShown`, `olderTurnsOmitted`).

## Backend

- **Storage.** A new nullable `chat_turns.context_use` column holds the record as JSON. It is added by the usual `ALTER TABLE` check in the `Store` constructor, decoded by `chatTurns` (null when absent) and written through `updateChatTurn`, which now accepts and encodes `context_use`. Older replies keep a null record.
- **Recording.** `ProjectChat.run` computes the earlier-turn window once with the new `earlierTurns(store, turn)`, which is the selection loop that used to live inside `chatPayload`, moved out unchanged. `chatPayload(store, turn, earlier)` takes it as an optional third argument and computes it itself when called without one, so its output is byte-identical. After each count, and before the limit check, `run` saves `{tokens, opening, window, limit, turnsShown, turnsOmitted}` when the count is a non-negative safe integer. A count the app cannot use is not recorded; the reply ends as before.
- **View.** `ProjectChat.view` adds `contextUse` to a turn only when it has a record, so a reply without one has no key.
- **What did not change.** No new request is sent: the count already ran before every request. Nothing is added to any request, to the cached opening, to `read_project` (its `conversation` section maps named fields), to exports or to diagnostics. The record holds counts only.

## Panel

- **Gauge.** `chatContext(turns)` renders the latest reply that has a record, at the right of `.chat-send-row` (it wraps below the costs when the panel is narrow): a 44-pixel bar and `142k / 1M context window`. It is a `role="meter"` element with `aria-valuenow`/`aria-valuemax` and an `aria-valuetext` such as "142,304 of 1,000,000 tokens (14.2%)". The label says "context window" because "project context" already means the inputs you add to a project.
- **Levels.** Amber (`near`) from three-quarters of the input limit (654,000 tokens on a 1M window), red (`full`) when a request was over the limit.
- **Tooltip.** `contextDetail` gives the exact count and percentage, which request it was (current while running, largest when finished), the size the reply started from and what its lookups added, how many older messages were not sent, the limit when amber or red, and that each new message starts again from the saved records and the recent conversation.
- **Per-reply figure.** A finished reply's status line gains `142k-token context` (amber or red at the same levels) with the same tooltip, headed "This reply".
- **Live.** The once-a-second follower that patches a running reply's draft and step also re-renders the gauge when the running reply's record changes; the five-second project refresh re-renders the panel as before.
- **Help.** **How this chat works and what it costs** gains a paragraph on the gauge.

## Verification

- `node --test tests/chat.test.mjs`: a two-request reply records 120,000 then 154,321 tokens, shows the second while the reply is held mid-flight, keeps it after completion and after reopening the database; a count the app cannot use leaves no record; 40 saved turns produce a record whose `turnsShown`/`turnsOmitted` match the payload's `earlierTurnsShown`/`olderTurnsOmitted`, and replies without a record have no `contextUse`; requests refused over a 1M and a reported 200,000-token window record their counts, window and limit; a database whose `chat_turns` lacks the column gains it on open and keeps its replies.
- Reversion probes (each restored afterwards): not saving the record, recording `opening` as the latest count, reporting zero omitted turns, ignoring the reported window, and dropping `contextUse` from the view each fail those tests; removing the migration makes every chat reply fail.
- `node tests/chat-ui.mjs` (real browser, fake provider): the existing meta-line check now expects `1k-token context`; a new phase checks the gauge's text, level, `aria-valuenow`, `aria-valuetext`, bar width and tooltip, the help paragraph, an amber gauge that updates while a held reply runs at 700,000 tokens, the red gauge and reply figure after a request refused at 872,001 tokens (no request sent), the figure after a reload, and no horizontal overflow in a 390-pixel window.
- The rest of `npm test` passes. In the Node 22 container used for this change, one existing test in `tests/resource-exhaustion.test.mjs` (a started stream that hits the deadline) is cancelled with and without this change; CI runs Node 24 from `.node-version`.
