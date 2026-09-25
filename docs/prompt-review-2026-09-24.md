# AHJ Atlas prompt review — September 24, 2026

The existing prompts were strong on the substance: official sources, exact code editions, adoption chains, explicit uncertainty, separate verification, NFPA screening, and bounded completion. Targeted revisions were justified by conflicting instructions and gaps in how evidence was interpreted. This review does not establish a measured improvement in model accuracy.

## Guidance consulted

The supplied [use-case overview](https://platform.claude.com/docs/en/about-claude/use-case-guides/overview) is an index. Its [legal summarization guide](https://platform.claude.com/docs/en/about-claude/use-case-guides/legal-summarization) is relevant to extracting precise, cited findings from regulatory documents and evaluating their accuracy.

Anthropic's [prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) recommends explicit instructions, separated context, examples, and placing the request after long evidence inputs. Its [hallucination guidance](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations) recommends uncertainty, passage-based grounding, and checking citations against claims.

The [Sonnet 5 guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5) emphasizes explicit scope and evaluating prompt changes. The [Opus 5.5 guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) supports explicit completion conditions, bounded continuations, and preserving signed conversation prefixes. Atlas already implements those controls.

## Findings and revisions

| Finding in the existing implementation | Revision |
| --- | --- |
| Shared instructions told the final reviewer to use external research tools and produce a prose brief, despite its saved-evidence tools and JSON output requirement. | Shared instructions now contain evidence policy. Research stages and the final reviewer get their own workflow and output instructions. The review-specific NFPA supplement also refers to saved evidence. |
| Instructions and saved evidence were interleaved, sometimes putting long source packages after the assignment. | Research and review requests place delimited evidence first and the assignment last. Literal markup in source/project data is JSON-escaped without changing the underlying evidence. |
| Exact quotations were required, but the distinction between matching text and proving every material claim needed emphasis. | Select the supporting passage before drafting; check scope, exceptions, dates, and each necessary adoption link. One short example distinguishes an office's review responsibility from evidence of an adopted edition. |
| `readFull` could be read as meaning the entire document was available. | Explain that it records retrieved text and does not establish full-document coverage. A failed lookup or silent excerpt does not prove absence. |
| Date and conflict handling needed a more explicit decision rule. | Relate applicability to the supplied permit date; separate current rules, enacted future changes and proposals. Resolve apparent conflicts through dates, scope and supersession. Define the four evidence statuses. |
| Verification could spend its allowance treating all gaps alike. | Prioritize jurisdiction and adoption/edition claims that change a design or permit decision, then consequential contact and process gaps. Require cited corrections. |
| Chat could imply that saved findings were freshly checked. | Answer directly from saved passages and describe currency using saved research/source dates. State concrete missing evidence and next steps. |

The contact prompt now distinguishes approving authorities from contracted reviewers and avoids unsupported project-specific fee calculations. The NFPA instructions explicitly check table headings, row labels and footnotes before assigning an edition.

## Retained behavior

The five stages, models, effort settings, budgets, tool permissions, report schema, source validation and NFPA targets are unchanged. Active signed conversations keep their original prompts; new conversation segments use the revisions after the backend loads the updated code. Existing reports are not regenerated automatically. The read-only replay utility accepts both the old JSON-only context and the new evidence wrapper.

No generic request to expose internal reasoning was added. No additional agent or paid evaluation was started. Context delimiters improve readability; they are not a security guarantee and do not replace the existing tool restrictions.

## Validation and remaining uncertainty

The full deterministic suite passed (113 tests), along with syntax checks. It covers research/review workflows, signed continuation, recovery, budgets, NFPA requirements, chat isolation and exports. A new test checks context serialization with embedded markup; an additional replay check exercises both saved request formats. These checks use synthetic sources and fake model responses, so they establish application compatibility, not better Claude research quality.

Before claiming an accuracy gain, compare original and revised prompts using fixed evidence, the same models and budgets, and repeated runs. Anthropic's [evaluation guide](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests) recommends measurable, task-specific criteria and comparison against a baseline.

Suggested evaluation cases (not run with a live model):

| Case | Required behavior |
| --- | --- |
| Mailing city differs from official authority evidence | Identify the actual authority or explicitly leave jurisdiction unresolved. |
| Adoption clause and reference-table edition are in separate sources | Cite both links and preserve the exact standard edition. |
| Office responsibility is cited as proof of a code edition | Keep the responsibility; reject the unsupported edition. |
| Current edition, enacted future edition, and permit date differ | Apply the relevant transition rule or identify the missing date/fact. |
| Late document passage is omitted from the initial excerpt | Retrieve the relevant saved passage before declaring evidence missing. |
| NFPA table contains adjacent standards, years and footnotes | Associate the correct designation, edition and qualification. |
| User answer or dismissal contradicts a saved finding | Treat it as project context or priority, without converting it to source evidence. |
| Conflicting official sources or a scan-only claim | Preserve the conflict or qualification and specify the missing resolution. |

Score correct material claims, unsupported claims marked verified, required coverage, citation relevance, actionable gaps, request count and actual cost. Reject a revision that gains brevity by dropping required coverage. Keep novel, unambiguous cases separate from examples used while tuning. Live outcome quality remains unmeasured.
