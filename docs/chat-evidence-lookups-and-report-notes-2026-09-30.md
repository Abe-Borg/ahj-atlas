# Chat evidence, lookups, page reads, report notes and research reads

Four changes to project chat, and one to research. Chat sends more saved evidence with each message, reads larger passages per lookup, gets more page reads per reply, and can save findings to the report as notes the user approves. Research's page reads get the same larger maximum.

## Limits

| Setting | Before | Now |
| --- | --- | --- |
| Citable excerpts preloaded | 160,000 characters, 32,000 per source | 400,000 characters, about 67,000 per source |
| Report / research briefs / source register preloaded | 160,000 / 120,000 / 60,000 | 240,000 / 240,000 / 120,000 |
| Characters per lookup (`toolChars`) | 24,000 | 60,000 |
| Page reads per reply | 20 | 30 (web fetches included) |
| Characters per research read (`LIMITS.pageChars`) | 24,000 | 60,000 |

**Preloaded evidence.** At these sizes a large project's first message is roughly 300,000 tokens. That is well inside the model's context window, since chat has no app token ceiling. With the one-hour cache, the first message in an hour pays the cache write (about $1.20 on Sonnet 5.5 at that size), and follow-ups reread it at $0.20 per million tokens.

**Lookups.** Chat's `ResearchTools` instance is created with `pageChars: 60000`, so `read_source`, `render_page` and `read_saved_source` in chat return up to 60,000 characters. Chat's copy of the tool descriptions says so. Research's instance reads `LIMITS.pageChars`, now also 60,000 (below). The two settings stay separate so they can differ later.

## Research reads

A research read returns 8,000 characters by default (`readChars`, unchanged) and now up to 60,000 when the model asks for more, instead of 24,000. The model still pages with `offset`/`nextOffset` and searches a whole page, or up to 80 PDF pages, with `query`.

**Why 24,000 was low.** It dated from 90,000-token research requests, when a full read took about 7% of the room. Requests now go up to 300,000 tokens and restart from a checkpoint at 200,000. Each page-through counts as one of the project's 100 reads (and the evidence check's 20), so reading a 150,000-character ordinance chapter took 7 reads. Anthropic's web fetch, the fallback reader, already returned up to 60,000 tokens.

**Effects:**
- **Cost.** It rises only when the model asks for long reads. Earlier tool results are reread from the cache.
- **Checkpoints.** They come sooner: about 10 maximum-size reads fill a conversation to the 200,000-token checkpoint, instead of about 30. A restart carries the saved findings and targeted evidence forward.
- **Reset limit unchanged.** Each stage still gets `contextResets` (2) restarts before it must finish.
- **Conversations already in progress** keep their saved tool descriptions, which name 24,000. The reader allows 60,000 either way.

## Filling the evidence allowance

Enlarging chat's excerpts exposed a limitation that also affected the final reviewer's package from the previous change. `selectPassages` builds excerpts from windows around matches, and each pattern is capped at 200 matches. In a long source whose matches are dense, all of those windows sit near the start. The selection then stopped at about 15,000–20,000 characters, however large the allowance.

A new `fill` option keeps the relevant passages first. It then spends the rest of the allowance on the source's other text in document order, and joins touching spans. The final review's evidence package and chat's first message use it. Research's own evidence packages and all query searches are unchanged.

## Report notes

`propose_report_note` (title up to 200 characters, note up to 6,000) is a fifth proposal type:
- **Checks when proposed.** Any `[S#]` in the note must name a source this project has read. A duplicate of a saved or already proposed note is refused. It may be proposed while research runs, because it changes no research.
- **Applying.** Apply calls `store.addNote`, which is free. Notes live in a new `report_notes` table, apart from the report, so a research round that rebuilds the report keeps them. Deleting the project deletes them.
- **Where notes appear:**
  - a **Notes** section on Overview, rendered as Markdown with `[S#]` linked to the saved sources and a **Remove** button (`DELETE /api/projects/:id/notes/:noteId`, confirmation first);
  - the PDF export, as a **Notes** section before the source register;
  - an Excel **Notes** worksheet, with an **Origin** column;
  - the JSON export's `notes`.
- **Labeling.** Each note is labeled as saved from project chat by the user and not re-verified by research: in the PDF section's lead-in, the Excel **Origin** column and the JSON `origin`. A standalone workbook therefore cannot be mistaken for reviewed findings. Research and the final review do not read notes.
- **Chat's view.** Chat sees the current notes in the uncached part of every message and can read them with `read_project` (`notes`). The system prompt describes when to propose one.

The trust dossier adds the note path to U17 and a new runtime row, U29 (Remove a saved note), with its ledger entry.

## Validation

`npm test` on Node 22.22 (Node 24 was unavailable here): every test passes except the failures that also occur on `main` in this environment:
- the Node 22 SQLite boolean-binding failures;
- the Windows-only path test.

New tests cover:
- notes: proposal checks, apply-once, persistence across a report rebuild, the detail API, chat context and JSON export, removal with authorization and project scoping, proposals while research runs, and project deletion;
- chat's 60,000-character lookups and research's 60,000-character reads, including the 8,000-character default and paging past a full read;
- the Excel **Notes** sheet's **Origin** column and the JSON `origin`;
- larger per-source chat excerpts;
- `fill` versus plain selection.

The chat browser check now saves a note from a card, confirms it is escaped on Overview with a linked citation, and removes it. No paid requests were made.
