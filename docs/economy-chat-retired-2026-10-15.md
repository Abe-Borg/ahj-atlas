# Economy chat retired

The project chat's reply-depth selector no longer offers **Economy — Claude Haiku 5.5, medium reasoning**. New messages choose between **Standard** (Sonnet 5.5, high effort, the default) and **Premium** (Opus 5.5, high effort). Research, the evidence check and final reports are unchanged.

## What changed

- `CHAT_MODES` lists only `standard` and `opus`. `economy` moved to the retired depths beside `deep`, so the server refuses a new message that names it ("Choose Standard or Premium for this reply.").
- Chat payloads always use the full evidence opening, preview, excerpt and history budgets. The Economy-only `CHAT_LIMITS.economy` budgets, the Haiku system-prompt addition (current date and search guidance) and the omitted thinking display are gone; every chat request sends `thinking.display: "updates"`.
- The chat cost help, the user guide and the trust dialogs no longer describe Economy as a choice.

## What stays

- Replies saved with Economy keep their mode and show **Economy · Claude Haiku 5.5**. A declined Economy reply still offers **Try again with Standard**.
- `MODELS.economy` (Haiku 5.5 prices, including the 100,000-token prompt tier) stays in `lib/config.mjs`, so earlier Economy attempts keep their recorded costs and any pending Economy charge is still reconciled with its saved pricing snapshot. `tests/haiku-pricing.test.mjs` continues to cover that calculator.
- The saved chat evidence opening keeps its revision format. An opening saved for a Standard or Premium reply stays valid; one last saved for an Economy reply is rebuilt once on the next reply.

## Verification

- `tests/chat.test.mjs` checks that replies saved with Deep or Economy keep their labels and that a new message cannot choose either, and that the selector lists only Standard and Premium.
- `tests/chat-ui.mjs` checks that the browser selector offers only Standard and Premium and that the cost help mentions neither Economy nor Haiku.
- `tests/trust.test.mjs` pins the trust facts to `CHAT_MODES` and `CHAT_LIMITS` and checks each depth's payload.
- The Economy-only `tests/haiku-chat.test.mjs` was removed.
