export const VERSION = '1.5.0';
export const PRICE_DATE = '2026-09-24';
export const MODELS = {
  research: { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', input: 2, output: 10, cacheRead: .2 },
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
export const CHAT_LIMITS = { messageChars:6000, output:8000, input:60000, requests:4, toolCalls:8, toolChars:12000, historyChars:30000, activeMs:5*60*1000, defaultAllowance:1, maximumAllowance:5 };
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
  // Native search has variable intermediate input. This is a conservative scheduling
  // allowance, not a guarantee about provider billing for an in-flight request.
  const writeFactor=cacheTTL==='1h'?2:1.25;
  return Math.ceil(((inputTokens * writeFactor * (searches + 1) + searches * 20000) * r.input + outputTokens * r.output) * factor + searches * 10000 + 30000);
}
export const cacheTTL = mode => mode==='batch'?'1h':'5m';
export const reviewAllowance = mode => reserveMicros(LIMITS.input,'review',mode,LIMITS.reviewOutput,0,cacheTTL(mode));
