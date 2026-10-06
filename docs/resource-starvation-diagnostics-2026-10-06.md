# Tell a starved computer from a spent allowance

Diagnostics already answered half of "was research starved?": every allowance decision (rounds, searches, reads, fetches, input and output tokens, active time, checkpoint restarts, fetched content, clipped briefs, the stream deadline, provider spend and output ceilings, batch retention) is a `resource.exhausted` row naming the resource, its limit, the amount used and the outcome. Nothing recorded the other half: whether the computer running the app, or Anthropic's capacity, held a stage back. A research request that took twenty minutes looked the same whether the model was slow, the laptop had gone to sleep, or the provider had rate-limited the key. This change records those causes so the diagnostic download can separate them.

## What is sampled

`lib/resources.mjs` adds `ResourceMonitor`. While the backend runs it samples every 5 seconds:

- the event-loop delay of the app's own process (`perf_hooks.monitorEventLoopDelay`, maximum over the interval);
- the gap since the previous sample, which grows when the process is suspended (sleep, hibernation, OS throttling of a background app);
- the process's CPU time as a share of one core, its resident memory, and its heap as a fraction of V8's ceiling (`v8.getHeapStatistics().heap_size_limit`);
- the computer's busy share across all cores (deltas of `os.cpus()` times, which works on Windows where `os.loadavg()` does not) and its free memory as a fraction of the total.

A sample is starved when the event loop stalled for 500 ms or more (`event_loop`), the gap reached 10 seconds (`process_paused`), the computer's CPU was 95% busy or more (`system_cpu`), the heap reached 85% of its ceiling (`heap`), or free memory fell to 5% or less (`system_memory`). The thresholds live in `RESOURCE_MONITOR` and are audited by the trust dossier. Samples hold numbers only; CPU model strings, process names, file paths and user names are never read into them.

## Bounded episodes, not a sample log

The 5,000-row journal must not fill with host samples. The monitor keeps the last 720 samples (one hour) in memory and writes rows only at episode boundaries: `resource.starved` (warning) once when a signal first crosses its threshold, carrying the value, the threshold and the whole sample, and `resource.recovered` (info) once the signal has been clear for six consecutive samples, carrying the starved time, the number of starved samples and the peak value. A flicker inside that recovery window extends the open episode instead of opening another. Each signal has its own episode, so one bad interval can open up to five.

The in-memory summary (`application.resources` in the report) holds the current readings, the peaks since the backend started, the per-signal episode counts, starved samples, starved time and peak, and the signals active right now. A worker-less app (tests) does not sample but still reports a current snapshot.

## Timed rows carry their host window

`Store.diagnostic` is the one funnel for every diagnostic row. When the services layer has attached a monitor, any row with a finite `durationMs` and no `resources` of its own receives `resources`: the samples that overlapped the operation, reduced to their count, the starved signals seen during it with how many samples each, and the worst event-loop delay, pause, process and system CPU, heap fraction and free memory. That covers provider streams and requests (`stream.*`, `api.*`), engine failures (`request.failed`), research and chat tool calls (`tool.completed`), and local HTTP (`http.completed`) without touching the engine, chat or provider. An operation shorter than the sampling interval that falls between two samples reports zero samples rather than borrowing a neighbour.

## One summary per project and for the workspace

`starvationSummary` reads saved rows back into one answer. `host` counts episodes and recoveries by signal with their starved time, timed rows, timed rows that overlapped a starved sample, and starved samples during work by signal. `provider` counts Anthropic rate-limit (429 or `rate_limit_error`) and overload (529 or `overloaded_error`) responses once per request, even though the provider and the engine each record the same failure, and totals the retry wait the provider asked for. `allowances` counts `resource.exhausted` rows by resource and outcome. The report carries this summary at the workspace level and inside each project, computed from that project's rows. Host rows have no project, so a project's host figures come from the windows on its own timed rows, which is the accurate attribution: work that ran while the computer was starved.

## Panel and trust surfaces

The Diagnostics panel gains a **Starved / throttled** tile (host episodes and throttled requests for the selected records), a note of operations that ran while starved and throttled requests on each project's progress line, and a **Resources and starvation** section with the active signals and the full summary. The trust dossier adds automatic behavior A07 (host sampling, with its thresholds interpolated from `public/trust-facts.js`), extends the diagnostics card, and the claims ledger pins `resourceMonitor` to `RESOURCE_MONITOR`. The help page and README describe the same behavior.

## Limitations

A starved sample is an observation, not a cause. The app's own PDF extraction or page rendering can stall its event loop; a sample that overlaps a request does not prove the request was slower because of it. Event-loop delay and the sample gap both grow during a suspension, so a sleep usually opens an `event_loop` episode as well as a `process_paused` one. The histogram's resolution adds up to 20 ms to every reading. `os.cpus()` can return an empty list on some systems; that interval then has no system CPU figure. Sampling stops with the backend; nothing is recorded while the app is closed, so a sleep that spans a restart shows only as a gap in timestamps. The monitor adds a 5-second timer and a handful of system calls; it does not change scheduling, retries or any allowance.

## Validation

On Node 22.22.0 in a Linux container (the project pins Node 24.21.0, which was not available there), `npm test` runs 373 tests: 371 pass, 1 fails and 1 is cancelled, with the same two outcomes before this change. The failure is the known Windows-only desktop path comparison in `tests/desktop.test.mjs`; the cancelled test is the real short-deadline stream regression in `tests/resource-exhaustion.test.mjs`, which Node 22 ends with "Promise resolution is still pending but the event loop has already resolved" before its assertions run. The eight new tests in `tests/resources.test.mjs` cover quiet samples, each signal's threshold and episode bounds, a flicker inside the recovery window, windows over overlapping samples, the bounded in-memory history, the store hook, the summary's once-per-request throttling count, the report with and without a monitor, the real monitor against this process, and the app starting and stopping sampling with its worker. The trust test pins the thresholds to `RESOURCE_MONITOR`, and the browser suites ran with `ATLAS_BROWSER` pointing at a bundled Chromium, including the trust dialog test that renders the new A07 card. `npm run check` and `git diff --check` pass. No dependencies changed and no paid requests were made.
