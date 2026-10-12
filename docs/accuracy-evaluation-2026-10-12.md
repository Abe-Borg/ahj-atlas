# Accuracy evaluation — October 12, 2026

Item 9 from the outside review of the prompts and evidence handling: passing the app's own validation cannot show that research reached the right answer. Only real cases with answers checked outside Atlas can do that. The deterministic test suite uses synthetic sources and fake model responses. It proves the application behaves as designed, not that Claude's research is accurate.

This note describes the evaluation: what it measures, how to run it on Windows, and how `scripts/score-evaluation.mjs` scores it. The script is offline. It reads JSON exports and an answer key, sends no requests and changes no project. The paid part is the research runs themselves, made in the app with your own Anthropic key.

## Plan

- **Cases.** Four of your own hyperscale data center fire protection projects whose answers the AHJ confirmed, for example in a plan review letter, a code-path meeting record, or the adopting ordinance it pointed you to. Pick cases that exercise the known hard behaviors:
  - a mailing city that is not the jurisdiction (an unincorporated county address);
  - an adoption clause and the NFPA edition table in separate sources (a state or local adoption of the building or fire code, with the standard's edition coming from the referenced-standards chapter);
  - a code-cycle transition, where the permit date decides between the current and an enacted future edition;
  - a city ordinance with local fire code amendments;
  - optionally, a Canadian site (a provincial building code and its referenced-documents table, plus CAN/ULC standards).
- **Runs.** Two runs per case, eight in total, in **Batch** mode. Two runs per case show how much the result varies between identical runs, so one bad run is not mistaken for a pattern.
- **Estimated cost: about $20–40 in total.** The only recorded full fire protection run is a data center in Vaughan, Ontario. It used 32 requests and cost $4.35 in real time. Real-time runs are estimated at $4–8 each. Batch roughly halves token cost; web searches are not discounted. The summary reports each run's recorded cost.

## Answer key

Copy `docs/accuracy-evaluation-answer-key.example.json` to `evaluation\answer-key.json` in your checkout. The `evaluation\` folder is ignored by git, because the key and the exports hold real project details. Add one entry under `cases` per project:

| Field | Meaning |
| --- | --- |
| `id` | A short label for the case, such as `case-a`. It appears in the results. |
| `match` | Text that appears in the Atlas project name (or its address). Name both runs of a case so they contain it, for example "Case A · run 1" and "Case A · run 2". |
| `source` | Where the answer came from. It is not scored or printed; it is a record for you. |
| `jurisdiction.authority` | The governing authority. List the accepted spellings, for example `["Loudoun County", "County of Loudoun"]`. Each name must appear as a whole word or phrase in the report's jurisdiction. |
| `codes[]` | Governing codes: `name` is a list of accepted names or abbreviations, matched as whole words in the report's code rows (so "NEC" does not match "Connecticut"). `edition` is the adopted edition. |
| `standards[]` | Individual standards: `standard` is the designation ("NFPA 13", "CAN/ULC-S524"), matched the same way the validator recognizes designations. `edition` is the adopted edition. |
| `public: false` | The answer is not established by public sources, for example it came only from AHJ correspondence or depends on design facts such as whether clean agent will be used. A gap on such an item is legitimate, not an omission. |
| `applicable: false` | The AHJ confirmed the standard does not apply. Only a `not_applicable` row agrees with it. |

Record the edition the jurisdiction adopted, not the latest edition the publisher has issued. For example, the latest NFPA 13 is the 2025 edition, while many jurisdictions still enforce the 2019 or 2022 edition through their building and fire codes.

## Running it on Windows

1. Set a workspace spend limit in the Anthropic Console, for example $50. The app does not limit spending; this gives a hard cap.
2. In Atlas, create two projects per case with identical inputs:
   - the same address;
   - Fire protection;
   - Hyperscale data center;
   - the same permit date, scope and context;
   - **Batch** processing.

   Name them so the case's `match` text appears in the name. Do not add the AHJ's letter or other private documents, and do not answer questions while a run is in progress. Either would hand Atlas the answer or make the two runs differ.
3. When each project finishes, export it as JSON into `evaluation\exports\`.
4. From the checkout folder, run:

   ```
   node scripts\score-evaluation.mjs evaluation\answer-key.json evaluation\exports > evaluation\results.md
   ```

   Add `--json` for machine-readable output. A folder argument scores every `.json` file in it. Files that are not project exports, such as a diagnostics bundle, are skipped with a message.

## How a run is scored

Each answer-key item gets one outcome, from the report rows that name it:

| Outcome | When |
| --- | --- |
| **Incorrect verified** | A verified row disagrees with the key: a wrong edition, a wrong authority, a not-applicable finding for a standard that applies, or an applicable finding for a standard the AHJ said does not apply. This counts even when another row agrees, because a reader cannot tell which to trust. It is the most important number. |
| **Correct** | A verified row agrees with the key, and none disagrees. |
| **Correct, not established** | A row has the right answer but none is verified, or a standard row has the right edition while leaving applicability conditional, unresolved or unstated. Atlas found the answer but did not establish it. |
| **Material omission** | No row agrees, and the key says the answer is publicly established. |
| **Legitimate gap** | No row agrees, and the key marks the item `public: false`. |

Editions match by year ("2019", "2019 edition" and "NFPA 13-2019" agree). An edition with no year must match as written. The jurisdiction is judged by the authority the report names; its description counts only when no authority is named, because a description may mention the right body while explaining why it does not govern. A standard the AHJ said does not apply is not established by a conditional or unresolved row. The summary also lists, per run:

- the processing mode, final status and recorded cost;
- the number of questions the report asks;
- **unchecked verified** findings: verified rows the key does not cover. These are listed for you to check by hand, because the script cannot judge them.

The summary does not count requests. A project's diagnostics export has them.

## Validation

`tests/score-evaluation.test.mjs` covers:

- edition matching;
- every outcome, including a verified disagreement next to an agreeing row, a not-applicable standard reported as applicable, and a run with no report;
- whole-word code-name matching;
- joining exports to cases by name or address, with unmatched exports and cases with no export listed;
- the Markdown summary and totals;
- the command line on a folder with a non-export file;
- the shipped template.

These tests make no paid requests. Accuracy remains unmeasured until the runs are made and scored.
