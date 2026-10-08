# Fixes from a Canadian data center diagnostics bundle

A 1.12.0 diagnostics bundle (one fire protection project, a hyperscale data center in Vaughan, Ontario, 32 requests, $4.35 recorded) showed no host or provider starvation: zero starvation episodes across 3,357 resource samples, peak system CPU 36.5% on 24 cores, peak event-loop delay 351 ms against a 500 ms threshold, heap at 3% of its limit, and no 429 or 529 responses. The research stages still ran out of requests, and every one of the report's 23 NFPA rows came back unresolved. Four application behaviors explain it, plus a cost-accounting gap.

## Standards checklist rejected Canadian rows

The Canadian country note tells fire protection research to screen CAN/ULC-S524, S536, S537, S1001 and CSA C282, and the checklist prompt asks for "one check per target, plus relevant discoveries". `fireCompletionError` rejected the whole `finish_research` call when any row was not a bare NFPA designation, with a message that did not say which row. The code stage and the Opus verification stage each spent their last two requests on rejected completions (about $1.27, 29% of the run), so both were kept only as unverified leads and the review had no verified edition evidence.

A row now names one standard. A single designation from another publisher (CAN/ULC, CSA, UL, FM) is kept as an additional row. A labelled NFPA row such as "NFPA 13 – Sprinkler systems" counts as NFPA 13, and the brief keeps the label. Grouped rows (`NFPA 13, 14 and 20`, `CAN/ULC-S524 / NFPA 72`) are still rejected, and the error names each row to fix and why. Required NFPA targets are still checked individually, and the review's edition checks are unchanged.

## One inexact quotation discarded a progress save

`validateProgress` threw on the first claim whose quotation was not found in a fully read source. In the jurisdiction stage this happened twice, each time in the same round that a large web fetch forced a context checkpoint, so both checkpoints started without the brief the model had just written. Exact claims are now kept as evidence, the brief and questions are saved, and each inexact claim becomes an `Unverified lead` question. It is never promoted to evidence. The tool result says how many claims were moved.

## Blocked pages were requested again

The municipal site returned HTTP 403 to `read_source` five times, including the same URL twice across a context reset, while `render_page` opened the site when tried. A URL refused with 401, 403, 406 or 429 is now remembered for 15 minutes. Its error names `render_page` or web fetch as the next step, and a repeat request returns that error without another network call. The HTTP code is stored as `httpStatus`, not `status`, because engine code reads `status === 401` as an invalid Anthropic key.

## Long code PDFs were searched 80 pages at a time

The code stage searched a PDF of about 1,260 pages in 80-page windows from the first pages, mostly receiving "no match" replies, and `read_source` and `inspect_pdf` could not start past page 500. Searches now scan up to 400 pages per call and name the page to continue from. Reads and searches can start at any page up to 5,000. Extracted page text is kept with the five-minute download cache, so another search of the same PDF does not extract it again. On a generated 1,260-page PDF, a 400-page search took about 2.3 seconds and a repeat search about 0.06 seconds.

## Cache writes missing from the TTL breakdown

On three research requests that ran several native searches, `usage.cache_creation_input_tokens` exceeded the sum of `cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` (41,129 vs 8,853; 104,987 vs 3,783; 32,457 vs 4,620). Anthropic documents the total as the sum of the breakdown, and the writes it adds after server tool results as 5-minute writes. The calculator priced only the breakdown, so about 161,000 written tokens (about $0.40 on this run) were never priced. The remainder is now priced as 5-minute writes, a 1-hour write keeps its own multiplier, and a breakdown larger than the total is never reduced. Earlier recorded costs are not rewritten.

## Validation

- `tests/fire-protection.test.mjs`: Canadian and labelled rows pass, grouped and mixed rows are named, and the brief keeps labels.
- `tests/evidence-recovery.test.mjs`: partial progress saves at unit and engine level; refused URLs are not refetched while 404s retry; a 1,000-page PDF is searched in 400-page windows with a continue-from note, cached page text, and an exact read past page 500.
- `tests/core.test.mjs`: the recorded four-search usage is priced with the unitemized remainder, plus 1-hour and oversized-breakdown cases.
- `tests/trust.test.mjs`: the Trust dialog's PDF limits and refusal window are pinned to the source constants.
