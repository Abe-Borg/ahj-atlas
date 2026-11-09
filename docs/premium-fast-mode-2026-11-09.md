# Premium · Fast chat

Chat with Atlas has a **Fast** checkbox beside **Reply depth**. With Premium chosen, Fast sends the same Premium reply in Anthropic's fast mode for Claude Opus 5.5. The answer is written up to about 2.5 times faster, at twice Premium's token prices. Fast is unavailable while Standard is chosen. Research, the evidence check and the final report do not use it.

## What a Fast reply sends

- **Model, effort and prompt.** Claude Opus 5.5 at high effort, with the same system prompt, tools, evidence, adaptive thinking and progress updates as Premium.
- **`speed: "fast"`** as a top-level request field. Fast mode on Opus 5.5 is generally available on the Claude API, so the request needs no beta header. SDK 1.6.0 types the field on `messages.stream`.
- **No `fallbacks`.** Anthropic's refusal-fallback documentation does not say what happens to `speed: "fast"` under `fallbacks: "default"`: whether the fallback attempt runs fast, at standard speed, or is rejected up front, and at which rates it is billed. The app does not send a combination whose billing it cannot price. The live check reports whether the API accepts the combination, so this can be revisited.
- **Token counts leave `speed` out.** The token counting endpoint is not documented to accept it, and speed does not change the count. The provider's count body already lists its fields explicitly.

Chat stores the reply under its own mode id, `opus_fast` (`CHAT_MODES` in `lib/config.mjs`, with `speed: 'fast'` and `fastOf: 'opus'`). No database change is needed. The reply is labeled **Premium · Fast · Claude Opus 5.5**. Every request in a reply keeps the same speed, since changing speed mid-reply would discard the cache.

## Pricing

`MODELS.review.fast` holds the Opus 5.5 fast rates: $8 input, $40 output and $0.40 cache reads per million tokens. Anthropic's pricing page states the input and output rates and says prompt caching multipliers apply on top. The cache read rate follows from Opus 5.5's 0.05x read multiplier. Cache writes are 1.25x input (5 minutes) or 2x input (1 hour), which the existing arithmetic applies. Web searches stay $10 per 1,000.

`pricingSnapshot(..., {speed: 'fast'})` saves the fast rates with each attempt, together with the model's standard rates. `costMicros` charges a response that reports `usage.speed: "standard"` at the standard rates. Anthropic documents that a successful fast request reports `"fast"`. A response without the field keeps the fast rates, which is conservative. Reservations and interrupted-stream estimates use the saved fast rates.

## Caching

Requests at different speeds do not share cached prefixes. The first Fast reply in a project writes the evidence cache at fast rates, and so does the first standard-speed reply after Fast is turned off. Follow-ups within the hour at the same speed read it back.

## Declines, rate limits and capacity

- **A declined Fast reply** shows **Declined by Claude** and offers **Try again with Standard**, as Premium does. Its note adds that Fast replies do not use server-side fallback, and that with Fast off Anthropic can continue some declined Premium replies on another model.
- **The capability check cannot see fast mode.** The Models API lists no fast-mode field, so the check before a reply's first request covers Opus 5.5 and high effort only. Anthropic gives Opus 5.5 fast mode a default rate limit on the Start, Build and Scale tiers. An account outside those tiers gets Anthropic's error on the first Fast request, shown on the reply, and can turn Fast off.
- **Fast mode has its own rate limit and capacity.** A 429 or 529 on a Fast reply ends it with the provider's message, followed by: "Fast mode has its own rate limit and capacity. Turn Fast off to send at standard speed, or wait and send again." Chat does not retry automatically. Anthropic suggests retrying at standard speed when you would rather not wait, but that changes the price and starts a new cache, so the user decides.

## Interface

- **Fast checkbox** (`#chat-fast`, capability `chat.fast`). Disabled while Standard is chosen.
- **Remembering the choice.** The panel remembers the choice per project while the app is open, and **Ask Atlas** uses it.
- **Help text.** The help line under the dropdown, **How this chat works and what it costs**, the user guide, the trust page and the guided tour's composer step describe Fast.
- **Diagnostics.** The request summary records `speed`, and the response's `usage.speed` is kept with its usage.

## Verification

- **`tests/chat.test.mjs`:**
  - Premium keeps `fallbacks: "default"` and sends no speed. Fast sends `speed: "fast"` with no fallbacks and is otherwise the same request.
  - Fast attempts save fast and standard rates, cost twice the same Premium usage, and are charged Premium's rates when the response reports standard speed.
  - The modes list and the reply label.
  - The declined-reply note.
  - The 429 and 529 advice, which Premium does not get.
- **`tests/provider.test.mjs`:** through the SDK stream, a Fast request sends `speed: "fast"` with no beta header, token counting leaves `speed` out, and `usage.speed` reaches the app.
- **`tests/chat-ui.mjs`** (browser):
  - The dropdown still lists two depths.
  - Fast is disabled with Standard and remembered for Premium.
  - A Fast reply sends `speed: "fast"` without fallbacks and shows its label.
  - Ask Atlas follows Fast.
  - The cost help describes it.
- **`npm run live-check -- --yes`** sends a Premium · Fast chat request built by `chatPayload`. The check fails unless `usage.speed` is `"fast"`. It also tries `speed: "fast"` with `fallbacks: "default"` and reports the outcome. Run it before releasing; it needs an API key.
