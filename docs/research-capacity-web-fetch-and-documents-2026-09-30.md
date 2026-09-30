# Research capacity, web fetch, search localization and user documents

This change gives the research and review models more room and more ways to reach evidence. It also lets the user add documents they already have. It follows the review of how the app limits the models, including the earlier MKE40 investigation, which found that the app's own ceilings, not the models, were the main cause of unfinished stages.

## Limits

| Setting | Before | Now |
| --- | --- | --- |
| Research input per request | 90,000 counted tokens | 300,000 |
| Checkpoint restart | at 60,000 | at 200,000 |
| Final review: source excerpts | 220,000 characters, 32,000 per source | 600,000 characters, 100,000 per source |
| Final review: each stage's brief | 24,000 characters | 80,000 characters |
| Final review rebuild | at 60,000 tokens, down to 80,000 then 30,000 characters | only above 300,000 tokens, down to 400,000 then 200,000 characters |
| Evidence check / final report effort | medium / medium | high / high |
| Research searches (project) | 40 | 80 |
| Evidence check searches / reads | 8 / 12 | 15 / 20 |
| Chat searches | 2 per request, 10 per reply | 4 per request, 20 per reply |
| Web fetch | none | 3 per request (research and chat), counted as page reads |
| Links shown per page read | 16, menus and footers dropped | 60, from the whole page |
| Links remembered per page read | the 16 shown | up to 1,000 |
| Download size | 10 MB | 50 MB |
| Real-time active research time | 15 minutes | 45 minutes |

**Review rebuild.** The final review is built as one large evidence package, so it is shrunk only when it would exceed the input ceiling. It no longer shrinks at the research checkpoint. Without this, the larger package would have been rebuilt at 80,000 characters as soon as it passed 200,000 tokens.

**Effort check.** Opus research stages previously ran at medium, which the capability check always covered. The check now confirms high effort for Opus before research that will need it, and for the Opus stages themselves.

## Anthropic web fetch as a fallback reader

`web_fetch_20250910` (the basic version) joins `web_search_20250305` in research and chat:
- It runs on Anthropic's servers, so it can open sites that block the app's own reader.
- It opens only URLs already in the conversation, enforced by Anthropic.
- It cannot run JavaScript.
- It costs nothing beyond the tokens of the page.

`max_content_tokens` is 60,000. That cap does not apply to PDFs, which come back whole, so the prompts steer PDFs to `read_source`.

**Why the basic version.** The dynamic-filtering versions (`_20260209` and later) filter only when called from inside code execution. That is not eligible for zero data retention, and it nests the results in code-execution blocks that the source capture, citations and leads do not handle. Called directly, they behave like the basic versions. The same reasoning keeps `web_search_20250305`.

**Capture.** `ResearchTools.captureFetches` saves each `web_fetch_tool_result`:
- A text document becomes retrieved text of kind `web-fetch`.
- A base64 PDF is converted with pdf.js, with page labels.
- A fetch error becomes a warning event and a `fetch.failed` diagnostic.

The engine runs this capture after each research response, and chat runs it after each reply request.

**Finding a fetched page.** A fetched page has no source ID in the conversation, so `read_saved_source` accepts its URL in place of an ID. Read errors now name the URL that failed (`Source returned HTTP 403 for https://…`). Anthropic lets web fetch open URLs that appear in client tool results, so the fallback can retry a URL the model constructed itself.

**Allowances.** Fetches are counted from `usage.server_tool_use.web_fetch_requests` as reads: in the project's research reads, the evidence check's reads and a chat reply's page reads.

A server tool cannot be refused one call at a time, and tools cannot change within a conversation. The allowances are therefore enforced in two ways:
- **Research.** The fetch tool's `max_uses` is bounded by the reads remaining when a conversation starts. A smaller remaining allowance starts a fresh conversation, as a smaller search allowance already did.
- **Chat.** Once a reply's page reads are spent, its next request is the final answer.

## Search localization

For a US project, `user_location` gives the city and state parsed from the address. Two-letter codes and full state names are accepted, with or without a ZIP code, a comma before the state, or a trailing "USA". An address without a recognizable state sends `{type:"approximate", country:"US"}`. Other countries send no location, because the API rejects unsupported country codes.

## Page reading

- **Links.** They are collected from the whole page before menus and footers are removed from the text. A read shows the 60 most relevant, and `saveLinks` remembers up to 1,000, so chat's URL guard allows any of them.
- **Tables.** Adjacent HTML table cells are joined with ` | `. The page renderer's tab-separated `innerText` cells are converted the same way.

## Documents you add

The **Sources** tab has **Add a document you have**. The page posts the raw file to `POST /api/projects/:id/documents`:
- The request carries the app token and `X-File-Name`.
- The route reads up to 50 MB before the JSON body parser.

`addDocument` extracts text locally:
- **PDF:** its text layer.
- **HTML:** its text, with table columns kept.
- **Plain text, Markdown, CSV and JSON:** as is.
- **Refused:** Word, Excel and other zipped or binary files, and scanned PDFs without text.

The text is saved as a `read_full` source of kind `upload`, addressed as `upload:<sha256 prefix>/<file name>`, with up to 2,000,000 characters. The research, review and chat prompts tell Claude that these are documents the user provided, to be cited as such rather than as pages retrieved from the issuing agency. Nothing runs automatically. The PDF export describes the source instead of linking it. The trust dossier has a new runtime row (U28) and a `web_fetch` row in its tools table.

## Validation

`npm test` ran on Node 22.22, because Node 24 could not be downloaded in the build environment. Everything passes except these five, which also fail without this change:
- two Node 22 SQLite binding failures (`chat.test.mjs` "tool continuations…" and `upgrade.test.mjs` "failed cancellation…");
- the Windows-only desktop path test;
- the trust browser test when no browser path is set (it passes with one);
- the `parallel-reads` timeout.

New tests:
- `tests/documents.test.mjs`
- web fetch capture, counting and lookup by URL in chat and research
- link collection and remembering
- table columns
- search localization
- the final review's larger package, high effort, and no rebuild below the input ceiling

Existing tests that encoded the old limits are now expressed relative to the configured limits. `tests/documents-ui.mjs`, `tests/chat-ui.mjs` and `tests/trust-ui.test.mjs` pass in headless Chromium. All tests use synthetic data, fake model responses and a fake web; no paid requests were made.

## Not yet verified against the live API

- A research or chat request declaring `web_fetch_20250910` with `max_content_tokens` next to `web_search_20250305` with `allowed_callers` and `user_location`, strict custom tools and `thinking.display: "updates"`.
- The exact streaming shape of a `web_fetch_tool_result`, and a web fetch deferred because Claude called it alongside a client tool.
- Token counts for a whole fetched PDF.
- Whether 300,000-token research requests change the balance of cost and quality enough to adjust the checkpoint.

A short live check should:
1. Run one research project against a site known to block the local reader.
2. Confirm that the page is fetched and saved as a `web-fetch` source.
3. Compare Activity, the source register and recorded usage with the estimate.

References: [web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool), [web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [server tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools).
