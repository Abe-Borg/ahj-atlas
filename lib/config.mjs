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
  { id: 'verification', label: 'Opus evidence check', effort: 'medium', model: 'review' },
  { id: 'review', label: 'Final report', effort: 'medium', model: 'review' },
];
export const LIMITS = { searches: 40, searchesPerRequest: 4, reads: 100, rounds: 12, output: 60000, reviewOutput: 100000, input: 90000, checkpointInput: 60000, contextResets: 2, reviewRounds: 4, pageChars: 24000, readChars: 8000, documentBytes: 10 * 1024 * 1024, activeMs: 15 * 60 * 1000, verificationRounds: 6, verificationSearches: 8, verificationReads: 12, continuations: 2, batchRetentionMs: 29 * 24 * 60 * 60 * 1000 };
// Chat ceilings are runaway guards, not spending limits. activeMs bounds the lookup
// phase; wrapUpMs before it the reply switches to a final answer, which then gets
// at least answerMs to stream. Preview sizes are characters of saved project records.
// Chat's web allowance is per reply and separate from research's project totals:
// searchesPerRequest is the web_search max_uses, fixed for a whole reply.
export const CHAT_LIMITS = { messageChars:30000, output:64000, input:400000, requests:20, toolCalls:60, toolChars:24000, historyChars:200000, activeMs:20*60*1000, wrapUpMs:3*60*1000, answerMs:10*60*1000, excerptChars:160000, preview:{report:160000,research:120000,sources:60000,context:20000,questions:40000}, cacheTTL:'1h', searchesPerRequest:2, searches:10, webReads:20 };
export const CHAT_MODES = {
  standard: { label: 'Standard', modelKey: 'research', effort: 'high' },
  deep: { label: 'Deep', modelKey: 'research', effort: 'max' },
  opus: { label: 'Opus', modelKey: 'review', effort: 'xhigh' },
};
export const chatMode = id => CHAT_MODES[id] ? { id, ...CHAT_MODES[id] } : { id: 'standard', ...CHAT_MODES.standard };
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
