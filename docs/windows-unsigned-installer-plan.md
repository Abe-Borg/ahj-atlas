# AHJ Atlas unsigned Windows installer implementation plan

## Purpose

This is the execution plan for turning the existing local Windows application into an installed desktop application distributed through GitHub Releases. The finished product must preserve the current AHJ Atlas behavior and data model while replacing the end-user requirement to install Node.js, run `npm ci`, and use the Start/Stop command files.

The target artifact is an **unsigned, per-user Windows x64 installer**. It must install without administrator privileges, add a Start menu entry, appear in Windows Installed Apps, launch AHJ Atlas in its own desktop window, and uninstall cleanly. Code signing, Microsoft Store publication, automatic updating, macOS/Linux packages, and product redesign are explicitly out of scope.

This plan is intentionally divided into one-PR sessions. Each session must leave the branch tested and reviewable. Do not combine later sessions merely because implementation is going well.

## Non-negotiable product requirements

1. All existing research, chat, questions, diagnostics, exports, spending controls, source retrieval, browser rendering, persistence, and recovery behavior must remain available.
2. The installed application must not require a separately installed Node.js runtime or an `npm install` performed by the user.
3. The application must use a dedicated Electron window rather than opening the user's normal browser.
4. The existing loopback HTTP architecture should be retained for this project. Do not rewrite the frontend/API boundary as Electron IPC unless a documented blocker makes that unavoidable.
5. Mutable data must live outside the installation directory in the current user's application-data area and must survive application upgrades and a normal uninstall.
6. Only one instance may use a workspace at a time. A second application launch should focus the existing window rather than displaying a database-lock failure.
7. API keys must retain the current Windows DPAPI protection and must never be exposed to the renderer, logs, installer, GitHub Actions, or release artifacts.
8. The Electron renderer must have Node integration disabled, context isolation enabled, and sandboxing enabled. External web content must never replace the application page in the privileged desktop window.
9. The installer and executable will be unsigned. Documentation must plainly explain the Windows "Unknown publisher" / SmartScreen experience and must never advise users to disable security software.
10. Production releases will be attached to GitHub Releases. The workflow must also emit SHA-256 checksums.
11. No automatic updater is required. Updating means running a newer installer over the existing per-user installation. The user's data must remain intact. (Since 1.7.0, the installed app can download and checksum-verify that installer and run it after the user chooses **Restart and install**; nothing downloads or installs without that choice. See the README's In-app updates section.)
12. Existing source-development commands should continue to work. The `.cmd` launchers may remain for developers or source users, but they are no longer the supported installed-user entry point.

## Current architecture the implementer must understand first

- `server.mjs` exports `createApp({ dataDir, port, provider, worker })`, binds a loopback server, returns its actual URL, and exposes an asynchronous `close()` method. This is the integration seam for Electron.
- The server currently serves the static files under `public/` and enforces host/origin checks plus a per-process mutation token. Preserve those controls.
- `lib/store.mjs` uses the Node built-in `node:sqlite` `DatabaseSync` API and creates `atlas.sqlite` in the supplied data directory.
- `lib/key-vault.mjs` uses Windows DPAPI through PowerShell and defaults to `%LOCALAPPDATA%\AHJ Atlas\credential.bin`.
- `lib/research-tools.mjs` dynamically imports `puppeteer-core` and locates an installed Edge or Chrome executable. The installed build must preserve this behavior.
- The frontend uses normal same-origin navigation and attachment downloads for PDF, XLSX, JSON, and diagnostic exports.
- The current `launcher.mjs` starts a detached Node backend and opens the system browser. The desktop build must not call this launcher; it should import `createApp()` directly.
- The package currently requires Node 24 or newer and includes native/runtime-sensitive dependencies, notably `node:sqlite` and `@napi-rs/canvas`. Electron runtime compatibility is therefore a release-blocking gate, not an assumption.

Before editing code, read the repository's applicable `AGENTS.md` files, `README.md`, `package.json`, `launcher.mjs`, `server.mjs`, `lib/store.mjs`, `lib/key-vault.mjs`, `lib/research-tools.mjs`, export routes, and existing tests.

## Fixed technical direction

Use **Electron** as the desktop shell and **electron-builder with NSIS** for an unsigned, per-user installer, unless the compatibility spike proves that this combination cannot satisfy a requirement. A change of packager must be documented in this plan's decision log before implementation continues.

The expected process model is:

```text
AHJ Atlas.exe (Electron main process)
  -> obtains Electron single-instance lock
  -> chooses a stable per-user data directory
  -> runs first-launch migration detection/import before creating the destination Store
  -> imports createApp() from server.mjs
  -> starts createApp({ dataDir, port: 0 })
  -> opens a sandboxed BrowserWindow at the returned loopback URL
  -> handles downloads and external links
  -> calls backend.close() during application shutdown
```

Use `port: 0` so Windows chooses a free ephemeral loopback port. Do not depend on port 4318 in the installed application.

The intended persistent layout is conceptually:

```text
%LOCALAPPDATA%\AHJ Atlas\
  data\atlas.sqlite
  data\instance.lock
  credential.bin
  logs\desktop.log (only if a desktop log is actually needed)
```

Use Electron's Windows `userData`/app-data path APIs rather than hand-building paths when practical, but ensure the selected product name produces a stable path. Do not write mutable state into `resources`, `app.asar`, the installer directory, or `Program Files`.

## Progress tracking rules

This document is the durable progress tracker. Every implementation PR must:

1. Update the session table below: set the current session to `IN PROGRESS` when work starts and `COMPLETE` only when all exit criteria pass.
2. Check completed checklist items in that session.
3. Add a short entry to the decision log for any implementation choice that future agents need to understand.
4. Add unresolved problems to the blocker/handoff log. Never mark a partially satisfied exit criterion complete.
5. Include the plan update in the same PR as the corresponding implementation.
6. Use exactly one implementation PR per session. Do not start the next session in the same PR.

### Session status

| Session | Scope | Status | PR / notes |
|---|---|---|---|
| 1 | Electron compatibility spike and runnable development shell | COMPLETE | Windows x64 source-mode shell and fake-provider smoke passed; [PR #4](https://github.com/Abe-Borg/ahj-atlas/pull/4). |
| 2 | Production desktop lifecycle, security, data paths, and migration | COMPLETE | Windows x64 source-mode lifecycle, safe legacy import, and credential isolation passed; [PR #5](https://github.com/Abe-Borg/ahj-atlas/pull/5). |
| 3 | Downloads, external navigation, desktop UX, and regression coverage | COMPLETE | Windows x64 source-mode export, navigation, UX, and regression checks passed after rebasing on updated `main`; [PR #6](https://github.com/Abe-Borg/ahj-atlas/pull/6). |
| 4 | Unsigned NSIS installer and installed-app validation | COMPLETE (accepted) | [PR #7](https://github.com/Abe-Borg/ahj-atlas/pull/7) merged. The user accepted the completed build, install, upgrade, uninstall, and installed-app checks as Session 4 done; a fresh Windows machine without Node.js remains unverified and carries into the release gate. |
| 5 | GitHub release automation, checksums, documentation, and release candidate | IN PROGRESS | [PR #8](https://github.com/Abe-Borg/ahj-atlas/pull/8). Draft-release and exact-download acceptance require the workflow on merged `main`. |

### Decision log

| Date | Session | Decision | Reason |
|---|---|---|---|
| 2026-09-28 | Planning | Electron + electron-builder/NSIS; unsigned per-user x64 installer; manual upgrades through GitHub Releases | Meets the requested zero-fee deployment model while reusing the existing Node/web application. |
| 2026-09-28 | Planning review | Run legacy-import preflight before `createApp()` and use a WAL-aware SQLite snapshot staged and validated before promotion | `Store` creates the destination database immediately and enables WAL, so post-start detection or copying only `atlas.sqlite` can skip migration or lose committed records. |
| 2026-09-28 | 1 | Pin Electron 44.4.5 and electron-builder 26.15.3; retain the in-process backend | Electron 44.4.5 embeds Node 24.21.0. On Windows x64, `node:sqlite` read/write and `@napi-rs/canvas` native load passed in Electron, so no runtime fallback or sidecar is needed. |
| 2026-09-28 | 1 | Keep a temporary, separate development profile; start `createApp({dataDir,port:0})` and load its loopback URL in a sandboxed BrowserWindow without preload | Avoids a real workspace during the spike while preserving the existing HTTP boundary. Production paths, migration, navigation policy, downloads, and packaging remain in their assigned sessions. |
| 2026-09-28 | 1 | Use Electron's single-instance lock and await `backend.close()` before quit; do not top-level await `app.whenReady()` in the ESM entry point | Windows close/relaunch removed `instance.lock`; awaiting readiness at module top level stalled Electron startup, so the lifecycle promise is started without top-level await. |
| 2026-09-28 | 1 | Use installed Chrome for the optional reader smoke | `browserPath()` found `C:\Program Files\Google\Chrome\Application\chrome.exe`; `ResearchTools.render()` ran in the Electron main process against public `example.com` without bundling a browser. |
| 2026-09-28 | 2 | Set packaged Electron `userData` to `%LOCALAPPDATA%\AHJ Atlas`; put SQLite under `data` and keep DPAPI `credential.bin` at the existing root | Keeps both mutable stores outside installation files, stable across upgrades, and avoids a duplicate product-name segment. Source-mode profiles stay disposable. |
| 2026-09-28 | 2 | Import before `createApp()` using `node:sqlite` online backup, a temporary legacy `instance.lock`, staged `Store`/integrity validation, and same-volume rename | A consistent snapshot includes committed WAL rows, refuses an active source, leaves original database/journals in place, and never merges into an initialized destination. A decision marker records a deliberate fresh start. |
| 2026-09-28 | 2 | Constrain the window to the runtime loopback origin, validate public external links before sending them to the system browser, deny child windows/permissions, and drain the backend on close/crash/session end | Preserves the HTTP security boundary and prevents external content from replacing the app page. Close confirmation explains that local requests finish before exit while submitted batches may continue at the provider. |
| 2026-09-28 | 2 review follow-up | Reclaim a verified-stale legacy source lock before importing; include persisted dispatching and pending attempts in close detection | A crashed source installation must not block safe import forever, and submitted batches remain active between poll calls even when worker sets are empty. |
| 2026-09-28 | 3 | Stage only approved loopback attachments in private temporary files, then use a native Save dialog and exclusive final copy | Electron's `setSaveDialogOptions()` still saved directly to Downloads in the Windows smoke. Staging keeps an explicit destination choice and `COPYFILE_EXCL` prevents silent overwrite even if the selected path collides. Completion, cancellation, and errors use accessible native notices; renderer code never receives local paths. |
| 2026-09-28 | 3 | Preserve safe Unicode filenames through RFC 5987 `filename*`; derive backend and diagnostics version from `package.json`, and launch development Electron through the package entry point | Keeps server filenames and extensions consistent in native Save, allows names with spaces and Unicode, and makes Electron `app.getVersion()` match `/api/bootstrap`, Diagnostics, and future installer metadata. Existing Diagnostics already provides the version, so no new About screen is needed. |
| 2026-09-28 | 3 review follow-up | Reject Windows device names when they precede a dot, including COM/LPT superscript-digit aliases | `CON.txt` and `LPT1.backup` remain reserved on Windows; replacing these project-name stems before building the attachment name prevents interrupted desktop downloads. |
| 2026-09-28 | 4 | Use an explicit electron-builder configuration, a stable `org.ahjatlas.desktop` identity, current-user NSIS settings, and an ASAR content audit | Explicit configuration prevents local `test-results` from entering the package; the audit checks native unpacking, production dependencies, and exclusion of credentials, test fixtures, and development files. |
| 2026-09-28 | 4 | Generate a seven-resolution Windows icon from the existing AHJ Atlas favicon; ship no signing identity | Keeps the established project branding and makes the unsigned publisher state explicit. The generated 256 px icon and installed window were inspected. |
| 2026-09-28 | 4 | Keep the Electron window alive while `backend.close()` drains, then call `app.exit(0)` | The first packaged close destroyed the window before asynchronous cleanup, leaving `instance.lock` behind. The revised sequence exits cleanly in source, unpacked, and installed builds. |
| 2026-09-28 | 4 | Use version 1.5.0 as the older upgrade fixture and 1.5.1 for this installer; package one synthetic fixture only in the disposable unpacked smoke build | Allows a real in-place upgrade and full fake-provider smoke without including tests in the production installer or making paid calls. |
| 2026-09-28 | 4 acceptance | Treat Session 4 as done on the user's decision after its completed build/install/upgrade/uninstall/installed-app checks | This records acceptance of the completed installer work, not a claim that a separate fresh Windows system without Node.js passed. That test remains a Session 5 release gate. |
| 2026-09-28 | 5 | Run one Windows workflow on PRs with read-only permissions; create a draft release only through a manual dispatch on `main` after rebuilding and verifying the artifact | Keeps untrusted PR code out of the release-writing job and ensures release files come from the successful release-commit run. Action references are pinned to upstream commit SHAs; maintainers review them at each release. |

### Blocker and handoff log

Add dated entries here when a problem is left for a later session. Include exact reproduction commands and relevant file paths. Write `None` when a completed session leaves no known blocker.

2026-09-28, Session 1: None. Windows x64 source-mode checks passed. The unpacked and installed application remain untested until Sessions 4–5 as planned.

2026-09-28, Session 2: None. Source-mode Windows lifecycle and disposable legacy import passed. The installed/package boundary remains assigned to Session 4. The Windows command sandbox prevented Chromium's child renderer from loading; live window checks passed when the disposable Electron run was launched outside that command sandbox.

2026-09-28, Session 3: None. PR #5 merged and the Session 3 branch was rebased on updated `main`. Automated, browser UI, and live source-mode Electron checks passed after the review fix; the native Save flows were also exercised on the preserved Session 3 branch before rebase. Installed/package validation remains in Session 4. Windows desktop tests used a disposable fake-provider profile and export directory outside the command sandbox.

2026-09-28, Session 4: A separate clean Windows account or VM without Node.js installed was not available. The installer was freshly installed and upgraded under the current user's medium-integrity, non-elevated token, with an isolated disposable application-data profile under `test-results/session4-installed-user`; Node.js was removed from `PATH` for installed-app launches. The machine has a real credential in its normal profile, which was never used for these checks and retained its SHA-256 hash. The user accepted Session 4 on the completed installer checks. The unchecked clean-account/Node-free-system tests are **not passed** and remain mandatory before release publication: download the exact candidate installer from the draft GitHub Release, confirm `where.exe node` finds nothing on a separate standard-user Windows x64 environment, install without elevation, and launch from the Start menu. All other Session 4 checks passed locally. The test installation was removed; the disposable data profile remains ignored by Git.

2026-09-28, Session 5: GitHub's manual `workflow_dispatch` trigger requires the workflow file on the default branch. The Session 5 PR can exercise its read-only build job, but its draft-release job and exact draft-download checks require the PR to be merged. Keep Session 5 IN PROGRESS until the draft and release-gate tests pass; do not publish automatically.

2026-10-01, 1.8.0 release preparation: The latest published release is `v1.7.0` at `393fe557b7a5e6b0fbaf2847d407c29e63ddc815`. Release preparation includes the 11 subsequent commits through `10d8c7656297c32163c6e82d4e50b79de67412e4` (PRs #26–#28), matching 1.8.0 package/lock metadata, and `docs/releases/1.8.0.md`. The four pinned workflow action SHAs were checked against their upstream tags and match. Linux validation with the declared Node 24.21.0: syntax checks passed; `npm test` passed 250/251; `npm run test:desktop` passed 28/29. Both failures are the same unchanged Windows-path assertion in `tests/desktop.test.mjs:168`, which compares Windows backslashes against Linux `path.join` output. Windows packaging and installer acceptance cannot be performed in this Linux environment. The GitHub CLI's API requests are blocked (`Forbidden`); the available GitHub connector can prepare the PR but has no manual workflow-dispatch or release-publication operation. After the release-preparation PR passes Windows CI and merges, dispatch **Windows unsigned installer** on `main` (`gh workflow run windows-unsigned-release.yml --repo Abe-Borg/ahj-atlas --ref main`). Let that workflow create the tag and draft; do not create `v1.8.0` separately. Record its run URL, draft URL, exact asset name and checksum here, then perform the exact-download clean-install, upgrade and installed-app acceptance checks from `docs/windows-release-process.md` before publishing. These checks remain pending; Session 5 stays IN PROGRESS.

2026-10-01, 1.9.0 release preparation: GitHub confirms `v1.8.0` was published on 2026-10-01 from `e42223607ab3b9d682c0b0861d1d9ee3965259b5`, with installer and checksum assets; its manual [release workflow run](https://github.com/Abe-Borg/ahj-atlas/actions/runs/36877393635) passed. This is publication/build evidence, not evidence of the outstanding clean-machine acceptance checks. Current `main` is `c882e22e02e4a10b82eb803d4c7602c999036def`, 14 commits ahead (PRs #30–#34): project renaming, resource-limit diagnostics, question closure reasons, essentials Excel export, and Ask Atlas. Prepare a minor release with matching 1.9.0 package/lock metadata and `docs/releases/1.9.0.md`. The four pinned workflow action SHAs were checked against their upstream tags and still match. Linux validation with the declared Node 24.21.0: syntax checks passed; `npm test` passed 293/294; `npm run test:desktop` passed 29/30. Both failures are the existing Windows-path assertion at `tests/desktop.test.mjs:168`; all five merged feature PRs passed Windows CI. Windows packaging will be checked by the release-preparation PR workflow. The CLI API is blocked (`Forbidden`), and the GitHub connector has no workflow-dispatch or release-publication operation. After the preparation PR passes Windows CI and merges, run `gh workflow run windows-unsigned-release.yml --repo Abe-Borg/ahj-atlas --ref main` (or **Run workflow** on `main` in Actions). Let the existing workflow create `v1.9.0` and its draft; do not create the tag separately. Record the run URL, draft URL, `AHJ-Atlas-1.9.0-Windows-x64-Setup.exe`, and its SHA-256 here, then complete the exact-download clean-install, upgrade, and installed-app acceptance checks in `docs/windows-release-process.md`. Release creation, installer acceptance, and publication are pending; Session 5 stays IN PROGRESS.

## Session 1: Electron compatibility spike and development shell

### Objective

Prove that a supported Electron runtime can execute the complete backend dependency graph and create a usable desktop window before investing in installer work.

### Tasks

- [x] Create a dedicated Electron main-process entry point, preferably under `desktop/`.
- [x] Add pinned development dependencies for Electron and electron-builder. Commit the lockfile changes.
- [x] Add a development script such as `npm run desktop` that starts Electron without replacing `npm start`.
- [x] In the main process, wait for Electron readiness, import `createApp()`, start it with an isolated development data directory and `port: 0`, then load the returned URL in a `BrowserWindow`.
- [x] Set `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Do not create a preload bridge unless a concrete feature requires it.
- [x] Implement basic shutdown so quitting Electron awaits `backend.close()` and does not leave `instance.lock` behind.
- [x] Add an Electron single-instance lock. A second launch must focus/restore the existing window.
- [x] Verify that the selected Electron version's embedded Node supports `node:sqlite` and the repository's required Node APIs.
- [x] Verify that `@napi-rs/canvas` loads in Electron on Windows x64. Account for ASAR unpacking if required, but defer final packaging rules to Session 4.
- [x] Exercise representative fake-provider workflows from the Electron window: bootstrap, project creation, project reload, chat UI, and report rendering.
- [x] Exercise PDF, XLSX, and JSON generation at the API level, even if native Save dialogs are deferred.
- [x] Verify installed Edge/Chrome discovery and at least one dynamic-page reader smoke path without bundling another browser.
- [x] Add focused automated tests for main-process bootstrap logic where practical. Keep side effects injectable so tests do not require a visible window for every assertion.
- [x] Document the chosen Electron version and compatibility findings in the decision log.

### Compatibility fallback order

If the initial Electron version cannot support the application:

1. Try a currently supported Electron version whose embedded Node runtime satisfies `node:sqlite` and the package's Node API requirements.
2. Determine whether a narrowly scoped dependency/API adjustment preserves behavior and is safer than a sidecar.
3. Only as a last resort propose bundling a separate Node 24 sidecar runtime. Stop and document the impact before implementing a sidecar, because it changes packaging, lifecycle, security, and installer scope.

Do not silently downgrade the application's runtime requirements or replace SQLite during the spike.

### Required checks

- [x] `npm run check`
- [x] `npm test`
- [x] New desktop unit/integration checks
- [x] Manual Windows x64 launch from `npm run desktop`
- [x] Clean shutdown and immediate relaunch without a stale lock

### Exit criteria

Session 1 is complete only when the app can run in Electron on Windows x64 with its existing backend, SQLite opens successfully, representative exports work, native dependencies load, existing automated tests pass, and the compatibility decision is recorded. No installer is expected yet.

## Session 2: Production lifecycle, security, data paths, and migration

### Objective

Turn the spike into a production-quality desktop host whose lifecycle and storage behavior are safe for real user work.

### Tasks

- [x] Introduce a small, testable desktop bootstrap/lifecycle module rather than concentrating all behavior in one top-level script.
- [x] Select the stable production data directory beneath Electron's per-user application-data location. Pass it explicitly to `createApp()`.
- [x] Ensure the DPAPI credential remains at a stable per-user path. Avoid accidentally nesting or duplicating `AHJ Atlas` path segments when Electron's product name already supplies one.
- [x] Define and test development, packaged, and test data-path behavior.
- [x] Add a one-time legacy workspace import flow for users who have an existing source installation with `data/atlas.sqlite`. Migration detection and any native prompt must run **before** `createApp()` constructs the destination `Store`, because normal store construction creates `atlas.sqlite` immediately. Skip import only when the destination has an initialized/nonempty workspace or a recorded migration decision—not merely because an empty database file exists.
- [x] Refactor desktop startup into an explicit preflight order: resolve paths, inspect destination state, detect an eligible legacy workspace, prompt when needed, perform/validate the import, and only then call `createApp()`. Test that first launch can import and that all later launches bypass the prompt without overwriting the destination.
- [x] Import the legacy database with a transactionally consistent, WAL-aware SQLite snapshot mechanism (prefer the runtime's SQLite online-backup API or an equivalently safe mechanism), not a filesystem copy of `atlas.sqlite` alone. The snapshot must include committed transactions present in `atlas.sqlite-wal`, refuse migration while the legacy workspace is actively locked/in use, write to a staging destination, validate the staged database through the normal store/schema path, and atomically promote it only after validation. Leave the original database and its WAL/SHM files untouched as the backup. Never merge two SQLite workspaces automatically.
- [x] Keep the backend bound to loopback and retain its host/origin/token/request-size/CSP controls.
- [x] Restrict the main window to the exact runtime loopback origin. Deny or reroute unexpected navigation.
- [x] Open approved public `http:`/`https:` links in the user's default browser. Reject `file:`, `javascript:`, unexpected `data:`, custom, and malformed navigation targets.
- [x] Deny arbitrary window creation. Handle intended external links explicitly through Electron's window-open/navigation hooks.
- [x] Decide and implement close behavior. Normal window close should gracefully stop local services and exit. If existing semantics require reconciling in-flight work, display an accurate confirmation rather than claiming provider work can be canceled instantly.
- [x] Handle `before-quit`, `window-all-closed`, second-instance, renderer crash, backend startup failure, and Windows shutdown/logoff as safely as the platform permits.
- [x] Add a bounded startup screen or native error dialog so backend failures do not leave a blank window. Put non-sensitive diagnostics in a stable user-accessible location if logging is added.
- [x] Persist and restore reasonable window bounds while ensuring an off-screen window is brought back onto a current display.
- [x] Disable production developer tools and development shortcuts unless an explicit diagnostic flag enables them.
- [x] Add lifecycle, path, migration, single-instance, and navigation-policy tests.

### Required checks

- [x] `npm run check`
- [x] `npm test`
- [x] All desktop tests from Sessions 1 and 2
- [x] Manual Windows tests for first run, second launch, normal exit, forced renderer failure, and relaunch
- [x] Manual migration test using a disposable copy of a legacy `data/` directory
- [x] Confirm the API key is absent from browser storage, logs, diagnostics, and migration output

### Exit criteria

Session 2 is complete when the desktop host uses stable per-user storage, preserves existing security boundaries, handles one-instance and shutdown behavior reliably, offers a safe legacy import path, and passes both automated and manual Windows lifecycle tests.

## Session 3: Downloads, external navigation, desktop UX, and regression coverage

### Objective

Make all currently browser-dependent behaviors work naturally inside the desktop shell without changing product functionality.

### Tasks

- [x] Implement Electron download handling for PDF, XLSX, JSON, and diagnostic attachments.
- [x] Preserve the server-provided sanitized filename and extension, but use a native Save dialog or another explicit user-selected destination. Never silently overwrite an existing file.
- [x] Surface download completion, cancellation, and failure in an accessible way. Do not expose local filesystem paths to remote content.
- [x] Test filenames with spaces, Unicode, reserved Windows characters, long project names, and collisions.
- [x] Confirm source links, help links, Anthropic links, and other intended external destinations open in the system browser while app-internal routes stay in the Electron window.
- [x] Confirm clipboard, printing if currently used, keyboard navigation, dialogs, focus restoration, and responsive layouts work in the desktop window. (No UI print action exists.)
- [x] Confirm the optional installed Edge/Chrome reader continues to use an isolated temporary profile and is not confused with Electron's Chromium executable.
- [x] Add an About surface or equivalent small desktop affordance only if necessary to display version and diagnostic information. Do not redesign the application. (Existing Diagnostics displays the package version.)
- [x] Ensure version reporting comes from one authoritative package/app version and remains consistent between Electron, `/api/bootstrap`, diagnostics, and installer metadata.
- [x] Add end-to-end desktop smoke coverage. Reuse fake providers and synthetic data; tests must not make paid model requests.
- [x] Run the existing browser UI scripts where supported and document any platform prerequisites.

### Required checks

- [x] `npm run check`
- [x] `npm test`
- [x] All desktop tests
- [x] Existing relevant UI tests, including preview/chat/questions/delete/citations as applicable
- [x] Manual export of PDF, XLSX, JSON, and diagnostics from the Electron window
- [x] Manual external-link and blocked-navigation tests

### Exit criteria

Session 3 is complete when every existing user-visible workflow can be performed in the Electron window, exports save correctly, external content cannot navigate the app window, and the desktop regression suite covers the critical shell integration.

## Session 4: Unsigned per-user NSIS installer

### Objective

Produce and validate the actual unsigned Windows installer that users will download.

### Installer configuration requirements

- Product name: `AHJ Atlas`.
- Target initially: Windows x64 only. Do not label the artifact ARM64-compatible without native ARM64 testing.
- Installation context: current user/per-user, without administrator elevation.
- Start menu shortcut: required.
- Desktop shortcut: optional during install or omitted; do not force it without a product decision.
- Installed Apps / uninstaller registration: required.
- Artifact name should include product, version, Windows, and architecture, for example `AHJ-Atlas-1.6.0-Windows-x64-Setup.exe`.
- Publisher/signing: none. Ensure build configuration does not stall while trying to auto-discover a certificate.
- ASAR: permitted, but native modules and runtime-loaded assets must be unpacked/configured correctly.
- User data: never placed in or removed with application binaries during routine upgrade.
- Uninstall: removes application files and shortcuts; preserves projects and credentials by default. Documentation must explain manual data removal.
- Upgrade: running a newer installer upgrades in place and preserves the same application identity, user data, shortcuts, and uninstall entry.

### Tasks

- [x] Add electron-builder metadata and NSIS configuration in a maintainable configuration file or `package.json`.
- [x] Add a proper multi-resolution Windows `.ico` asset and confirm branding rights. Do not use a low-resolution SVG conversion without inspecting Windows results.
- [x] Configure production files narrowly. Include required app code/assets/dependencies; exclude tests, repository data, logs, `.env`, development-only files, and local credentials.
- [x] Configure ASAR unpacking for native binaries and any resources that cannot run from the archive.
- [x] Ensure production dependencies are present and development-only dependencies are not shipped unnecessarily.
- [x] Add deterministic package/build scripts, such as an unpacked-directory build and an installer build.
- [x] Produce an unpacked build first and execute the complete desktop smoke suite against it.
- [x] Produce the unsigned NSIS installer on Windows.
- [ ] Install as a non-administrator on a clean Windows test account.
- [x] Verify Start menu launch, Installed Apps metadata, icon quality, version, application name, and uninstall entry.
- [x] Verify no Node.js installation is required by testing on a machine/account without Node on `PATH`.
- [x] Verify the app uses an ephemeral loopback port and still starts when port 4318 is occupied.
- [x] Verify exports and dynamic-page reading in the installed build.
- [x] Install an older test version, create data, install the new version over it, and confirm all projects, chat, sources, diagnostics, settings, and credentials survive.
- [x] Uninstall and confirm application binaries/shortcuts are removed while user data remains. Reinstall and confirm the retained workspace opens.
- [x] Record the expected unsigned Windows warning in documentation with neutral, accurate wording. Never automate bypasses or advise disabling Defender/SmartScreen.

### Required checks

- [x] `npm run check`
- [x] `npm test`
- [x] All desktop tests against source-mode Electron
- [x] Desktop smoke test against the unpacked packaged application
- [x] Installer build completes on Windows x64
- [x] Fresh non-admin install test
- [x] Upgrade-preserves-data test
- [x] Uninstall/reinstall-preserves-data test
- [x] Installation with port 4318 occupied
- [ ] Launch on a test system/account without separately installed Node.js

Local Windows x64 evidence: `npm run check` and `npm test` (164 passing tests); source and unpacked `npm run test:desktop:window`; `npm run package:win:smoke` and `npm run package:win:installer` with the production ASAR audit. The installed 1.5.1 app opened while port 4318 was occupied, read its protected test credential, and exported PDF/XLSX/JSON/diagnostics. The installed Chrome-backed reader rendered `https://quotes.toscrape.com/js/` and persisted 1,499 characters including a JavaScript-generated quote. A 1.5.0-to-1.5.1 upgrade, normal exit, uninstall, and reinstall preserved the disposable workspace; the final test installation was then removed.

The user accepted Session 4 as complete on this evidence after PR #7 merged. This acceptance does not convert either unchecked separate clean-account or Node-free-system check into a pass; both remain open for the Session 5 release candidate.

### Exit criteria

Session 4 is complete only when an unsigned per-user installer successfully installs, launches, upgrades, and uninstalls on Windows x64 without admin access or external Node.js, and all application functionality and user data survive the packaging boundary.

## Session 5: GitHub Releases automation and release candidate

### Objective

Make unsigned installer releases repeatable, reviewable, and downloadable from GitHub without adding an automatic updater.

### Release model

Use a Windows GitHub Actions runner to create release artifacts. Prefer a manually dispatched workflow or a protected version-tag workflow that first creates a **draft GitHub Release**. Do not publish automatically until a human has installed and smoke-tested the exact downloaded artifact.

### Tasks

- [x] Add a Windows release workflow with least-privilege GitHub token permissions.
- [x] Pin action versions to immutable commit SHAs where practical and document update ownership.
- [x] Install dependencies using `npm ci` and the repository's declared Node version.
- [x] Run syntax checks, the full deterministic test suite, and desktop/package checks before artifact publication. (Configured in the workflow and passed locally; the GitHub run remains pending.)
- [x] Build the x64 unpacked package and unsigned NSIS installer. (Passed locally; GitHub build remains pending.)
- [x] Generate SHA-256 checksums with a standard Windows/PowerShell command and publish `SHA256SUMS.txt` alongside the installer. (Creation/verification passed locally; release attachment remains pending.)
- [ ] Upload CI artifacts for inspection, then attach the installer and checksum file to a draft GitHub Release.
- [x] Ensure workflows never package repository `data/`, `.env`, logs, credentials, test outputs, or developer workspaces. (Production ASAR audit passed locally; CI will repeat it.)
- [x] Document a maintainer release checklist: version bump, changelog/release notes, local/CI checks, workflow invocation, artifact download, checksum verification, clean install, upgrade install, smoke test, and manual draft publication.
- [x] Document user installation, the unsigned publisher warning, update-by-running-new-installer, data location, backup, uninstall retention, full data removal, checksums, system requirements, and Edge/Chrome behavior.
- [x] Update the old source-launch documentation so installed users are not told to install Node or double-click `.cmd` files. Retain a clearly separated source-development section.
- [ ] Download the artifacts from GitHub rather than using local build outputs for final acceptance. Verify the published checksum and test the exact download.
- [ ] Create a release-candidate draft and complete the full release checklist.

### GitHub workflow security requirements

- Pull-request workflows must not have permission to create releases.
- Release creation must be limited to an intentional maintainer action or protected tag.
- Do not run untrusted pull-request code in a privileged release job.
- Use only the minimum `contents` permission needed to create the draft release.
- Do not add code-signing placeholders or secrets for this unsigned release.
- Artifact and release names must derive from validated version metadata, not arbitrary shell input.

### Required checks

- [ ] Clean GitHub Actions run on the release commit
- [ ] Installer and `SHA256SUMS.txt` attached to a draft release
- [ ] Locally verify the downloaded installer's SHA-256 against the downloaded checksum file
- [ ] Fresh install using the GitHub-downloaded artifact
- [ ] Upgrade using the GitHub-downloaded artifact
- [ ] Full installed-app smoke checklist
- [x] Review documentation from the perspective of a non-developer user

Local implementation checks on Windows x64: `npm ci`, `npm run check`, `npm test` (164 passed), and `npm run test:desktop` (28 passed). With `ATLAS_BUILD_OUTPUT=dist/session5`, `npm run package:win:smoke`, `npm run package:win:dir`, and `npm run package:win:installer` passed the ASAR audit; the installer had `NotSigned` Authenticode status. The PowerShell checksum create/verify script passed on that local installer. The original ignored `dist/win-unpacked/resources/app.asar` was held open, so these builds used the fresh output directory. The local checksum is not the release checksum; release acceptance must use the exact GitHub-downloaded files.

PR #8's [Windows Actions run 36480519693](https://github.com/Abe-Borg/ahj-atlas/actions/runs/36480519693) passed on commit `39bdb8e`, including all workflow checks, package audits, installer build, checksum creation/verification, and CI artifact upload. The two files downloaded from that run's CI artifact verified locally: `AHJ-Atlas-1.5.1-Windows-x64-Setup.exe` SHA-256 `c36f9e0120f3a5fec16b1e1d109f350eeefe5a66f16f76e19c06463a0f6c0d38`; Authenticode status `NotSigned`. This is a PR CI artifact, **not** the draft GitHub Release asset. The clean release-commit run, draft assets, exact draft download, fresh install, upgrade, and installed-app smoke remain unchecked.

### Exit criteria

Session 5 is complete when a repeatable GitHub workflow produces a draft release containing the unsigned per-user x64 installer and checksum file, the exact downloaded artifact passes clean-install and upgrade testing, and user/maintainer documentation is complete. Publishing the draft release remains a human decision.

## Required final acceptance matrix

The project is finished only after all rows pass on the release candidate:

| Area | Acceptance condition |
|---|---|
| Installation | Standard user installs without administrator approval. |
| Runtime | Application works without Node.js installed separately. |
| Launch | Start menu entry opens one desktop window and starts one backend. |
| Ports | App starts while port 4318 is occupied. |
| Persistence | Projects, stages, sources, chat, questions, diagnostics, and settings persist across restart and upgrade. |
| Credentials | Remembered API key remains DPAPI-protected and survives upgrade; it is absent from logs/artifacts. |
| Research | Fake-provider real-time and batch workflows complete in installed build. |
| Chat | Project chat works and remains isolated/persistent. |
| Questions | Answer/dismiss/research-with-answers flows work. |
| Exports | PDF, XLSX, JSON, and diagnostics save through the desktop shell. |
| Retrieval | Normal source reads work; installed Edge/Chrome dynamic rendering works when available. |
| Security | Renderer has no Node integration; unexpected navigation/window creation is blocked; server controls remain enabled. |
| Shutdown | Normal close releases the database lock; relaunch succeeds. |
| Upgrade | New installer preserves all user data and app identity. |
| Uninstall | Binaries/shortcuts are removed; user data is retained and documented. |
| Release | GitHub draft contains the expected installer and matching SHA-256 checksum. |
| Warning | Documentation accurately explains that the installer is unsigned. |

## Testing principles

- Existing deterministic fake-provider tests remain mandatory and must not make paid API calls.
- Never use a real user workspace for installer or migration testing. Use disposable directories and test accounts/VM snapshots.
- Test the packaged and installed application, not only source-mode Electron.
- Test the exact artifact downloaded from the draft GitHub Release before publication.
- A warning caused solely by the intentionally unsigned publisher status is expected; crashes, missing files, broken exports, failed upgrades, or antivirus detections are not automatically acceptable.
- If an environment limitation prevents a required Windows test, leave the session incomplete and record the precise outstanding test in the blocker log.

## Per-session PR and handoff protocol

At the end of every implementation session:

1. Run all checks required by that session and report exact commands and outcomes.
2. Update this plan's status table, checklists, decision log, and blocker log.
3. Commit all session work on the current branch.
4. Open exactly one PR for that session with scope, architectural decisions, tests, manual checks, risks, and remaining work.
5. Stop. Do not begin the next session in the same PR.
6. The user will review and merge the PR.
7. In the final response, provide a ready-to-copy handoff prompt for the next session. Phrase it conditionally: **after this PR is merged**, start a fresh session from the updated default branch and use the prompt.

Use this handoff prompt template, replacing the bracketed text:

```text
Continue the AHJ Atlas unsigned Windows installer work in /workspace/ahj-atlas.

Start by updating the local default branch after PR [PR number/title] has been merged. Read every applicable AGENTS.md and then read docs/windows-unsigned-installer-plan.md in full. Confirm that Session [completed number] is marked COMPLETE and review its decision/blocker log entries.

Implement only Session [next number]: [session title]. At the start, mark that session IN PROGRESS in the plan. Follow its tasks, required checks, and exit criteria. Preserve all existing application functionality and do not begin later sessions. Update the plan with completed items, decisions, blockers, and final status. Commit the changes and open exactly one PR for this session. In your final response, report tests and provide the next ready-to-copy post-merge handoff prompt.
```

For Session 5, replace the next-session prompt with a release handoff summarizing the draft release, exact artifact names/checksums, manual acceptance results, known limitations, and the human steps needed to publish it.

## Explicitly out of scope

- Purchasing or configuring a public code-signing certificate.
- Suppressing or bypassing Windows SmartScreen, Defender, antivirus, or corporate application-control policy.
- Microsoft Store packaging/publication.
- An automatic update service.
- macOS or Linux desktop installers.
- ARM64 claims without a separately approved/testing workstream.
- Replacing Anthropic, changing research prompts/models, redesigning the UI, or changing application functionality unrelated to desktop packaging.
- Moving the backend to hosted infrastructure.
- Replacing SQLite or rewriting the frontend/backend interface without a documented, reviewed blocker.
