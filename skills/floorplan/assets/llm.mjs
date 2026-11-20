// llm.mjs: how Floorplan talks to a model over an OpenAI-compatible endpoint, shared by the map's server
// (serve.mjs, the `http` engine) and the headless driver (driver.mjs). Copied next to serve.mjs by the build,
// so it may import only Node's standard library: the map folder has to work with no skill installed.
//
// One adapter covers OpenAI, DeepSeek, most gateways, and local models (Ollama, LM Studio, vLLM). It speaks
// /v1/chat/completions, asks for a JSON Schema when the endpoint accepts one, falls back to JSON mode and then
// to reading JSON out of prose, runs a bounded read-only tool loop when the model supports one, sends a
// validation problem back instead of failing, and masks anything secret-looking out of tool results and answers.
//
// No dependencies: Node 18+ has fetch, AbortController and structuredClone.
import fs from 'node:fs';
import path from 'node:path';

// The workflow file's answerRetries: a model gets this many chances to fix an invalid answer.
export const ANSWER_RETRIES = 2;
// A hard stop on tool loops: a model that never submits still ends with an answer attempt.
export const MAX_TOOL_TURNS = 12;

/** A failure with a code the map's UI knows: not_configured, not_logged_in, rate_limited, server_error, timeout, aborted, tool_budget, bad_request, bad_response. */
export class LlmError extends Error {
  constructor(message, code = 'bad_response', status = 0) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}

/** An HTTP status (or a message) as one of the codes the Ask bar knows how to explain. */
export function failCode(message, status = 0) {
  if (status === 401 || status === 403) return 'not_logged_in';
  if (status === 404) return 'endpoint_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  const msg = String(message || '');
  if (/not logged in|logged out|invalid api key|incorrect api key|\/login|log ?in again|sign in|authenticat|unauthori[sz]ed|\b401\b|\b403\b/i.test(msg)) return 'not_logged_in';
  if (/usage limit|rate limit|too many requests|quota|\b429\b/i.test(msg)) return 'rate_limited';
  if (/model .* not found|no such model|model_not_found/i.test(msg)) return 'model_not_found';
  return 'cli_error';
}

/** OpenAI structured outputs want every property required and nothing extra; optional lists just come back empty. */
export function strict(s) {
  if (s?.type === 'object' && s.properties) return { ...s, properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, strict(v)])), required: Object.keys(s.properties), additionalProperties: false };
  if (s?.type === 'array') return { ...s, items: strict(s.items) };
  return s;
}

/** The answer in a completion event: structured output, else fenced JSON, else the braces in the text, else plain text. */
export function parseAnswer(ev) {
  if (ev.structured_output && typeof ev.structured_output === 'object') return ev.structured_output;
  const t = String(ev.result || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  for (const cand of [t, fence?.[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) { try { const v = JSON.parse(cand); if (v && typeof v === 'object') return v; } catch {} }
  return { title: 'Answer', answer: t, items: [] };
}

// ---------- checking an answer against a schema ----------
// Exactly the keywords workflow.json promises a driver needs, so a model's answer is checked the same way in
// both places: type, properties, required, items, enum, pattern, minItems, minLength, additionalProperties.
const KEYWORDS = new Set(['$schema', 'description', 'type', 'properties', 'required', 'items', 'enum', 'pattern', 'minItems', 'minLength', 'additionalProperties', 'title', 'default']);
/** Keywords a schema uses that validate() does not understand: a driver must refuse to guess. */
export function unknownKeywords(schema, at = '$', out = []) {
  for (const [k, v] of Object.entries(schema || {})) {
    if (!KEYWORDS.has(k)) out.push(`${at}.${k}`);
    if (k === 'properties' && v && typeof v === 'object') for (const [p, s] of Object.entries(v)) unknownKeywords(s, `${at}.properties.${p}`, out);
    if ((k === 'items' || k === 'additionalProperties') && v && typeof v === 'object') unknownKeywords(v, `${at}.${k}`, out);
  }
  return out;
}
const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v);
/** Problems with `value` against `schema`, as plain sentences; [] means it fits. */
export function validate(schema, value, at = '$') {
  const t = typeOf(value);
  if (schema.type && ![].concat(schema.type).some((x) => x === t || (x === 'number' && t === 'integer'))) return [`${at}: expected ${schema.type}, got ${t}`];
  const errs = [];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (t === 'string') {
    if (schema.minLength && value.length < schema.minLength) errs.push(`${at}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: doesn't match ${schema.pattern}`);
  }
  if (t === 'array') {
    if (schema.minItems && value.length < schema.minItems) errs.push(`${at}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}: missing "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected "${k}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  return errs;
}

// ---------- masking, before anything reaches a model or a file ----------
// A safety net for the model's own input and output: the well-known key formats, private key blocks, passwords
// in connection addresses, and quoted values given to a name that sounds secret. health.mjs's maskSecrets goes
// further (it also hides long random strings and the lines Health flags); callers that have the skill's
// scripts available pass it in as `mask` and get that.
const HIDDEN = '«hidden»';
const FORMATS = [
  /\b(sk|rk)-(?:live|test|proj|ant|or)-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic, Stripe restricted
  /\bsk-[A-Za-z0-9]{32,}/g, // OpenAI, and providers that copy the shape
  /\b[rs]k_live_[A-Za-z0-9]{16,}/g, /\b[rs]k_test_[A-Za-z0-9]{16,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{16,}/g, // Stripe webhook
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{30,}/g, /\bya29\.[0-9A-Za-z_-]{20,}/g, // Google
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bntn_[A-Za-z0-9]{20,}/g, // Notion
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe (older shape)
];
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const DB_URL = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]{1,100})@/gi;
const SECRET_NAME = /pass(word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|credential|auth/i;
const QUOTED_ASSIGN = /(["']?)(?<![\w.-])([A-Za-z_][\w.-]{0,100})\1(\s*(?::=|=>|=|:)\s*(?:[rbuRBU]{1,2})?)(["'`])([^"'`\n]{0,2000})\4/g;

/** Text safe to show a model or write to the map: every value that is or might be a secret becomes «hidden». */
export function maskText(src) {
  let out = String(src)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, `${HIDDEN} (a private key)`);
  for (const re of FORMATS) out = out.replace(re, HIDDEN);
  out = out.replace(JWT, HIDDEN).replace(DB_URL, (m, user, pw) => m.replace(`:${pw}@`, `:${HIDDEN}@`));
  out = out.replace(QUOTED_ASSIGN, (m, q, name, op, q2, value) => (value && SECRET_NAME.test(name.split('.').pop()) ? `${q}${name}${q}${op}${q2}${HIDDEN}${q2}` : m));
  return out;
}
/** The same over every string in a JSON value, keeping its shape: for an answer about to be written or shown. */
export function maskDeep(value, mask = maskText) {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, mask));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, mask)]));
  return value;
}

// ---------- the endpoint ----------
/** A configured base URL as the chat/completions URL to POST to. Accepts ".../v1", ".../v1/", ".../chat/completions", "http://host:11434". */
export function chatUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) throw new LlmError('No model endpoint is configured. Set FLOORPLAN_BASE_URL or baseUrl in floorplan/config.json.', 'not_configured');
  let u;
  try { u = new URL(raw); } catch { throw new LlmError(`"${raw}" is not an address. Use something like http://127.0.0.1:11434/v1`, 'not_configured'); }
  if (!/^https?:$/.test(u.protocol)) throw new LlmError(`"${raw}" must be an http:// or https:// address.`, 'not_configured');
  if (/\/chat\/completions\/?$/.test(u.pathname)) { u.pathname = u.pathname.replace(/\/+$/, ''); return u.toString(); }
  if (u.pathname === '' || u.pathname === '/') u.pathname = '/v1';
  u.pathname = u.pathname.replace(/\/+$/, '') + '/chat/completions';
  return u.toString();
}
/** The host (and port) of an endpoint, for the map's UI: never the key, and not the full path. */
export function hostOf(baseUrl) {
  try { return new URL(String(baseUrl)).host; } catch { return ''; }
}

function abortable(signal, timeoutMs) {
  const c = new AbortController();
  let timedOut = false;
  const t = timeoutMs > 0 ? setTimeout(() => { timedOut = true; c.abort(); }, timeoutMs) : null;
  const onAbort = () => c.abort();
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  return {
    signal: c.signal,
    clear() { if (t) clearTimeout(t); signal?.removeEventListener?.('abort', onAbort); },
    timedOut: () => timedOut,
  };
}

/**
 * A client for one endpoint. `caps` remembers what the endpoint turned out to accept (function tools, a JSON
 * Schema, JSON mode), so a model that refuses one is not asked for it again on every question.
 */
export function createClient({ baseUrl, apiKey = '', model = '', headers = {}, timeoutMs = 180000, fetchImpl = globalThis.fetch } = {}) {
  const url = chatUrl(baseUrl);
  // What this endpoint turned out to accept. null = not tried yet, false = it refused it (asked once, remembered).
  // The parameter flags cover the common reasons a real provider rejects a request OpenAI accepts: newer OpenAI
  // models want max_completion_tokens, reasoning models refuse a temperature below 1, and some refuse `strict`.
  const caps = { tools: null, structured: null, strictSchema: true, maxTokens: true, temperature: true };
  async function chat({ messages, tools = [], toolChoice, schema, signal, temperature, maxTokens = 8192 }) {
    const body = { model: model || 'default', messages };
    if (caps.temperature) body.temperature = temperature ?? 0.2;
    if (caps.maxTokens) body.max_tokens = maxTokens;
    if (tools.length && caps.tools !== false) { body.tools = tools.map((t) => ({ type: 'function', function: t.function || t })); if (toolChoice) body.tool_choice = toolChoice; }
    if (schema && body.tools && !toolChoice) body.tool_choice = 'auto';
    // A schema alongside tools makes some OpenAI-compatible servers (vLLM among them) silently drop the tool
    // calls: the model answers straight away with a stub that still fits the schema, so nothing downstream
    // notices. The answer is validated either way, so ask for the schema only when no tools are offered.
    if (schema && !body.tools && caps.structured !== false) {
      body.response_format = caps.structured === 'json'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: 'floorplan_answer', ...(caps.strictSchema ? { strict: true } : {}), schema: strict(schema) } };
    }
    const box = abortable(signal, timeoutMs);
    let r;
    try {
      r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: box.signal });
    } catch (e) {
      if (box.timedOut()) throw new LlmError(`The model at ${hostOf(baseUrl)} did not answer within ${Math.round(timeoutMs / 1000)}s.`, 'timeout');
      if (e?.name === 'AbortError' || String(e?.message || '').includes('abort')) throw new LlmError('Stopped.', 'aborted');
      throw new LlmError(`Could not reach ${hostOf(baseUrl)}: ${e?.cause?.message || e?.message || e}. Check the address in floorplan/config.json.`, 'unreachable');
    } finally { box.clear(); }
    const text = await r.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!r.ok) {
      let detail = String(data?.error?.message || data?.error || text || '').slice(0, 400).trim();
      // a 401 for a request that carried no key is a configuration problem, not a provider one: say how to give it one
      if ((r.status === 401 || r.status === 403) && !apiKey) {
        detail = `The endpoint refused the request and no key was sent. Put the key in a variable and name it with "apiKeyEnv" in floorplan/config.json (or set FLOORPLAN_API_KEY); a local model needs none. The provider said: ${detail || `HTTP ${r.status}`}`;
      }
      // A real provider refuses one parameter at a time rather than the whole feature: drop what it named and
      // ask again, remembering it. A model that loses max_tokens just gets the provider's own default.
      const again = () => chat({ messages, tools, toolChoice, schema, signal, temperature, maxTokens });
      if (r.status === 400 && /strict/i.test(detail) && /response_format|json_schema|schema/i.test(detail) && caps.strictSchema) { caps.strictSchema = false; return again(); }
      if (r.status === 400 && /max_tokens|max_completion_tokens|max output tokens/i.test(detail) && caps.maxTokens) { caps.maxTokens = false; return again(); }
      if (r.status === 400 && /temperature/i.test(detail) && caps.temperature) { caps.temperature = false; return again(); }
      // a model without structured output or tools still answers: drop the feature and try once more
      if (r.status === 400 && /response_format|json_schema|json mode/i.test(detail) && caps.structured !== false) { caps.structured = caps.structured === null ? 'json' : false; return again(); }
      if (r.status === 400 && /\btools?\b|tool_choice|function calling/i.test(detail) && caps.tools !== false) { caps.tools = false; return chat({ messages, tools: [], toolChoice: undefined, schema, signal, temperature, maxTokens }); }
      throw new LlmError(detail || `The model endpoint answered ${r.status}${r.statusText ? ` ${r.statusText}` : ''}.`, failCode(detail, r.status), r.status);
    }
    if (!data || data.error) throw new LlmError(String(data?.error?.message || 'The model endpoint sent no answer.').slice(0, 400), 'bad_response', r.status);
    if (!Array.isArray(data.choices) || !data.choices.length) throw new LlmError(`${hostOf(baseUrl)} answered without a completion: is that address an OpenAI-compatible endpoint?`, 'bad_response', r.status);
    const choice = data.choices[0];
    const msg = choice?.message || {};
    const content = Array.isArray(msg.content) ? msg.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : String(msg.content ?? '');
    if (body.tools) caps.tools = caps.tools === null ? true : caps.tools;
    if (body.response_format) caps.structured = caps.structured === null ? (body.response_format.type === 'json_schema' ? 'schema' : 'json') : caps.structured;
    /** A tool call the model asked for, in one shape whether it came back new-style or legacy. */
    const toolCalls = (msg.tool_calls || (msg.function_call ? [{ id: 'call_0', function: msg.function_call }] : [])).map((t, i) => ({
      id: t.id || `call_${i}`,
      name: t.function?.name || t.name || '',
      args: (() => { try { return JSON.parse(t.function?.arguments || '{}'); } catch { return {}; } })(),
      raw: t.function?.arguments || '{}',
    }));
    return { message: msg, content, toolCalls, finish: choice?.finish_reason || '', usage: data.usage || null, structured: body.response_format?.type === 'json_schema' };
  }
  return { url, baseUrl, model, caps, chat };
}

// ---------- one answer, with tools and validation ----------
/** The inputs a job or a question was given, as one block of text the model reads top to bottom. */
export function renderInputs(inputs) {
  return Object.entries(inputs || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([name, v]) => `## ${name}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`)
    .join('\n\n');
}

/**
 * Real models wrap answers: {"architecture": {...}}, {"arguments": {...}}, or {"arguments": "<json text>"}. If the
 * wrapped document is itself a valid answer to the job, take it. Anything else is left alone, so the schema is
 * still what decides, and only one extra key is ever forgiven.
 */
export function unwrapAnswer(value, schema, check) {
  const fits = (v) => [...validate(schema, v), ...(check ? check(v) : [])].length === 0;
  if (fits(value)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  let inner = value[keys[0]];
  if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { return value; } }
  return inner && typeof inner === 'object' && !Array.isArray(inner) && fits(inner) ? inner : value;
}

/** The instruction that tells a model what shape its answer must have, when the endpoint can't be told directly. */
export function answerFormat(schema, { tools = false } = {}) {
  return [
    tools
      ? 'When you are done looking things up, call the submit tool with your answer as its arguments — the answer object itself, not wrapped in a field named after the document — or reply with the JSON object alone.'
      : 'Reply with the JSON object alone: no prose before or after it, no Markdown fence.',
    'It must match this JSON Schema exactly (every property listed as required is required):',
    JSON.stringify(strict(schema)),
  ].join('\n');
}

/**
 * Runs one job to a validated answer.
 *
 * opts: { instructions, input (string or {name: value}), schema, tools: [{ name, description, parameters, run }],
 *         budget, signal, onProgress(text), mask, retries, client }
 * Resolves { answer, turns, problems, submission } where `answer` is masked (maskDeep) and validated.
 * Throws LlmError when the model never gives a valid answer.
 */
export async function completeJson(client, { instructions, input, schema, tools = [], budget = 0, signal, onProgress = () => {}, mask = maskText, retries = ANSWER_RETRIES, maxTokens, check } = {}) {
  const messages = [{ role: 'system', content: `${instructions}\n\n${answerFormat(schema, { tools: tools.length > 0 })}` }];
  messages.push({ role: 'user', content: typeof input === 'string' ? input : renderInputs(input) });
  const canTools = tools.length > 0 && budget > 0;
  const toolDefs = canTools ? tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } })) : [];
  if (canTools) {
    // the answer comes back as a tool call when the model can make one: same schema, nothing to parse
    toolDefs.push({ name: 'submit', description: 'Give your final answer. Call this once, when you have finished looking things up.', parameters: schema });
  }
  let used = 0, turns = 0, problems = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (let round = 0; round < MAX_TOOL_TURNS; round++) {
      const r = await client.chat({ messages, tools: toolDefs, schema, signal, maxTokens });
      turns++;
      if (r.toolCalls.length) {
        const submit = r.toolCalls.find((c) => c.name === 'submit');
        if (submit) {
          // A submit call is an answer like any other, and gets checked like one: a model can wrap it in a
          // field, fill in one field and forget the rest, or (for a job with onlyChange) edit what it may not.
          // Real models do all three, so an unchecked submit would write a wrong document straight to disk.
          const given = unwrapAnswer(maskDeep(submit.args, mask), schema, check);
          problems = [...validate(schema, given), ...(check ? check(given) : [])];
          if (!problems.length) return finish(given, turns, problems);
          messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw } })) });
          messages.push({ role: 'tool', tool_call_id: submit.id, content: JSON.stringify({ error: `That answer doesn't fit: ${problems.slice(0, 10).join('; ')}`, hint: 'Call submit again with the complete answer itself as its arguments, not wrapped in another object.' }) });
          onProgress('Checking the answer');
          break;
        }
        messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw } })) });
        let spent = 0;
        for (const call of r.toolCalls) {
          const tool = tools.find((t) => t.name === call.name);
          let result;
          if (!tool) result = { error: `There is no tool called "${call.name}".` };
          else if (used >= budget) result = { error: 'You have used your tool budget. Use what you have and submit the answer now.' };
          else { spent++; result = await runTool(tool, call.args, mask); }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(maskDeep(result, mask)).slice(0, 20000) });
        }
        used += spent;
        if (spent) onProgress(describeCalls(tools, r.toolCalls.filter((c) => c.name !== 'submit')));
        if (used >= budget) messages.push({ role: 'user', content: 'That was your last tool call. Answer now: submit the complete JSON object.' });
        continue;
      }
      const answer = unwrapAnswer(parseAnswer({ result: r.content }), schema, check);
      problems = [...validate(schema, answer), ...(check ? check(answer) : [])];
      if (!problems.length) return finish(maskDeep(answer, mask), turns, problems);
      messages.push({ role: 'assistant', content: r.content || '' });
      messages.push({ role: 'user', content: `That answer doesn't fit yet:\n${problems.slice(0, 20).map((p) => `- ${p}`).join('\n')}\n\nReply again with the complete JSON object and nothing else.` });
      onProgress('Checking the answer');
      break;
    }
  }
  throw Object.assign(new LlmError(`The model's answer didn't fit the expected shape after ${retries + 1} tries: ${problems.slice(0, 5).join('; ')}`, 'invalid_answer'), { problems });

  function finish(answer, usedTurns, allProblems) { return { answer, turns: usedTurns, problems: allProblems }; }
}
async function runTool(tool, args, mask) {
  try { const v = await tool.run(args || {}); return v === undefined ? { ok: true } : v; } catch (e) { return { error: mask(String(e?.message || e)).slice(0, 500) }; }
}
/** "Reading src/app.js · Searching code for \"price\"": what to tell the person waiting. */
export function describeCalls(tools, calls) {
  const say = (c) => { try { return tools.find((t) => t.name === c.name)?.describe?.(c.args) || `Using ${c.name}`; } catch { return `Using ${c.name}`; } };
  return calls.slice(0, 2).map(say).join(' · ') + (calls.length > 2 ? ` (+${calls.length - 2} more)` : '');
}

// ---------- the workspace tools a model may use ----------
// Read-only, bounded to the codebase root, with the map's own generated files kept out (index.html inlines the
// layout engine and fonts, about 2 MB on one line, which can push one question past the context limit).
export function workspaceTools(root, { mask = maskText, extra = [], maxBytes = 60000 } = {}) {
  const R = path.resolve(root);
  const inside = (p) => { const abs = path.resolve(R, p); return abs === R || abs.startsWith(R + path.sep) ? abs : null; };
  const skip = ['floorplan/index.html', 'floorplan/serve.mjs', 'floorplan/llm.mjs', 'floorplan/page-safety.mjs', 'floorplan/.cache/**', 'floorplan/artifact.html'];
  // a model may read the code, never the settings and key files beside it: their values are masked by name
  // anyway, but a file whose whole job is holding secrets is not something a question about the app needs
  const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(pem|key|p12|pfx|keystore)|secrets?\.(json|ya?ml|toml)|credentials?(\.(json|ya?ml))?)$/i;
  const blocked = (rel) => skip.some((s) => (s.endsWith('/**') ? rel.startsWith(s.slice(0, -2)) : rel === s)) || SECRET_FILE.test(rel);
  const list = (max = 2000) => {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (out.length >= max) return; if (/^(\.git|node_modules|\.cache)$/.test(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(R, p).replace(/\\/g, '/')); } };
    try { walk(R); } catch {}
    return out;
  };
  const globToRe = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '§').replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/§/g, '.*') + '$');
  return [
    {
      name: 'read_file', description: 'Read a text file under the codebase root, optionally a range of lines. Read cwd-relative paths such as src/app.js.',
      describe: ({ path: p } = {}) => `Reading ${String(p || 'a file').replace(/\\/g, '/')}`,
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the codebase root' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] },
      run({ path: p, start_line, end_line }) {
        const abs = inside(String(p || ''));
        const rel = abs ? path.relative(R, abs).replace(/\\/g, '/') : String(p);
        if (!abs) return { error: `Can't read "${rel}": use a path inside the codebase.` };
        if (blocked(rel)) return { error: `Can't read "${rel}": the map is read-only for source and skips generated map files and key or settings files.` };
        let text;
        try { const st = fs.statSync(abs); if (!st.isFile() || st.size > 2e6) return { error: `Can't read "${rel}": not a text file, or too large.` }; text = fs.readFileSync(abs, 'utf8'); } catch { return { error: `There is no file at "${rel}".` }; }
        const lines = text.split('\n');
        const a = Math.max(1, Number(start_line) || 1), b = Math.min(lines.length, Number(end_line) || lines.length);
        return { path: rel, lines: lines.length, text: mask(lines.slice(a - 1, b).join('\n')).slice(0, maxBytes) };
      },
    },
    {
      name: 'list_files', description: 'List files under the codebase root matching a glob (for example "src/**/*.ts").',
      describe: ({ glob } = {}) => `Listing ${glob || 'files'}`,
      parameters: { type: 'object', properties: { glob: { type: 'string' } }, required: ['glob'] },
      run({ glob }) {
        const re = globToRe(glob || '**');
        return { files: list().filter((f) => re.test(f) && !blocked(f)).slice(0, 500) };
      },
    },
    {
      name: 'grep', description: 'Search files under the codebase root for a regular expression.',
      describe: ({ pattern } = {}) => (pattern ? `Searching code for "${pattern}"` : 'Searching code'),
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] },
      run({ pattern, glob }) {
        let re;
        try { re = new RegExp(String(pattern || ''), 'i'); } catch { return { error: 'That pattern is not a valid regular expression.' }; }
        const g = glob ? globToRe(glob) : null;
        const hits = [];
        for (const f of list(5000)) {
          if (g && !g.test(f) || blocked(f) || hits.length >= 60) continue;
          let text; try { const abs = path.join(R, f); if (fs.statSync(abs).size > 1e6) continue; text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
          text.split('\n').forEach((line, i) => { if (hits.length < 60 && re.test(line)) hits.push({ file: f, line: i + 1, text: mask(line.trim()).slice(0, 300) }); });
        }
        return { matches: hits, truncated: hits.length >= 60 };
      },
    },
    ...extra,
  ];
}

/** The key for an endpoint: the variable it's named after wins over the generic one, so several can coexist. */
export function apiKeyFrom({ apiKeyEnv = '' } = {}, env = process.env) {
  if (env.FLOORPLAN_API_KEY) return env.FLOORPLAN_API_KEY;
  if (apiKeyEnv && env[apiKeyEnv]) return env[apiKeyEnv];
  return '';
}