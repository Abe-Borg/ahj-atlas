# Two-level trust explanation: implementation report

AHJ Atlas now has a short **Why trust it?** topic in its User guide and footer. Its dossier opens in a second native modal above the topic; Close/Back/Escape returns to the initiating button. The source is `public/trust.js`, with local styles and an audited fact snapshot. There are no new dependencies and no changes to research, billing, source-fetch or credential behavior.

## Inventory

[TRUST_CLAIMS.md](TRUST_CLAIMS.md) was written before copy. It inventories 26 user-action groups and six automatic-behavior groups, each represented by a numbered runtime card with all five required rows. Groups name individual controls that share the same execution/data boundary; authorities/questions are sections of Overview, not invented tabs. Supporting-passage expansion, selectors, save/cancel, exports, deletion, external links, startup migration and OS launch/close are included.

There are two current models for new work: `claude-sonnet-5-5` and `claude-opus-5-5`. Earlier saved research conversations can retain their original model/prefix until rebuilt. Research, evidence-check, final-review and every chat-depth payload are checked against the fact snapshot.

There are three fixed external API hosts: `api.anthropic.com`, `geocoding.geo.census.gov` and `api.github.com`. Network route inventory also includes loopback, variable public source/redirect/rendered-resource hosts and user-followed external links. Public hostnames are an open set; no finite total-host count is claimed. Vendor-side search and external-browser/platform activity are outside an exhaustive app-level firewall guarantee.

## Claims softened or rejected

- “Every output has a declared origin” became inspectable source records, labels and questions. Model summaries/general knowledge need not be cited; labeling is sometimes a prompt instruction.
- “Nothing runs unless you click” became started-work automation with named exceptions: queued startup recovery, model/tool follow-ups, transient research retries, batch polling/cancellation, remembered/unavailable-key checks, packaged release checks, local persistence and UI refresh/error recording. Saving a key requeues waiting projects.
- “Every automated judgment can be re-derived” became reproducible deterministic checks/arithmetic, with non-repeatable model interpretation and changing external sources explicitly excluded.
- “Verified means correct” became a model label plus at least one normalized matching retrieved quote and specific local guards. Semantic/legal applicability and every-field support remain your responsibility; ordinary code rows have weaker edition binding than NFPA rows.
- “Nothing leaves” and “all traffic encrypted” were rejected. Anthropic gets selected context/tool results; Census can receive the address; arbitrary public URLs/queries and renderer resources leave the machine. Public HTTP is permitted. GitHub receives packaged release lookups/version information.
- “A read-only tool cannot leak data” was rejected. Chat gates URL provenance more tightly than research; model-chosen search queries and public URL paths/queries can carry information despite public-IP filtering.
- “Chat changes nothing before Apply” was scoped to proposed project edits. Replies already incur charges and can add sources; approved model-derived answers become user context.
- “Keys never appear in stored content” was scoped to the dedicated credential field. Arbitrary secrets pasted into notes/chat/URLs are not automatically excluded.
- “Secure storage protects everything” was rejected. DPAPI protects remembered Windows key bytes for that OS account; SQLite project/transcript content is not encrypted by the app and same-account/local processes remain relevant.
- “Stop immediately cancels/refunds” was rejected. In-flight work is drained/saved, submitted batches may continue, completed usage is estimated as a charge and unknown outcomes retain reservations.
- “Bounded work means bounded money/time” was rejected. There is no app spending cap or strict total-duration deadline. Socket timeout is idle time; key/batch retries do not have a small finite total count; chat has one active reply per project but no global cross-project cap.
- “Export is a complete backup” and “delete erases every copy” were rejected. JSON omits chat/raw request/tool records, source excerpts are capped, project records have no age purge, uninstall keeps data, and row deletion is not a secure wipe of WAL/backups/exports/vendor data.
- “No training/vendor retention” and “no Chromium background egress” were not asserted. No app training/upload/sync path was found, but app code cannot enforce vendor policies or all platform/browser behavior.

## Findings and same-claim disagreements

The limitations above are behavior findings, not engine fixes. They remain as implemented and are described honestly. The ledger supplies exact symbols, bounds, storage and verification references.

Copy-only corrections:

- Footer “Every finding traceable” → “Evidence to inspect. Questions to resolve.”
- API settings said connecting checks research-model access. It checks the Models API list; capability checks occur before individual generation requests. The settings sentence now says that.
- README/UI broadly said nothing changes before Apply; wording now names proposed edits and source/cost exceptions.
- README claimed prompt-rule “never” as behavior; it now distinguishes instruction from enforcement.
- README referred to `document.modelContext` tools, but shipped first-party code does not register them. Removed that reference; no such capability was added.
- README/help key-storage absolutes now distinguish the key field from arbitrary pasted secrets.
- Help's source data location now distinguishes source and packaged Windows defaults and states unencrypted/raw content retention. Help's batch-pricing statement now names the real-time chat exception.

The README's old-model continuity statement was initially investigated and found supported by researchPayload's saved-prefix branch. It is not reported as a contradiction. Existing evidence-help cautions already agree with the new qualified definition. Historical dated review/planning documents were not treated as current implementation contracts; their intentions are not new trust claims.

## Sections and presentation

No section was dropped. The requested order and all 12 sections are preserved. App-specific title changes:

| Requested | Dossier title |
|---|---|
| The short answer | The short answer |
| Where the output comes from | Where your findings come from |
| What the engine actually is | What actually does the work |
| What leaves your computer, and where it goes | What leaves your computer, and where |
| What runs when you click | What runs for each action (also includes automation) |
| What the AI may touch, and what it cannot | What the AI may touch |
| What the key terms mean, exactly | What the trust labels mean |
| The parts with no AI in them | The work done without a model |
| Security and privacy, mechanism by mechanism | Security and privacy mechanisms |
| Money | Who charges you and what the meter means |
| What this does not do | What this does not do |
| Check it yourself | Check it yourself |

The short topic has seven points, mechanisms and the exact requested closing/button copy. The dossier has an inline accessible SVG with dashed optional/automatic routes, provenance/engine/tool/security/money tables, 32 uniform cards, limitations and practical audits. It uses local app styles/tokens, native dialogs, one vertical scroll, a wide-screen sticky current-section rail and narrow/dark styles. No external assets, fetches or analytics were added to the trust components; only further-reading anchor links are external.

## Validation and remaining gaps

- Nine new trust tests pass. The full run has 221 passing tests of 222 (one failure, no skips). Trust tests cover exported settings, inline numeric bounds/hosts/storage paths, every stage/chat-depth request, ledger/card coverage, five rows and explicit local `None.`, local assets/routes, short-topic length, both entry points and hash entry, stacking, native focus containment and return, one-level Escape, close/back, contents clicks/scroll highlighting, and wide/narrow light/dark layouts. Browser requests are confined to the synthetic local app; no paid requests made.
- Linux test Chromium uses `--no-sandbox` only for its disposable synthetic local-page harness because the container's Chromium sandbox prerequisites are unavailable. Production `ResearchTools.render` and Electron `sandbox:true` remain unchanged. This does not establish that the production research renderer can start on this Linux instance.
- `npm run check` passes. The full suite has a known pre-existing `tests/desktop.test.mjs:155` failure: Windows fixture paths are compared with Linux-native `path.join`, producing a slash mismatch. It was present before this task and was not fixed, skipped or suppressed here.
- `npm run package:win:dir` was executed and rejected this Linux machine as designed by `scripts/build-windows.mjs`. Windows x64 package/installer validation is outstanding on the documented Windows runner. No passing build is claimed.
- The maintenance rule and file/test links are in README. Dependency manifests and lockfile are unchanged.

No blocking product/copy questions remain. The acceptance conditions for a fully passing existing suite and Windows build cannot be claimed from this Linux instance; run the documented Windows CI job to close that gap. Stronger quote semantics, URL confidentiality controls, encrypted/expiring project storage or a spending cap would be separate behavior changes, not silent changes to this trust-document task.
