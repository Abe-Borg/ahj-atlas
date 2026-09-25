# MKE40 run investigation — September 24, 2026

The uncertainty in this report has mixed causes. Some reflects genuinely missing project information and inconsistent public records. However, this run also hit avoidable application limits, lost relevant evidence between research and review, and applied at least one faulty validation rule. It should not be treated as a demonstration of the best result the models could produce.

The strongest finding is that the app stopped the contacts, codes, and verification investigations at its own 90,000-token input ceiling. The monetary budget and output ceilings were not exhausted. A more expensive model or a larger dollar allowance is therefore not the first remedy supported by this evidence.

This investigation used both supplied JSON files, the corresponding saved project in `data/atlas.sqlite` opened read-only, the current version 1.3.0 source code, and Anthropic's official web-search documentation. The saved database supplied the exact request packages needed to distinguish evidence collected by the app from evidence actually shown to the final reviewer. No paid model requests were made and no application code was changed. Regulatory excerpts were examined as evidence of the program's behavior; this was not an independent code-compliance review.

Project ID: `55622308-7bc4-49c7-bdfe-d382ce8a5be7`. The run began at 15:41:45 UTC and produced its report at 15:50:03 UTC.

| Resource or outcome | Observed | Interpretation |
|---|---|---|
| Recorded API cost | $2.025714 of $10 | No monetary-budget block occurred. This is the app's recorded cost, not an independently reconciled invoice. |
| Model requests | 22, all settled | No failed or ambiguous model request in this project. |
| Billable web searches | 7 of 40 project allowance | Global allowance remained; seven additional searches received limit errors. |
| Source-read attempts | 29 of 100 | Global read allowance remained. Includes failed reads. |
| Verification reads | 9 of 12 | Verification read allowance remained. |
| Research output | Largest response 4,959 tokens; ceiling 60,000 | No research response hit its output ceiling. |
| Final review | 49,535 input; 21,076 output; output ceiling 100,000 | Completed normally with `end_turn`. Output includes thinking tokens. |
| Active time accounting | 547,652 ms of 900,000 | No active-time stop occurred. Parallel-stage accounting differs from wall time. |
| Source records | 70; 16 marked read; 54 discovery-only | Source count does not mean 70 documents were read. |

1. **Three substantive investigations were cut off before they could finish.**

   The diagnostics contain the following final preflight counts. These are token-counter results for the next proposed request, not cumulative billing totals.

   | Stage | Requests used / limit | Next input size | Diagnostic event ID | Result |
   |---|---:|---:|---:|---|
   | Contacts and process | 7 / 12 | 93,450 | 223 | Partial, no completed brief |
   | Codes and standards | 5 / 12 | 98,518 | 273 | Partial, no completed brief |
   | Verification | 4 / 6 | 111,002 | 339 | Partial, no completed brief |

   Each exceeded `application.limits.input = 90000`. Their stage records explicitly give the input-limit reason. This is an app-imposed stop before submission, not a provider rejection demonstrating the model's maximum context capacity.

   `lib/engine.mjs:60–70` counts the payload and stops oversized research stages. Only final review receives an automatic smaller evidence package. `lib/prompts.mjs:22–23` retains the full stage conversation on continuation. Tool results and search results accumulate until the next request no longer fits.

   The saved contacts, codes, and verification stage outputs are each zero characters. `markPartial` at `lib/engine.mjs:219` records the partial status without generating a compact handoff. The last retrieved sources are saved, but the researcher does not get another model call to interpret those newest results or finish its brief. Verification and final review use `stage.output`, not a complete reconstruction of those unfinished conversations.

2. **Evidence that had already been collected was omitted from the final review package.**

   This was verified against the actual saved final-review request, not inferred from the exported report alone.

   | Source | Text saved by app | Text shown to final reviewer | Relevant information omitted |
   |---|---:|---:|---|
   | S30, Wisconsin delegated municipalities PDF | 122,606 characters | 1,057 | The Village of Hartland row, present around character 105,134 |
   | S56, SPS 361.05 | 21,418 | 2,307 | Explicit IBC 2021 and IEBC 2021 incorporation text |
   | S51, SPS 366 | 10,495 | 2,307 | IEBC application to alteration and change of occupancy |

   The S51 and S56 excerpts shown to review consist largely of navigation and unrelated context. The final report consequently says certain adoption/change-of-occupancy text was not retrieved, even though it exists in the saved evidence. This does not establish the complete regulatory path for the proposed data center; it establishes an avoidable failure to transmit relevant evidence.

   `evidencePackage` at `lib/prompts.mjs:58–64` allocates a character share across all source records, including discovery-only records with no text. Unused shares from empty or short records are not redistributed. Fire-protection weighting prioritizes occurrences of “NFPA,” which can underweight jurisdiction tables and general building-code adoption provisions. `reviewExcerpts` at lines 70–82 selects initial text, quotations found in completed briefs, keyword matches, and a tail fragment. It does not prioritize the actual project municipality, and overlapping chunks can spend the small allocation on repeated navigation. Missing completed research briefs also remove useful quotation anchors.

   The review request had 49,535 input tokens, well below the 90,000-token ceiling. Its source selection lost important passages despite this available capacity. The reviewer had no external tools in that final step, so it could not independently recover an omitted section.

3. **At least one uncertainty label is caused by a reproducible validation bug.**

   The review model returned NFPA 1 with edition 2012, adoption and edition source IDs both S43, and a `verified` status. The final exported row is `unverified`. Its source quotations passed the app's exact-text support check.

   The edition recognizer in `lib/fire-protection.mjs:58–67` does not accept the captured form “NFPA 1, Fire Code — 2012.” It recognizes a year immediately after the designation or explicit “edition” wording, but the intervening title defeats this case. The downstream rule at lines 83–89 then marks the finding unverified and appends an evidence-deficiency note.

   Offline reproduction using the actual saved review output and current validator reproduced the exported jurisdiction, code and NFPA objects exactly. Direct checks of the edition recognizer returned false for the actual title-and-year form and true for a simple “NFPA 1, 2012” control.

   Correcting this recognizer would not automatically establish project applicability. The report's inferred jurisdiction would still cause this finding to be downgraded to inferred under the separate jurisdiction rule. Nor does this example prove every other NFPA downgrade was wrong: many other rows lack an exact edition quotation or depend on project systems that were never specified.

4. **Tool constraints and retrieval inefficiency contributed.**

   Every research request declared `web_search.max_uses = 2`, while the project-level allowance was 40. The run recorded seven `max_uses_exceeded` warnings: three jurisdiction, two contacts, and two codes. The effective restriction therefore interfered while the global search budget was still available.

   [Anthropic's official documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) describes `max_uses` as a per-request cap and documents the associated error. In this run, continued tool-use requests received search-limit errors after earlier successful searches. The exact provider accounting across those continuations needs a focused contract test; it should not be asserted to be a documented whole-conversation cap, nor assumed to reset freshly on each continued HTTP call.

   The source-reading tools have no search-within-document operation and no requested excerpt-length parameter. A PDF page request reads up to eight pages, with up to 24,000 characters returned. Contacts read S30 six times with overlapping windows. Verification then reread saved portions. One verification call used offset 40,000 against a 38,394-character PDF window and returned no text. This is partly a model/tool-use quality issue, but the tool design makes targeted retrieval difficult.

   Seven code reads returned about 100,299 body-text characters plus 36,921 hyperlink-JSON characters. Much of the link payload consisted of repeated legislative navigation. Passing that material through every continuation spends context on content unrelated to the question.

   Three custom retrieval attempts failed: two HTTP 404s and one browser `net::ERR_FAILED` on a DSPS commercial-code URL. The captured Municode page also failed to expose the desired ordinance despite technically successful retrieval. These are genuine access gaps. They do not account for all the uncertainty, because useful evidence was retrieved elsewhere and then omitted from review.

5. **Some uncertainty is appropriate and would survive a better run.**

   The project describes an existing food processing/storage building being converted to a hyperscale data center. `project.context.permitDate` is blank. There is no detailed proposed-system narrative, equipment capacity, building dimensional information or owner/insurer criteria.

   Consequently, requirements involving a fire pump, water tank, underground main, clean-agent system, batteries, generator systems or fuel storage may legitimately be conditional. Online research cannot determine which systems will actually be installed or their relevant quantities. Clarifying permit timing, proposed systems, and existing/proposed occupancy classifications would improve applicability decisions.

   The conflicting building contact is grounded in the captured municipal page: its body names Scott Hussinger while its contact section names Kevin Bohlman. Flagging that inconsistency is appropriate. Resolving who currently handles this project may require another authoritative source or confirmation from the office.

   The final inferred jurisdiction also propagates to code applicability by design. Three governing-code rows were changed from verified to inferred by that rule. This is different from failing to establish that an adoption instrument exists: the program combines the general code fact with its applicability to this particular property.

6. **The displayed counts exaggerate the number of independent problems.**

   Across 37 principal findings, the final report has nine verified, five inferred, 22 unverified and one conflicting. Its 21 NFPA findings have 20 unverified and one inferred status; separately, applicability is one applicable, 12 conditional and eight unresolved. Evidence confidence and project applicability are different dimensions.

   The fire-protection profile creates 14 baseline screening targets and adds seven for the data-center description before the actual system design is known. Conditional rows also count as unresolved in the headline total, even when their evidence is otherwise verified.

   The report has 33 gap entries, but the review model wrote nine. Post-processing added 24: five generic confirmations, three incomplete-stage notices and 16 NFPA confirmations. Many overlap. Therefore, 33 gaps is not a count of 33 independent research failures, and “21 NFPA findings need confirmation” is not a useful standalone measure of model ability.

The most useful improvement sequence is to repair the evidence handling first: preserve task-relevant passages, remove repeated navigation, reuse already retrieved material, and create compact research checkpoints before a context hard stop. Fix the NFPA edition recognizer with positive and negative examples, including cases with multiple standards and years. Then test and adjust the effective search allowance, and add targeted document-search/page-range tools. Keep uncertainty when project facts or authoritative sources are actually missing.

After those changes, rerun the unfinished research on the same project with the same model settings and budget, adding the missing project facts when available. Compare completed stage briefs, decision-relevant citations, denied searches and avoidable unresolved findings. Only then would a controlled model or effort-level comparison meaningfully test whether model capability is the remaining bottleneck. A stronger model could improve navigation or interpretation, but this run cannot isolate that effect from the demonstrated application defects.

Evidence anchors: diagnostics `projects[0]`, `projects[0].stages`, `projects[0].attempts`, `projects[0].activity`, and events with IDs 223, 273, 339; research export `stageBriefs[1..3]`, `stageBriefs[4].findings`, `report.fireStandards[0]`, `report.codes[0].notes`, `report.contacts[0]`, `report.gaps`, `sources`; matching saved database review payload and tool results. Diagnostic event IDs are stable within this export; they are not JSON array indexes.
