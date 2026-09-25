# Cache reuse and model-value normalization

Implemented recommendations 1 and 2 from the Claude documentation review. No model, effort, retrieval permission, research target, or user spending limit changed.

## Cache reuse

Project chat places the project ID and bounded saved report, research and source-register previews in an explicitly cached prefix. Each new question rebuilds that prefix from current records. The timestamp, latest question responses, current project inputs, spending and recent conversation follow the cache boundary. They remain fresh without invalidating an unchanged evidence prefix. Each lookup continuation preserves its original message blocks and opaque provider content.

New final-review conversations cache the initial evidence packet explicitly and use automatic caching for appended lookup exchanges. Real-time requests use 5 minutes; batch requests use 1 hour, consistent with research. The batch final-report scheduling hold rises from $1.255 to $1.39 to cover the one-hour cache-write rate. The real-time hold stays $2.48. Existing signed conversations retain their saved cache settings and message representation.

New research, review and chat requests opt into provider cache diagnostics. Comparison IDs come only from a previous opted-in response in the same project and stage. Streamed diagnostics survive in the saved response. Diagnostic exports allowlist the reason and estimated missed-token count; they exclude arbitrary diagnostic fields. Null, pending and unavailable results are distinguished. Actual cache-read and cache-write usage remains the billing authority, independent of the comparison estimate.

This follows Anthropic's [prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [cache diagnostics guide](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics). Cache eligibility, expiration and provider scheduling still determine actual hits. No paid benchmark was run, so no measured savings are claimed.

## Model-value normalization

Recognized values accept case differences for completion coverage, NFPA applicability, report section names, evidence status, adoption type and chat lookup sections. For example, `SUPPORTED`, `FireStandards` and `CONDITIONAL` map to their documented canonical forms. Normalization occurs before validation on application-owned copies of tool inputs; the provider's saved conversation stays unchanged.

Unknown values still fail the relevant strict checks or retain existing conservative unverified/unresolved fallbacks. Evidence checks still run after normalization. Source IDs, tool names, object keys, quotations and other prose are not case-normalized. Coverage descriptions in final reports remain free text.

Anthropic's [structured outputs documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#invalid-outputs) explains that enum capitalization is not guaranteed and recommends case-insensitive comparison.

## Verification

All 121 deterministic tests passed, along with application and changed-module syntax checks. Checks exercise stable chat prefixes with fresh answers and spending; evidence invalidation and project isolation; real-time and batch review caching and reservations; signed and legacy continuations; streaming diagnostics and privacy; normalized completion records; invalid values and source evidence; and replay of JSON-only, delimited and cache-marked saved evidence packets. These tests make no paid API calls.

The backend must load the updated files before new requests use these changes. Saved reports and past attempts are not rewritten.
