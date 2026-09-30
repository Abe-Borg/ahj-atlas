# Chat evidence, lookups, page reads and report notes

Four changes to project chat. It sends more saved evidence with each message, reads larger passages per lookup, gets more page reads per reply, and can save findings to the report as notes the user approves.

## Limits

| Setting | Before | Now |
| --- | --- | --- |
| Citable excerpts preloaded | 160,000 characters, 32,000 per source | 400,000 characters, about 67,000 per source |
| Report / research briefs / source register preloaded | 160,000 / 120,000 / 60,000 | 240,000 / 240,000 / 120,000 |
| Characters per lookup (`toolChars`) | 24,000 | 60,000 |
| Page reads per reply | 20 | 30 (web fetches included) |

**Preloaded evidence.** At these sizes a large project's first message is roughly 300,000 tokens. That is well inside the model's context window, since chat has no app token ceiling. With the one-hour cache, the first message in an hour pays the cache write (about $1.20 on Sonnet 5.5 at that size), and follow-ups reread it at $0.20 per million tokens.

**Lookups.** Chat's `ResearchTools` instance is created with `pageChars: 60000`, so `read_source`, `render_page` and `read_saved_source` in chat return up to 60,000 characters. Chat's copy of the tool descriptions says so. Research's instance and its tool definitions are unchanged at 24,000 characters; their serialized definitions are byte-identical.

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
  - an Excel **Notes** worksheet;
  - the JSON export's `notes`.
- **Labeling.** Each note is labeled as saved from project chat by the user and not re-verified by research. Research and the final review do not read notes.
- **Chat's view.** Chat sees the current notes in the uncached part of every message and can read them with `read_project` (`notes`). The system prompt describes when to propose one.

The trust dossier adds the note path to U17 and a new runtime row, U29 (Remove a saved note), with its ledger entry.

## Validation

`npm test` on Node 22.22 (Node 24 was unavailable here): every test passes except the failures that also occur on `main` in this environment:
- the Node 22 SQLite boolean-binding failures;
- the Windows-only path test.

New tests cover:
- notes: proposal checks, apply-once, persistence across a report rebuild, the detail API, chat context and JSON export, removal with authorization and project scoping, proposals while research runs, and project deletion;
- chat's 60,000-character lookups beside research's unchanged 24,000;
- larger per-source chat excerpts;
- `fill` versus plain selection.

The chat browser check now saves a note from a card, confirms it is escaped on Overview with a linked citation, and removes it. No paid requests were made.
