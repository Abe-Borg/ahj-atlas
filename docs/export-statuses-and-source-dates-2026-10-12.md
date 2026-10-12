# Export statuses and source dates — October 12, 2026

Two findings from an outside review of the prompts and evidence handling: old evidence could look freshly retrieved, and the PDF dropped the uncertainty labels the app shows for each finding.

## Source dates

**Before.** When search found a URL already in the source register, `store.source` set its `retrieved` timestamp to now while keeping the previously retrieved text. In the reviewer's reproduction, a source dated 2020 containing an old adoption statement received a 2026 retrieval timestamp after a discovery-only search hit, and stayed marked as read evidence. That timestamp reaches the research and review models (`retrieved` in evidence packages and chat previews) and every export, which undercuts the prompts' instructions to check current editions and contacts. The Excel export also labeled its export time **Research date**.

**Now.**

- `retrieved` moves only when text is actually read (`readFull` with text). A search hit or citation capture that only finds the URL again updates the title and kind as before but keeps the earlier date. A reread that returns unchanged text still moves it, because the text was confirmed current. For a source with no read text, a visual page inspection records the inspection time, so a lead later inspected as a scanned page is labeled **Inspected** with the right date (found by the Codex review on the pull request). A visual look at a page whose text was already read keeps the text-retrieval date.
- The app's Sources tab, the PDF source register and the Excel **Sources** sheet label the date by how the record was made: **Retrieved** (text read), **Discovered** (a lead never read), **Inspected** (a scanned page viewed visually) or **Added** (a document the user added). Excel gains a **Date type** column beside **Date recorded**.
- The Excel **Project** sheet replaces **Research date** with **Report generated** (the report's `generatedAt`, when a report exists) and **Exported**. The PDF header line now starts with **Report generated** before **Exported**.

Chat's evidence cache already ignored `retrieved` when deciding whether a source changed; its comment now describes the remaining case (a reread of unchanged text). The final review's recovery check still treats any source read after the saved review as new evidence, which is now narrower and still conservative.

## Item-level statuses in the PDF

**Before.** Authority, contact and submission-requirement entries printed no evidence status, and citations did not say when their quotation failed validation. The reviewer's PDF showed a conflicting contact, an unverified requirement and an unsupported quotation as ordinary entries. Code rows printed the raw enum (`VERIFIED`).

**Now.**

- Every finding in the PDF prints **Evidence status:** in the app's wording (`public/app.js` badge): Source-supported, Conditional, Conflicting or Unconfirmed. That covers jurisdiction, authorities, contacts, codes, NFPA and referenced standards, and submission requirements.
- A short legend under the project briefing defines the four statuses and the unmatched-quotation marker.
- A citation whose quotation was not matched to retrieved text (`supported` is false) carries **Supporting passage needs confirmation**, the same words the app shows, in the PDF and in the Excel evidence cells. Excel status columns keep the raw values so they stay filterable.

## Validation

`tests/http-exports.test.mjs` adds two tests. The first reproduces the 2020 case: a search hit leaves the date and text unchanged, a read moves the date, and a lead keeps its discovery date. The second validates a report with a conflicting contact, an unverified requirement and an authority whose quotation is not in the source. It then checks the PDF section by section for each status and the marker, the report and export dates, and the source date labels, and checks the Excel rows, evidence cells and **Date type** column. Both fail on the previous code. `tests/chat.test.mjs` now asserts that a search hit re-finding a saved page keeps its date, replacing the old assertion that it changed. `tests/essentials-export.test.mjs` follows the renamed and added columns. These are deterministic tests; no paid requests are made.
