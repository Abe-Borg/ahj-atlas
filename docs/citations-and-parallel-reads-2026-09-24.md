# Native chat citations and concurrent source reads

Implemented recommendations 3 and 4. Earlier cache and enum-normalization changes remain in place.

## Chat citations

Retrieved source excerpts are sent as citation-enabled `search_result` blocks. Stable initial excerpts precede the changing chat context and retain caching. Source lookups supply additional citable passages. Paging metadata follows all tool results as separate user text: the API requires an individual citable tool result to contain only search-result blocks.

Each result has a project-specific source reference and a digest of its supplied excerpt. The app checks returned result indices, source references, block ranges and cited text against the request before exposing a supporting-passage control. It takes display titles from the saved project register, not model-provided URLs or titles. Source text is split into bounded blocks for more focused quotations. Native citations identify passages; existing instructions still require checking whether those passages actually establish a claim.

The database retains displayable answer parts alongside the existing plain-text answer, while original provider responses remain untouched. Startup recovery reconstructs citation displays from a completed saved response and its original request. Legacy answers retain their prior source links. Discovery-only records, visual-only sources, report summaries and user answers are not converted to citable retrieved text. The structured final-report workflow is unchanged because native citations cannot be combined with its strict output format.

References: Anthropic's [citations guide](https://platform.claude.com/docs/en/build-with-claude/citations) and [search result schema and tool-result rules](https://platform.claude.com/docs/en/build-with-claude/search-results).

## Concurrent reads

Consecutive independent `read_source` calls are admitted in pairs. Fetching and extraction run concurrently; source registration and tool-result persistence occur in request order. This avoids completion-order-dependent source IDs within a response. The existing maximum of two active tasks permits at most four concurrent reads.

The read allowance is reserved synchronously before each fetch. A new ledger flag distinguishes started reads from calls rejected before execution; historical rows preserve their existing counts. Both global project and verification-stage ceilings remain effective when different stages run together. A failed retrieval retains its own error result while its successful sibling is saved. Reapplying completed responses reuses saved tool results. Matching in-flight URLs share a download; failed downloads are removed from that map so explicit later retries can work.

Progress and completion calls are barriers, and browser/visual tools retain sequential execution. Cancellation does not discard completed in-flight evidence; it prevents starting subsequent groups. Models are instructed to group known independent reads and wait for prerequisite results. This implements the application-side execution described in Anthropic's [parallel tool-use guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use).

## Verification

All 132 deterministic tests and syntax checks passed. Coverage includes native citation mapping and persistence, global citation indices across tool results, streamed citation deltas, invalid and foreign-source references, signed continuation, concurrent read limits, ordered commits, failed siblings, cancellation, progress barriers and download coalescing. The browser regression also passed using synthetic projects and fake responses: passage expansion, source navigation, escaping, reload, project isolation and desktop/mobile layout. Browser startup timed out in the restricted runner; the successful run used the same local test outside that restriction.

No paid API requests or live regulatory research were run. End-to-end savings and model citation quality have not been benchmarked. The backend needs a restart to load these changes; existing reports and provider conversations are preserved.
