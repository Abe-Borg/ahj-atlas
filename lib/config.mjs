import packageInfo from '../package.json' with { type: 'json' };
export const VERSION = packageInfo.version;
export const PRICE_DATE = '2026-09-28';
export const MODELS = {
  research: { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: .2 },
  review: { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: .2 },
};
export const DISCIPLINES = ['Architecture', 'Fire protection', 'Electrical', 'Mechanical', 'Plumbing', 'Structural', 'Civil'];
export const STAGE_DEFS = [
  { id: 'jurisdiction', label: 'Jurisdiction', effort: 'high', model: 'research' },
  { id: 'contacts', label: 'Contacts & process', effort: 'medium', model: 'research' },
  { id: 'codes', label: 'Codes & standards', effort: 'high', model: 'research' },
  { id: 'verification', label: 'Opus evidence check', effort: 'high', model: 'review' },
  { id: 'review', label: 'Final report', effort: 'high', model: 'review' },
];
// A research conversation grows until its next request counts checkpointInput tokens, then
// restarts from its saved checkpoint; no request is sent above input. The final review's
// evidence package holds up to reviewEvidence characters of source excerpts (at most
// reviewSourceChars from one source) and up to stageBriefChars of each stage's brief.
// A page read shows the model its pageLinks most relevant links; up to savedLinks links
// from the whole page are remembered, so chat may open any of them. Fetches (Anthropic's
// web_fetch) count toward the read allowances; fetchContentTokens caps a fetched page's text.
// A document the user adds keeps up to uploadChars of its text; a web source keeps 180,000.
export const LIMITS = { searches: 80, searchesPerRequest: 4, fetchesPerRequest: 3, fetchContentTokens: 60000, reads: 100, rounds: 12, output: 60000, reviewOutput: 100000, input: 300000, checkpointInput: 200000, contextResets: 2, reviewRounds: 4, pageChars: 24000, readChars: 8000, pageLinks: 60, savedLinks: 1000, reviewEvidence: 600000, reviewSourceChars: 100000, stageBriefChars: 80000, documentBytes: 50 * 1024 * 1024, uploadChars: 2000000, activeMs: 45 * 60 * 1000, verificationRounds: 6, verificationSearches: 15, verificationReads: 20, continuations: 2, batchRetentionMs: 29 * 24 * 60 * 60 * 1000 };
// Chat sets no token ceilings of its own: output is the 128K maximum of Sonnet 5.5 and
// Opus 5.5, and input may fill the model's context window (as the Models API reports it,
// else the documented 1M) less that output. contextWindow is that fallback, not a cap.
// The other chat ceilings are runaway guards, not spending limits. activeMs bounds the lookup
// phase; wrapUpMs before it the reply switches to a final answer, which then gets
// at least answerMs to stream. Preview sizes are characters of saved project records.
// Chat's web allowance is per reply and separate from research's project totals:
// searchesPerRequest and fetchesPerRequest are the web_search and web_fetch max_uses, fixed
// for a whole reply. Fetches count toward the reply's page reads (webReads).
// proposals caps the actions a reply can propose for the user's approval; proposalCalls
// also counts rejected proposals, so invalid attempts cannot fill a reply.
export const CHAT_LIMITS = { messageChars:30000, output:128000, contextWindow:1000000, requests:20, toolCalls:60, toolChars:24000, historyChars:200000, activeMs:20*60*1000, wrapUpMs:3*60*1000, answerMs:10*60*1000, excerptChars:160000, preview:{report:160000,research:120000,sources:60000,context:20000,questions:40000}, cacheTTL:'1h', searchesPerRequest:4, searches:20, fetchesPerRequest:3, webReads:20, proposals:4, proposalCalls:8 };
// Both reply depths reason at high effort; they differ by model. Premium keeps the
// saved id 'opus', so earlier replies and their retries keep their labels.
export const CHAT_MODES = {
  standard: { label: 'Standard', modelKey: 'research', effort: 'high' },
  opus: { label: 'Premium', modelKey: 'review', effort: 'high' },
};
// Retired depths label earlier replies only; a new message cannot choose them.
const RETIRED_CHAT_MODES = { deep: { label: 'Deep', modelKey: 'research', effort: 'max' } };
export const chatMode = id => CHAT_MODES[id] ? { id, ...CHAT_MODES[id] } : Object.hasOwn(RETIRED_CHAT_MODES, id) ? { id, ...RETIRED_CHAT_MODES[id] } : { id: 'standard', ...CHAT_MODES.standard };
export const usd = micros => Number((micros / 1e6).toFixed(6));
export function costMicros(usage = {}, modelKey = 'research', mode = 'realtime') {
  const rate = MODELS[modelKey];
  const creation = usage.cache_creation;
  const write5 = creation ? Number(creation.ephemeral_5m_input_tokens || 0) : Number(usage.cache_creation_input_tokens || 0);
  const write1 = Number(creation?.ephemeral_1h_input_tokens || 0);
  const tokens = Number(usage.input_tokens || 0) * rate.input + Number(usage.output_tokens || 0) * rate.output + Number(usage.cache_read_input_tokens || 0) * rate.cacheRead + write5 * rate.input * 1.25 + write1 * rate.input * 2;
  return Math.ceil(tokens * (mode === 'batch' ? .5 : 1) + Number(usage.server_tool_use?.web_search_requests || 0) * 10000);
}
export function reserveMicros(inputTokens, modelKey, mode, outputTokens, searches, cacheTTL='5m') {
  const r = MODELS[modelKey], factor = mode === 'batch' ? .5 : 1;
  // Native search has variable intermediate input. This is a conservative pending-cost
  // estimate for display, not a guarantee about provider billing for an in-flight request.
  const writeFactor=cacheTTL==='1h'?2:1.25;
  return Math.ceil(((inputTokens * writeFactor * (searches + 1) + searches * 20000) * r.input + outputTokens * r.output) * factor + searches * 10000 + 30000);
}
// Chat caches its evidence and history for an hour. The first pass is priced as a
// full one-hour cache write; each search iteration rereads the context plus its
// results at the base input price rather than multiplying the write by every search.
export function chatReserveMicros(inputTokens, modelKey, outputTokens, searches) {
  const r = MODELS[modelKey];
  return Math.ceil((inputTokens * 2 + searches * (inputTokens + 20000)) * r.input + outputTokens * r.output + searches * 10000 + 30000);
}
export const cacheTTL = mode => mode==='batch'?'1h':'5m';
