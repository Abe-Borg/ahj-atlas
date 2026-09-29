# AHJ Atlas review against the Sonnet 5.5 and Opus 5.5 prompting guides — September 29, 2026

Atlas already followed most of the guidance in the two model-specific prompting guides. The most important gap was a regression from the September 28 switch to Sonnet 5.5. That change swapped only the model ID. On the 5.5 models, the notes Claude writes between tool calls arrive as `thinking` blocks, and at the default display those blocks are empty. The app still read those notes from `text` blocks, so research checkpoints lost most of their interim observations. This review fixes that and makes three smaller prompt and handling changes. It does not claim any measured accuracy gain.

## Guidance consulted

- [Prompting Claude Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5): effort calibration, initiative and scope, JSON reasoning tasks, progress updates, tool use in knowledge work, mid-turn messages, tolerant tool calls, visual inputs, refusals.
- [Prompting Claude Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5): effort calibration, unattended agentic runs, progress updates, time signals, chat thinking instructions, pasted text, visual inputs.
- [Thinking — progress updates](https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates) and the [Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide#text-between-tool-calls), which say that Sonnet 5 returned between-tool text as `text` blocks and the 5.5 models return it as progress-update `thinking` blocks.
- [Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing), which confirms that batches accept most beta features through the batch-creation header.

## Changes

| Guide point | What Atlas did before | Change |
| --- | --- | --- |
| Between-tool notes are progress-update `thinking` blocks, empty at `display: "omitted"` (both guides, migration guide) | Checkpoints collected observations from assistant `text` blocks only. Since the Sonnet 5.5 switch, longer notes were lost from fresh-context handoffs and incomplete-stage findings. | Research and evidence-check requests set `display: "updates"` and send the `thinking-display-updates-2026-08-18` beta header with generation, token-count and batch requests. Non-empty `thinking` blocks count as checkpoint observations and are logged once to **Activity**. The fixed "interrupted" placeholder note is ignored. |
| Unattended runs: name the early stops to avoid and the stops you want (Opus guide) | The research prompt said to finish coverage before stopping. It did not tell Claude that nobody can answer mid-stage. | A final `<unattended_run>` system section, adapted from the guide's example, names the four early-stop patterns. It says to put status notes with the next tool call and to end only through `finish_research`, recording blockers as targeted questions. Signed in-flight conversations keep their original system prompt, so the text reaches only new conversations, as the guide recommends. |
| Treat a text-only end of turn as a report and name the open items in the follow-up (Opus guide) | Each of the two continuations used the same generic reminder. | The reminder now names the coverage areas this stage still owes, plus the NFPA checklist for fire-protection projects, and lists up to five open questions from `save_progress`. The two-continuation cap is unchanged; the guide recommends two or three. |
| Check changeable specifics with tools even when confident (Sonnet guide, knowledge work) | The evidence rules said that model memory is not evidence, but did not tell Claude to look things up anyway. | Research workflow: "Check details that change over time … against current sources even when you feel confident." Chat, which has no web access: take editions, amendments, dates, fees, contacts and requirements from the project records rather than general knowledge. |
| Handle `stop_reason: "refusal"` and its category (both guides) | Research already reported refusals. Chat showed a generic "did not finish a usable reply." | Chat stops with **Limit reached** and names the refusal category. |

Diagnostics request summaries now also record `thinkingDisplay`.

## Already aligned (no change)

- **Effort is explicit per stage.** Opus 5.5 runs at `medium`, its new default, which the guide says matches or beats Opus 5 at `high`. Sonnet research runs at `high` for jurisdiction and codes and `medium` for contacts, which fits "medium for well-specified multistep tool use, high for harder work."
- **Thinking is adaptive everywhere.** No prompt asks Claude to write out its reasoning, which would invite `reasoning_extraction` declines. The chat prompt forbids revealing thinking.
- **Structured-output truncation.** A final-review response that stops at `max_tokens` is treated as failed and retried once, even if its text parses.
- **Stable prefixes.** Signed conversations reuse their original model, system prompt and tools. The app starts a fresh context rather than changing `tools` mid-conversation.
- **Responses are read by block type.** Nothing assumes the first content block is text.
- **Tool-name or parameter drift.** Every custom tool is `strict: true`, so names and inputs are schema-checked. The case-tolerant handling the Sonnet guide suggests isn't needed.
- **Continuation cap.** Unattended loops stop after two automatic continuations.

## Considered and not changed

| Guide point | Reason |
| --- | --- |
| Chat is latency-sensitive: start at `medium` or `low` effort (Sonnet guide) | Chat answers are regulatory Q&A where accuracy matters more than time to first token. Change this only after comparing answer quality on saved projects. |
| Leave room for thinking in `max_tokens` (both guides) | Chat allows 8,000 output tokens at `high` effort, which is tight. Raising it to 16,000 adds about $0.08 to each request's reservation, so many replies would no longer fit the $0.25 minimum reply allowance. First check diagnostics for how often chat stops on `max_tokens`. Research (60k) and review (100k) are well above observed use; the largest MKE40 research response was about 5k tokens. |
| "Think the problem through before you answer." for JSON reasoning at `low`/`medium` effort (Sonnet guide) | This guidance is for Sonnet 5.5. The JSON-output final review runs on Opus 5.5, whose guide gives no equivalent. It's a candidate for a controlled comparison, not a blind change. |
| Per-step harness text after tool results can be misread as injection (Sonnet guide) | Chat appends a short remaining-requests note after tool results, at most three times per reply. The misread concerns genuine mid-turn user messages, which Atlas doesn't allow. |
| Mark pasted text with `<pasted_content>` tags (Opus guide) | Chat runs on Sonnet, its tools are read-only and project-bound, and the app can't tell typed text from pasted text without new UI. |
| Time signals for multiagent harnesses (Opus guide) | Atlas isn't a multiagent harness. The advice also means adding per-step text after tool results. |
| Crop or zoom tools and higher resolution for dense visuals (both guides) | `inspect_pdf` renders scanned pages up to 1,500 px on the long side. A region or zoom option could help with dense scanned adoption tables. Consider it if visual-only findings show up as a recurring gap. |
| Explore context in multi-app workflows, frontend design defaults, running without up-front thinking | Not applicable. |

## Validation

Under Node 24 (the project's required runtime), 190 of 191 deterministic tests pass, and so do the syntax checks. The one failure is the existing Windows DPAPI path test, which fails the same way before and after these changes on a non-Windows host. New tests cover:

- The beta header is sent with generation, token counts and batches only when the payload uses `display: "updates"`.
- Research payloads use the updates display and the unattended section; review and chat keep `omitted`.
- Progress notes are recorded once in Activity and in checkpoints, including when an apply is resumed; empty and interrupted notes are ignored.
- The continuation reminder names the owed coverage and saved questions.
- Chat refusals name their category and stop further requests.

No paid API requests were made. The beta header and display value follow the published documentation and have not been exercised against the live API from this environment. Run one real-time research stage and one batch stage, and confirm that progress notes appear in **Activity**, before relying on them.

## Suggested evaluations (not run)

Compare against the previous prompts using fixed saved projects, the same models and budgets, and repeated runs:

- **Stage completion:** how many stages end partial after two continuations, and how many continuations are used. The unattended instruction and the named follow-ups should reduce both.
- **Fresh-context quality:** whether briefs finished after a context reset keep findings that were only in interim notes.
- **Currency checks:** how many edition, amendment or fee claims cite a source retrieved in this run rather than restating a lead.
- **Chat at `medium` versus `high` effort:** citation correctness, unsupported claims, time to first token, and cost per reply.
