# Project chat: web research, streaming, formatting and declines

Four additions to project chat. Chat can research public sources, and the pages it reads join the project. Replies stream with a visible current step. Answers render as Markdown. A declined request gets its own status with a retry on the other model.

## Web research

| Setting | Before | Now |
| --- | --- | --- |
| Tools | `read_project`, `find_project_sources`, `read_saved_source` | the same, plus `read_source`, `render_page`, `inspect_pdf`, `locate_address` and native `web_search_20250305` |
| Searches | none | 2 per request (`max_uses`), 10 per reply |
| Public page reads | none | 20 per reply |
| Counted against research's 40 searches / 100 reads | not applicable | no; research's totals now exclude chat |
| Search result citations | discarded | shown as **[Web] Search lead**, not evidence |
| Pages read | not applicable | saved to the source register and supplied as citable excerpts |

**Pages chat reads join the project.** A `read_source` or `render_page` result is saved through the same `store.source` path research uses. Its text is then supplied to the model as a `search_result` block under the saved source ID, as `citedLookup` already did for saved-source lookups; paging and link metadata go in a sibling text block after all tool results. Search results are captured as discovery-only sources by `captureSearchSources`, now shared by research and chat.

**Leads.** `chatAnswer` keeps a `web_search_result_location` citation as `{kind:'lead',url,title,quote}` only when its URL came back in a `web_search_tool_result` during the same reply. The page shows it in amber as a search lead ("a lead, not verified evidence"), separate from **Supporting passage** citations.

**URL guard.** `read_source`, `render_page` and `inspect_pdf` accept only URLs in the source register (including search results), links saved from pages read, or URLs in the user's message. This follows the model of Anthropic's `web_fetch`, which fetches only URLs already present in the conversation. It stops text injected into a page from directing chat to put project details into an arbitrary URL. Research is unchanged.

**Separate allowances.** `store.project()` computes `searches` and `reads` without chat attempts. The search reservation in `store.reserve()` and `remainingSearches()` also ignore chat. `store.chatUsage(projectId, turnId)` counts one reply's searches (from `usage.server_tool_use`) and page reads (from `tool_runs`, reserved with `beginTool`). The user chose per-reply caps without a lifetime cap, because every reply starts from the user's own message.

**Tools never change within a reply.** Thinking blocks are bound to the request's system prompt, tools and history ("preserved thinking"); editing any of them is a 400 on accounts created from 2026-08-31. The tools also lead the prompt cache. So `web_search` and its `max_uses` are identical on every request of every reply. When the next request could exceed the reply's 10 searches, that request becomes the existing final answer request (`tool_choice: none`). The near-limit note now also fires when four or fewer searches remain.

**Mixed server and client tool turns.** If Claude calls `web_search` together with a lookup, the API returns `stop_reason: "tool_use"` with a `server_tool_use` block that has no result yet. The follow-up user message must contain only `tool_result` blocks; any text block after them ends the assistant turn and the request fails with a 400. In that case chat sends lookup results as plain text, without the sibling metadata block, and holds harness notes until the next round.

**`pause_turn`.** A paused server-side search turn is resent unchanged, with the same tools and no new user text. It counts toward the reply's request limit.

**Cost estimate.** `chatReserveMicros` replaces the research formula for chat. The first pass is priced as a one-hour cache write. Each possible search iteration is priced as a reread of the input plus about 20,000 result tokens at the base input rate, rather than multiplying the cache-written input by every search. At 300,000 input tokens on Sonnet 5.5:

| Formula | Searches | Estimate |
| --- | --- | --- |
| Research's, before | 4 | $6.87 |
| Research's | 2 | $4.37 |
| Chat's, now | 2 | $3.17 |

The actual charge is still recorded from `usage`; searches cost $10 per 1,000.

**Why `web_search_20250305`.** Sonnet 5.5 also supports `web_search_20260209` (dynamic filtering). It is deliberately deferred: it runs searches through code execution, is not eligible for zero data retention unless restricted to direct calls, and adds code-execution result blocks that the source capture and citation checks do not handle yet.

## Streaming and the current step

`Anthropic.message()` accepts an `onEvent` callback that receives each raw stream event. Chat follows each request with a small tracker:

- Text deltas build a draft, saved to a new `chat_turns.draft` column about once a second. A trailing save catches text held back when the stream pauses.
- A new step is saved immediately: "Thinking…", "Searching the web for “…”…" (the query is parsed at `content_block_stop`), "Reviewing N search results…" and "Writing the answer…".
- Before each lookup runs, `describeLookup` writes a step such as "Reading S4 for “NFPA 13”…" or "Inspecting page 12 of Fire Code.pdf…". Model-supplied text is shortened to 80 characters and escaped by the page.
- Chat requests now set `thinking.display: "updates"` (beta `thinking-display-updates-2026-08-18`, already sent with token counts and generation by `betaHeaders`). Sonnet 5.5's and Opus 5.5's between-tool progress notes therefore arrive with text, and the latest note is shown as the step.

The page polls `GET /api/projects/:id/chat` about once a second while a reply runs on the visible Chat tab. It patches only that reply's draft and step, keeping the scroll position unless the user was at the bottom. When the reply finishes, the whole project refreshes. The draft is cleared when a reply finishes or is recovered after a restart.

## Markdown

`public/markdown.js` is a dependency-free ES module shared by the page and the Node tests.

- **Escaping.** It escapes all text first and adds only its own tags. Links are emitted only for `http`/`https` URLs, with `target="_blank" rel="noopener noreferrer"`.
- **Supported syntax:**
  - headings (`#` renders as `h3`, so answers sit under the chat heading);
  - bulleted and numbered lists, including nested lists and lists with blank lines between items;
  - GFM tables with alignment, wrapped in a horizontally scrolling container;
  - fenced code, inline code, bold, italics and strikethrough;
  - quotations and horizontal rules;
  - links and bare URLs.
- **Source references.** A hook turns `[S1]` into a source button.
- **Citations.** Answer parts are joined into one document, with private-use markers where each part's citations belong. The document is rendered once, and each marker is then replaced with that part's citation. Citations therefore stay beside their claims inside lists and tables.
- **Security policy.** The content security policy is unchanged (`script-src 'self'`). The server serves `/markdown.js`, `npm run check` syntax-checks it, and the Windows package audit requires it.
- **Prompt.** The "does not render tables, headings or code blocks" instruction is replaced by: use a table when comparing several items on the same attributes, and keep reasoning in prose.

## Declined requests

A `stop_reason: "refusal"` now ends the reply with a new `declined` status (**Declined by Claude**) instead of `limited`.

- Partial output streamed before the decline is discarded. Previously the partial answer was saved.
- The note names the category in plain language (`cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms`) and adds Anthropic's explanation when present.
- It suggests a next step, and for `reasoning_extraction` it suggests asking for the conclusion and its sources.
- The note says which other model to try. `view()` returns `retryMode` (`opus` after a Sonnet decline, `standard` after an Opus decline), and **Try again with …** sends the same message with a new idempotency key.
- A `chat.declined` diagnostic records only the category.

Automatic server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) is not enabled:

- on Sonnet 5.5 it retries only `cyber` and `frontier_llm` declines, not `general_harms` or `bio`;
- fallback attempts bill at the fallback model's rates, which would have to be tallied per attempt from `usage.iterations`;
- it routes the conversation to the fallback model for about an hour.

## Validation

`npm test` on Node 24.21.0: 207 tests, 206 pass. The failure is the existing desktop path test, which expects Windows path joining and fails on Linux both before and after this change. The baseline before this change was 195 tests, 194 passing.

New and updated tests:

- `tests/chat.test.mjs`
  - web search and page reads joining the register;
  - citable reads and search leads;
  - the URL guard, including a user-named URL;
  - the per-reply read and search allowances;
  - research's exhausted 40 searches not blocking chat, and chat not changing research's totals;
  - identical tools on every request;
  - a search waiting on lookups, and `pause_turn`;
  - streamed drafts and steps under a mocked clock;
  - declines on both models.
- `tests/chat-citations.test.mjs`: read-source citations and lead filtering.
- `tests/markdown.test.mjs`: escaping, block and inline syntax, citation markers, unfinished streamed Markdown.
- `tests/provider.test.mjs`: the strict-schema contract with the new tools.

Browser checks pass in headless Chromium: `chat-ui` (with new Markdown, live draft and step, and decline-and-retry phases), `questions-ui`, `connection-ui`, `delete-project-ui`, `address-correction-ui` and `update-ui`. At 390 px, a six-column table scrolls inside the answer without widening the page. All tests use synthetic data, fake model responses and a fake web; no paid requests were made.

## Not yet verified against the live API

- A chat request combining `thinking.display: "updates"`, `web_search_20250305`, strict custom tools, citable `search_result` blocks and a mid-conversation `role: "system"` note.
- Resuming a search that waited on lookups (tool results only), and a real `pause_turn` continuation.
- Whether search iterations inside one request reread the cached prefix. This decides how close chat's estimate is to actual usage.
- The exact streaming shape of progress-update `thinking` deltas when they sit between a search and a lookup.

A short live check should ask one Standard question that needs current information (for example, the fire code edition currently adopted by a named county). Then compare the Activity entries, source register, cited passages, search leads and estimated versus recorded cost.

References: [web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [server tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools), [refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback), [streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).
