# Deeper project chat and cost estimates without spending limits

Two changes: project chat gets far more room to work, and dollar spending limits are replaced by cost estimates everywhere in the app.

## Project chat

| Setting | Before | Now |
| --- | --- | --- |
| Output per request, including thinking | 8,000 | 64,000 |
| Counted input per request | 60,000 | 400,000, lowered if the Models API reports a smaller context window |
| Requests / lookups per reply | 4 / 8 | 20 / 60 |
| Characters per lookup | 12,000 | 24,000 |
| Lookup time per reply | 5 minutes | 20 minutes, then a final answer with at least 10 minutes to stream |
| Message length | 6,000 | 30,000 (request body cap raised from 32 KB to 256 KB) |
| Conversation history | 30,000 characters, answers cut to 12,000 | 200,000 characters, full answers, sent as real turns |
| Citable excerpts preloaded | 6 sources, 2,000 characters each | every retrieved source, 160,000 characters shared as in the final review |
| Model and effort | Sonnet 5.5, high | per message: Standard (Sonnet 5.5, high), Deep (Sonnet 5.5, max) or Opus (Opus 5.5, xhigh) |
| Prompt cache | 5 minutes, evidence only | 1 hour, evidence and earlier turns |

Sonnet 5.5 and Opus 5.5 have 1M-token context windows and 128K output limits and support `low` through `max` effort. The capability preflight now also checks the chosen effort level. Opus 5.5 defaults to `medium`, so the effort is always set explicitly.

**Wrap-up instead of hard stops.** A reply used to end as "Limit reached" with no answer when the model asked for one lookup too many or called a tool on its last request. Now every requested lookup gets a result (an error once the allowance is spent), and the last request sends `tool_choice: {type: "none"}` with an instruction to answer from the evidence gathered. Forced `any`/`tool` choices return a 400 on these models; `none` is unaffected and compatible with adaptive thinking. Changing `tool_choice` invalidates the cached messages for that one final request.

**No per-lookup countdown.** The old loop appended "N requests and M lookups remain" after every tool result. Anthropic's Sonnet 5.5 guidance warns that harness text after every tool result can be read as a prompt-injection attempt. The app now sends at most two mid-conversation `role: "system"` messages, which Sonnet 5.5 and Opus 5.5 support without a beta header: one advance notice near the limits, and the final instruction. Tool results carry only results and citation metadata. As Anthropic's documentation recommends, if a model rejects the role (a 400 saying `role 'system' is not supported`), the notes are added to the pending user turn as `<system-reminder>` text after the tool results. The switch happens at the free token count, before any paid request carries a note.

**Prompt.** The limits in the system prompt now come from the configuration. "Answer concisely" is replaced by depth matched to the question. Following the Sonnet 5.5 notes on tool use in chat, the prompt tells the model to check specifics with its tools even when confident. General professional knowledge is allowed when labeled and kept apart from project evidence; for a code or standard it must name the edition and defer to the AHJ-adopted edition. Tables stay off because the chat renderer shows only paragraphs, bullets and bold text.

**Caching.** Evidence is followed by earlier turns as real user/assistant messages, each ending at a one-hour cache breakpoint; the time-stamped current context comes last. A follow-up reuses the previous request's history prefix. One-hour writes cost twice the input price ($4/MTok on Sonnet 5.5, $8/MTok on Opus 5.5); reads cost $0.20/MTok on both. A user who asks a follow-up within the hour pays for cache reads instead of rewriting the evidence and history. The request uses three breakpoints: evidence, history, and automatic caching of the tail.

**Concurrency.** Chat no longer occupies one of research's two task slots, so it stays available during research. Research still cannot be continued or corrected on a project while that project's chat reply runs. An uncertain chat charge no longer blocks new messages; it stays pending until reconciled in Activity.

## Spending limits removed

Project budgets, the daily allowance, the per-reply chat allowance and the final-report hold are gone from the engine, store, HTTP API and GUI. The request ledger remains: each request records an estimated pending cost before it is sent and its actual cost afterwards. The project header shows the estimated cost to date, and chat shows the project total, the chat share and each reply's estimate. **API & spending** shows today's, all-project and pending estimates, including charges from deleted projects. The 40-search, 100-read, round and time limits remain as runaway guards. For a hard cap, users can set a workspace spend limit in Anthropic Console; the provider already reports that limit.

On upgrade, projects stopped at a former limit become **Needs attention** with an explanatory note. They wait for an explicit **Continue research** or **Finish with saved evidence** and never resume spending on their own. Saved budget settings are ignored, and the retired `budget`, `final_hold` and `allowance` columns stay for older databases.

## Validation

`npm test` on Node 24.21.0: 188 tests, 187 pass. The failure is the existing desktop path test, which expects Windows path joining and fails on Linux both before and after this change. New tests cover each reply depth, the capability check for the chosen effort, cached history as conversation turns, wrap-up at the lookup, request and time limits, context-window lowering, cost recording without limits, chat running beside research, the spending summary, and the legacy status migration. The browser checks (`chat-ui`, `questions-ui`, `delete-project-ui`, `address-correction-ui`, `connection-ui`, `update-ui`) pass in headless Chromium. All of these use synthetic data and fake model responses; no paid requests were made.

## Not yet verified against the live API

- Token counting and streaming with a mid-conversation `role: "system"` message and `tool_choice: none` after tool results. The documentation says both are supported on these models, and a rejected system role falls back to user-turn reminders.
- A first message with many citable excerpt blocks (about 300 at the 160,000-character bound).
- The effort capability flags returned by the Models API for `max` and `xhigh`.

A short live check should send one Standard, one Deep and one Opus message on a researched project, with a follow-up within the hour, and compare the Activity cache-read counts.

References: [models](https://platform.claude.com/docs/en/models/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [pricing](https://platform.claude.com/docs/en/about-claude/pricing).
