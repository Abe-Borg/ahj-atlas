# Chat: project first, then the web

Project chat already had web search, web fetch and the public-page readers, but replies rarely used them. This change makes chat go to the web on its own when the project records don't settle a question, and shows on each reply whether it did. It also adds copy buttons for answers and tables.

Several of the changes are adapted from Drawing Analyzer's report chat and its code-citation checker. Drawing Analyzer itself was not changed.

## Why chat stayed on project context

- **The prompt read as a boundary.** It opened with "This is a strict project silo". That sentence was meant to keep chat away from other projects, but it read as a limit on all outside information.
- **Searching was framed as a fallback.** "Start from the saved evidence. When it cannot establish the answer…" left the model to decide that the evidence was enough.
- **General knowledge was an easy substitute.** "You may add general professional knowledge where it helps" let a labeled answer from memory stand in for a lookup.
- **Claude Sonnet 5.5 tends not to reach for tools in chat.** Anthropic's migration notes for Standard's model say it "sometimes answers from its own knowledge … and can hold off on tools until asked directly". The prompt gave it no reason to do otherwise.
- **The interface said the same thing.** The chat header read **Project context only**. The help line under the reply depth read "This project's context and conversation only".

## What changed

### System prompt (`chatSystem` in `lib/chat.mjs`)

- **Isolation is between projects.** The silo sentence now says that projects are isolated, and that this does not keep chat off the public web.
- **Project first, then the web.** Chat answers from the records when they settle the question, and does not search only to restate them. The prompt names when to go to the web:
  - the wording or intent of a code section, standard or local amendment that the project's sources don't quote;
  - a code, standard, authority, product, listing or manufacturer requirement that the project doesn't cover;
  - an agency's current form, fee, submittal procedure, contact or review time;
  - a saved finding that is unconfirmed, conflicts with another, or may be out of date;
  - anything the user asks it to look up, check, verify or bring up to date.

  For such a fact, chat must not answer from memory, or reply that the project lacks it, while a search could settle it. It should search unprompted.
- **General knowledge explains; it does not replace a lookup.** A specific, checkable fact is read from a source: a section's wording, a numeric criterion, an edition, a listing, or a current procedure.
- **Code-checking discipline, from Drawing Analyzer's citation checker:**
  - Prefer the issuing body's own pages, and a section-level page over a whole code book.
  - Say which edition was read and whether it is the adopted one.
  - Confirm section numbers in the edition that applies, because sections are renumbered between editions.
  - A current official source outranks the saved report; cite both.
  - "No authoritative text could be found" is an acceptable answer; a guess is not.

  Drawing Analyzer's chat prompt itself was not copied. Its only web rule is negative ("not for questions the report already answers"), which is the behavior this change removes.
- **Tool descriptions state what the records lack.** Drawing Analyzer's `query_findings` description says what its data does and does not contain. The `read_project` description now says the same about project records: they hold no code text beyond retrieved excerpts, and nothing published or changed since research ran.

### Source-quality blocklist for chat's web search

- Chat's `web_search` sends `blocked_domains: LOW_QUALITY_DOMAINS` (in `lib/research-tools.mjs`). The list covers:
  - AI-assistant answer sites;
  - question-and-answer sites and forums;
  - how-to and lead-generation content farms.
- It is adapted from Drawing Analyzer's shared blocklist. Drawing Analyzer also blocks social media and encyclopedias; Atlas keeps both searchable, because a small fire district may post its code adoption or contacts only there. A search result is still only a lead.
- `searchTool` takes the list as an option, and research does not pass it. Research tools stay byte-identical, so a research stage's saved conversation (whose thinking is bound to its tools) stays valid across the upgrade.
- Chat replies always start fresh provider history (earlier turns are sent as text), so changing chat's tools between versions is safe.
- The tools still never change within a reply.

### Interface

- **Header pill.** It reads **Project first · web as needed**, with a tooltip.
- **Help line under the reply depth.** It says the project's records come first, then the web.
- **Reply status line.** `view()` returns each turn's `web: {searches, reads}` from `store.chatUsage`. Under a finished reply the status line reads **Checked the web: 2 searches, 1 page read** or **From project records**. Drawing Analyzer shows web activity as chips during a reply; Atlas already showed live steps, and this keeps the outcome visible afterward.
- **Fourth starter question.** "Check the authority's current website for code adoptions or amendments newer than this report."
- **Copy answer** copies a finished reply's Markdown.
- **Copy table** appears above each table in a finished reply.
  - It copies tab-separated cells, so they paste into Excel as cells, plus the table's HTML for Word. Drawing Analyzer's table artifacts copy the same way.
  - Citation disclosures are dropped and `[S1]` references stay as text.
  - A cell starting with `=`, `+`, `-` or `@` (other than a plain number) is prefixed with `'` so Excel keeps it as text. This follows Drawing Analyzer's CSV rule.

### Desktop permission

- The Electron session refused every permission request, which would also refuse `navigator.clipboard` writes.
- `secureWindowNavigation` now grants only `clipboard-sanitized-write`, and only when the requesting URL is the app's own origin.
- Reading the clipboard, and every other permission, stays refused.

## Not adopted

- **Inline artifacts** (`create_artifact` charts, tables and memos with downloads, plus the Files panel). They would need their own storage, rendering and replay rules beside proposals. Copy answer and Copy table cover the common case: pasting a table into a spreadsheet, or a drafted email into Outlook.
- **The `_20260209` dynamic-filtering web tools.** They stay unused for the zero-data-retention and result-shape reasons in the README.
- **Automatic server-side refusal fallback.** It stays off for the reasons in the README. Atlas keeps its **Try again with …** button.
- **A `calculate` tool**, **select text → ask**, and **transcript save/load**. These may be worth doing later. Atlas already persists chat server-side.

## Verification

- **`tests/chat.test.mjs`** (the web research test):
  - the reply's `web` usage;
  - the chat search tool's `blocked_domains`;
  - research's search tool without `blocked_domains`;
  - the prompt's project-first rule, and the absence of the silo wording.
- **`tests/chat-ui.mjs`:**
  - Copy table yields tab-separated rows;
  - Copy answer yields the Markdown;
  - a reply with no web use says **From project records**.
- **`tests/desktop.test.mjs`:** clipboard writes are granted only to the app origin; clipboard reads and other permissions are refused.
