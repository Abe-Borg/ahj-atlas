import packageInfo from '../package.json' with { type: 'json' };
export const VERSION = packageInfo.version;
export const PRICE_DATE = '2026-10-07';
export const MODELS = {
  research: { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: .1 },
  review: { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: .2 },
  economy: { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', input: .1, output: .5, cacheRead: .01, longContext: { threshold: 100000, input: .5, output: 2.5, cacheRead: .05 } },
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
// restarts from its saved checkpoint; no request is sent above input. After contextResets
// restarts a stage's next request may only finish; restarts do not add to its rounds. The final review's
// evidence package holds up to reviewEvidence characters of source excerpts (at most
// reviewSourceChars from one source) and up to stageBriefChars of each stage's brief.
// A page read shows the model its pageLinks most relevant links; up to savedLinks links
// from the whole page are remembered, so chat may open any of them. Fetches (Anthropic's
// web_fetch) count toward the read allowances; fetchContentTokens caps a fetched page's text.
// A document the user adds keeps up to uploadChars of its text; a web source keeps 180,000.
// One research read returns readChars by default and at most pageChars when the model asks
// for more; offset pages through the rest and query searches the whole page or PDF range.
export const LIMITS = { searches: 80, searchesPerRequest: 4, fetchesPerRequest: 3, fetchContentTokens: 60000, reads: 100, rounds: 12, output: 60000, reviewOutput: 100000, input: 300000, checkpointInput: 200000, contextResets: 4, reviewRounds: 4, pageChars: 60000, readChars: 8000, pageLinks: 60, savedLinks: 1000, reviewEvidence: 600000, reviewSourceChars: 100000, stageBriefChars: 80000, documentBytes: 50 * 1024 * 1024, uploadChars: 2000000, activeMs: 45 * 60 * 1000, verificationRounds: 6, verificationSearches: 15, verificationReads: 20, continuations: 2, batchRetentionMs: 29 * 24 * 60 * 60 * 1000 };
// Any fetched PDF, or this many characters of fetched text in one conversation, ends
// raw fetch replay: research checkpoints; chat wraps up without editing signed history.
export const FETCH_HISTORY_CHARS = 120000;
// Chat sets no token ceilings of its own: output is the 128K maximum of these models,
// and input may fill the model's context window (as the Models API reports it,
// else the documented 1M) less that output. contextWindow is that fallback, not a cap.
// The other chat ceilings are runaway guards, not spending limits. activeMs bounds the lookup
// phase; wrapUpMs before it the reply switches to a final answer, which then gets
// at least answerMs to stream. Preview sizes are characters of saved project records.
// toolChars is the most text one lookup returns, including a public page read in chat.
// evidenceTailChars bounds serialized source updates after cached history. Above it,
// the next reply folds updates into a new opening instead of resending a large tail.
// Chat's web allowance is per reply and separate from research's project totals:
// searchesPerRequest and fetchesPerRequest are the web_search and web_fetch max_uses, fixed
// for a whole reply. Fetches count toward the reply's page reads (webReads).
// proposals caps the actions a reply can propose for the user's approval; proposalCalls
// also counts rejected proposals, so invalid attempts cannot fill a reply.
export const CHAT_LIMITS = { messageChars:30000, output:128000, contextWindow:1000000, requests:20, toolCalls:60, toolChars:60000, historyChars:200000, activeMs:20*60*1000, wrapUpMs:3*60*1000, answerMs:10*60*1000, excerptChars:400000, evidenceTailChars:80000, preview:{report:240000,research:240000,sources:120000,context:20000,questions:40000,notes:40000}, economy:{excerptChars:80000,historyChars:60000,evidenceTailChars:20000,preview:{report:40000,research:40000,sources:20000,context:20000,questions:20000,notes:20000}}, cacheTTL:'1h', searchesPerRequest:4, searches:20, fetchesPerRequest:3, webReads:30, proposals:4, proposalCalls:8 };
// Economy uses medium effort and focused previews; Standard/Premium use high. Premium keeps the
// saved id 'opus', so earlier replies and their retries keep their labels.
export const CHAT_MODES = {
  standard: { label: 'Standard', modelKey: 'research', effort: 'high' },
  economy: { label: 'Economy', modelKey: 'economy', effort: 'medium' },
  opus: { label: 'Premium', modelKey: 'review', effort: 'high' },
};
// Retired depths label earlier replies only; a new message cannot choose them.
const RETIRED_CHAT_MODES = { deep: { label: 'Deep', modelKey: 'research', effort: 'max' } };
export const chatMode = id => CHAT_MODES[id] ? { id, ...CHAT_MODES[id] } : Object.hasOwn(RETIRED_CHAT_MODES, id) ? { id, ...RETIRED_CHAT_MODES[id] } : { id: 'standard', ...CHAT_MODES.standard };
export const usd = micros => Number((micros / 1e6).toFixed(6));

// Store a rate card outside the API payload before sending a request. Pending batches
// and interrupted streams keep these rates across upgrades; recorded charges are never repriced.
export function pricingSnapshot(modelKey, modelId=MODELS[modelKey]?.id, {inputTokens=0,priceDate=PRICE_DATE}={}) {
  const current=Object.values(MODELS).find(m=>m.id===modelId)||MODELS[modelKey];
  if(!current)return null;
  const {input,output,cacheRead,longContext}=current;
  const rate={modelId,priceDate,promptTokens:inputTokens,input,output,cacheRead,...(longContext?{longContext:{...longContext}}:{})};
  if(modelId==='claude-sonnet-5'||modelId==='claude-sonnet-5-5'&&priceDate<'2026-10-07')Object.assign(rate,{input:2,output:10,cacheRead:.2});
  return rate;
}
// The TTL breakdown should sum to cache_creation_input_tokens. Responses that ran
// several native searches have reported a smaller breakdown (41,129 written, 8,853
// itemized). The API documents the writes it adds after server tool results as
// 5-minute writes, so the unitemized remainder is priced at that rate.
function cacheWrites(usage) {
  const creation = usage.cache_creation;
  const write1 = Number(creation?.ephemeral_1h_input_tokens || 0);
  const write5 = creation ? Math.max(Number(creation.ephemeral_5m_input_tokens || 0), Number(usage.cache_creation_input_tokens || 0) - write1) : Number(usage.cache_creation_input_tokens || 0);
  return {write5,write1};
}
export function promptTokens(usage={}) {
  const {write5,write1}=cacheWrites(usage);
  return Number(usage.input_tokens||0)+Number(usage.cache_read_input_tokens||0)+Number(usage.cache_creation_input_tokens??(write5+write1));
}
function ratesForInput(rate,tokens) {
  const {longContext,...base}=rate;
  return longContext&&tokens>longContext.threshold?{...base,input:longContext.input,output:longContext.output,cacheRead:longContext.cacheRead}:base;
}
function tokenCharge(usage,rate) {
  const {write5,write1}=cacheWrites(usage);
  const tokens = Number(usage.input_tokens || 0) * rate.input + Number(usage.output_tokens || 0) * rate.output + Number(usage.cache_read_input_tokens || 0) * rate.cacheRead + write5 * rate.input * 1.25 + write1 * rate.input * 2;
  return tokens;
}
// Native server tools can sample several prompts in one request. Only a complete
// per-iteration breakdown can price their tiers precisely; cumulative input is not
// the length of one prompt. Atlas requests no compaction/advisor or fallback model.
function messageIterations(usage,rate) {
  if(!Array.isArray(usage.iterations))return null;
  if(usage.iterations.some(i=>i?.type!=='message'))return null;
  const iterations=usage.iterations;
  if(!iterations.length||iterations.some(i=>i.model&&i.model!==(rate.modelId||rate.id)))return null;
  const fields=['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'];
  if(iterations.some(i=>fields.some(k=>!Number.isFinite(Number(i[k]??0))||Number(i[k]??0)<0)))return null;
  if(fields.some(k=>iterations.reduce((n,i)=>n+Number(i[k]||0),0)!==Number(usage[k]||0)))return null;
  const writes=cacheWrites(usage);
  if(['write5','write1'].some(k=>iterations.reduce((n,i)=>n+cacheWrites(i)[k],0)!==writes[k]))return null;
  return iterations;
}
export function hasAmbiguousPricing(usage,modelKey,pricing=null) {
  const rate=pricing||MODELS[modelKey];
  return Boolean(rate.longContext&&promptTokens(usage)>rate.longContext.threshold&&!(rate.promptTokens>rate.longContext.threshold)&&!messageIterations(usage,rate)&&(Number(usage.server_tool_use?.web_search_requests||0)>0||Number(usage.server_tool_use?.web_fetch_requests||0)>0||usage.iterations?.length>0));
}
export function costMicros(usage = {}, modelKey = 'research', mode = 'realtime', pricing=null) {
  const rate=pricing||MODELS[modelKey],iterations=rate.longContext?messageIterations(usage,rate):null;
  // Without an iteration breakdown, the cumulative tier is a conservative estimate.
  const tokens=iterations?iterations.reduce((n,i)=>n+tokenCharge(i,ratesForInput(rate,promptTokens(i))),0):tokenCharge(usage,ratesForInput(rate,promptTokens(usage)));
  return Math.ceil(tokens * (mode === 'batch' ? .5 : 1) + Number(usage.server_tool_use?.web_search_requests || 0) * 10000);
}
export const STREAM_CHARACTERS_PER_TOKEN = 4;
// Only a started real-time stream supplies partialUsage. An errored attempt can
// record a charge estimate without retaining a pending reservation or applying output.
export function interruptedCostEstimate(attempt,error) {
  if(attempt.mode!=='realtime'||!error.partialUsage)return null;
  const usage={...error.partialUsage},characters=error.streamedCharacters;
  const output=Math.max(Number(usage.output_tokens)||0,Number.isFinite(characters)&&characters>0?Math.ceil(characters/STREAM_CHARACTERS_PER_TOKEN):0);
  let actual=attempt.reserve;
  if(Number.isFinite(usage.input_tokens)&&usage.input_tokens>=0&&output>0){
    usage.output_tokens=output;
    const rate=attempt.pricing||MODELS[attempt.model_key];
    // A partial stream may omit cache counters. Its known counted prompt still
    // supplies a conservative minimum tier; complete responses use provider usage.
    const cost=costMicros(usage,attempt.model_key,attempt.mode,ratesForInput(rate,Math.max(promptTokens(usage),Number(rate.promptTokens)||0)));
    if(Number.isSafeInteger(cost)&&cost>=0)actual=cost;
  }
  return {actual,usage,estimated:1};
}
export function reserveMicros(inputTokens, modelKey, mode, outputTokens, searches, cacheTTL='5m', pricing=null) {
  const r = ratesForInput(pricing||MODELS[modelKey],inputTokens+searches*20000), factor = mode === 'batch' ? .5 : 1;
  // Native search has variable intermediate input. This is a conservative pending-cost
  // estimate for display, not a guarantee about provider billing for an in-flight request.
  const writeFactor=cacheTTL==='1h'?2:1.25;
  return Math.ceil(((inputTokens * writeFactor * (searches + 1) + searches * 20000) * r.input + outputTokens * r.output) * factor + searches * 10000 + 30000);
}
// Chat caches its evidence and history for an hour. The first pass is priced as a
// full one-hour cache write; each search iteration rereads the context plus its
// results at the base input price rather than multiplying the write by every search.
export function chatReserveMicros(inputTokens, modelKey, outputTokens, searches, pricing=null) {
  const r = ratesForInput(pricing||MODELS[modelKey],inputTokens+searches*20000);
  return Math.ceil((inputTokens * 2 + searches * (inputTokens + 20000)) * r.input + outputTokens * r.output + searches * 10000 + 30000);
}
export const cacheTTL = mode => mode==='batch'?'1h':'5m';
