// The shared model client (skills/floorplan/assets/llm.mjs): one OpenAI-compatible adapter, used by the map's
// server and the headless driver. Everything here runs against a mock endpoint (tests/mock-llm.mjs), so the
// suite never needs a key, a network, or a model: what it checks is the wire format, the fallbacks, the tool
// budget, the validation retries and the masking.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockLlm, completion, toolCall, systemOf, lastUser, hasTool } from './mock-llm.mjs';

const L = await import(new URL('../skills/floorplan/assets/llm.mjs', import.meta.url));
const { createClient, completeJson, chatUrl, failCode, maskText, maskDeep, parseAnswer, strict, validate, workspaceTools, LlmError } = L;

const closers = [];
after(async () => { for (const c of closers) await c(); });
async function mock(handler) { const m = await startMockLlm(handler); closers.push(m.close); return m; }
const clientFor = (m, extra = {}) => createClient({ baseUrl: m.url, model: 'test-model', timeoutMs: 5000, ...extra });

// ---------- the address ----------
test('any OpenAI-compatible base URL becomes one chat/completions address', () => {
  assert.equal(chatUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(chatUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(chatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(chatUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(chatUrl('http://host/v1/chat/completions'), 'http://host/v1/chat/completions');
  assert.equal(chatUrl('http://host:1234/v1/chat/completions/'), 'http://host:1234/v1/chat/completions');
  assert.throws(() => chatUrl(''), /No model endpoint/);
  assert.throws(() => chatUrl('not an address'), /is not an address/);
  assert.throws(() => chatUrl('ftp://host/x'), /http/);
});

// ---------- schemas ----------
const ANSWER = {
  type: 'object', required: ['title'],
  properties: { title: { type: 'string', minLength: 1 }, items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
};

test('strict() makes every property required and forbids extras, as OpenAI structured outputs want', () => {
  assert.deepEqual(strict(ANSWER), {
    type: 'object', required: ['title', 'items'],
    properties: { title: { type: 'string', minLength: 1 }, items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } },
    additionalProperties: false,
  });
  // optional lists come back empty rather than absent, so the workflow's answers keep their shape
  assert.deepEqual(strict({ type: 'object', properties: {}, additionalProperties: false }), { type: 'object', properties: {}, required: [], additionalProperties: false });
});

test('validate() speaks the workflow file’s subset of JSON Schema', () => {
  assert.deepEqual(validate(ANSWER, { title: 'Hi', items: [] }), []);
  assert.match(validate(ANSWER, {})[0], /missing "title"/);
  assert.match(validate(ANSWER, { title: '' })[0], /too short/);
  assert.match(validate(ANSWER, { title: 'x', items: [{ id: 3 }] })[0], /expected string, got integer/);
  assert.match(validate({ ...ANSWER, additionalProperties: false }, { title: 'x', extra: 1 })[0], /unexpected "extra"/);
  assert.deepEqual(validate({ type: 'object', properties: {}, additionalProperties: false }, { a: 1 }), ['$: unexpected "a"']);
  assert.match(validate({ type: 'string', enum: ['a', 'b'] }, 'c')[0], /is not one of a, b/);
  assert.match(validate({ type: 'string', pattern: '^[a-z]+$' }, 'AB')[0], /doesn't match/);
  assert.match(validate({ type: 'array', minItems: 2, items: { type: 'string' } }, ['a'])[0], /at least 2/);
});

test('parseAnswer() reads a structured answer, a fence, bare braces, or plain text', () => {
  assert.deepEqual(parseAnswer({ structured_output: { title: 'A' } }), { title: 'A' });
  assert.deepEqual(parseAnswer({ result: '```json\n{"title":"B"}\n```' }), { title: 'B' });
  assert.deepEqual(parseAnswer({ result: 'Here you go: {"title":"C"} — done.' }), { title: 'C' });
  assert.deepEqual(parseAnswer({ result: 'No JSON here' }), { title: 'Answer', answer: 'No JSON here', items: [] });
});

// ---------- masking ----------
test('masking hides keys and passwords, and leaves ordinary prose alone', () => {
  const key = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');
  assert.equal(maskText(`The key is ${key}.`), 'The key is «hidden».');
  assert.match(maskText('AKIAIOSFODNN7EXAMPLE is an AWS key'), /«hidden»/);
  assert.match(maskText(`postgres://user:${'hunter2'.repeat(3)}@db:5432/app`), /:«hidden»@/);
  assert.match(maskText('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----'), /«hidden» \(a private key\)/);
  assert.match(maskText('const apiKey = "abcdef123456"'), /apiKey = "«hidden»"/);
  const plain = 'The orders screen asks the server for a list and shows it.';
  assert.equal(maskText(plain), plain);
  assert.deepEqual(maskDeep({ a: 'token = "abcdef"', b: ['x', key] }), { a: 'token = "«hidden»"', b: ['x', '«hidden»'] });
  // a GitHub token and a Stripe secret key are caught too
  assert.equal(maskText('ghp_abcdefghijklmnopqrstuvwxyz0123'), '«hidden»');
  assert.equal(maskText('sk_live_abcdefghijklmnop'), '«hidden»');
});

// ---------- one answer ----------
test('a job asks for a JSON Schema, gets JSON back, and returns it masked', async () => {
  const m = await mock(() => ({ content: JSON.stringify({ title: 'Orders', items: [] }) }));
  const r = await completeJson(clientFor(m), { instructions: 'You name things.', input: '## Files\norders.js', schema: ANSWER });
  assert.deepEqual(r.answer, { title: 'Orders', items: [] });
  assert.equal(m.requests.length, 1);
  assert.equal(m.requests[0].url, '/v1/chat/completions');
  assert.equal(m.requests[0].body.model, 'test-model');
  assert.equal(m.requests[0].body.response_format.type, 'json_schema');
  assert.equal(m.requests[0].body.response_format.json_schema.strict, true);
  assert.deepEqual(m.requests[0].body.response_format.json_schema.schema.required, ['title', 'items']);
  assert.match(systemOf(m.requests[0]), /You name things/);
  assert.match(lastUser(m.requests[0]), /## Files\norders\.js/);
});

test('a key goes in the Authorization header, and never in the body', async () => {
  const m = await mock(() => ({ content: '{"title":"x","items":[]}' }));
  await completeJson(clientFor(m, { apiKey: 'secret-key-value' }), { instructions: 'i', input: 'u', schema: ANSWER });
  assert.equal(m.requests[0].headers.authorization, 'Bearer secret-key-value');
  assert.doesNotMatch(m.requests[0].raw, /secret-key-value/);
});

test('an endpoint that refuses a JSON Schema gets JSON mode, then plain JSON in prose', async () => {
  const seen = [];
  const m = await mock((body) => {
    seen.push(body.response_format?.type ?? null);
    if (body.response_format?.type === 'json_schema') return { status: 400, body: { error: { message: 'response_format json_schema is not supported by this model' } } };
    return { content: '{"title":"Fallback","items":[]}' };
  });
  const client = clientFor(m);
  const r = await completeJson(client, { instructions: 'i', input: 'u', schema: ANSWER });
  assert.deepEqual(r.answer, { title: 'Fallback', items: [] });
  assert.deepEqual(seen, ['json_schema', 'json_object']);
  assert.equal(client.caps.structured, 'json', 'what worked is remembered');
  await completeJson(client, { instructions: 'i', input: 'u', schema: ANSWER });
  assert.deepEqual(seen, ['json_schema', 'json_object', 'json_object'], 'the refusal is not tried again');
});

test('a bad answer is sent back with the problems, and the second try is accepted', async () => {
  const m = await mock((body, n) => (n === 0 ? { content: '{"title":""}' } : { content: '{"title":"Better","items":[]}' }));
  const r = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER });
  assert.equal(r.answer.title, 'Better');
  assert.equal(m.requests.length, 2);
  assert.match(lastUser(m.requests[1]), /doesn't fit yet:\n- \$\.title: too short/);
});

test('after the retries an invalid answer fails loudly, with its problems', async () => {
  const m = await mock(() => ({ content: '{"title":"ok","items":"not a list"}' }));
  const err = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER }).catch((e) => e);
  assert.ok(err instanceof LlmError);
  assert.equal(err.code, 'invalid_answer');
  assert.match(err.message, /didn't fit/);
  assert.equal(err.problems.length, 1);
  assert.equal(m.requests.length, 3, 'the first try and two retries');
});

// ---------- tools ----------
const TOOLS = (calls) => L.workspaceTools(calls.root).concat([
  { name: 'submit', description: 'Give your final answer.', parameters: ANSWER, run: () => ({}) },
]);

test('a model with function calling looks things up, and the answer is its submit call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-llm-tools-'));
  closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/orders.js'), 'export function listOrders() { return []; }\n');
  const m = await mock((body, n) => {
    if (n === 0) return completion({ content: '', tool_calls: [toolCall('read_file', { path: 'src/orders.js' })] });
    if (n === 1) return completion({ content: '', tool_calls: [toolCall('submit', { title: 'Orders', items: [] })] });
    return completion({ content: '{"title":"unused","items":[]}' });
  });
  const progress = [];
  const r = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER, tools: L.workspaceTools(dir), budget: 5, onProgress: (t) => progress.push(t) });
  assert.deepEqual(r.answer, { title: 'Orders', items: [] });
  assert.equal(r.turns, 2);
  assert.ok(hasTool(m.requests[0], 'read_file'));
  assert.ok(hasTool(m.requests[0], 'submit'));
  const toolMsg = m.requests[1].body.messages.find((x) => x.role === 'tool');
  assert.match(toolMsg.content, /listOrders/, 'the tool result went back to the model');
  assert.deepEqual(progress, ['Reading src/orders.js']);
});

test('a schema is not sent beside the tools, where a server could honour it and drop the calls', async () => {
  // vLLM answers a request carrying both tools and response_format by honouring the schema and dropping the
  // tool calls, so the model replies with a bare stub that still validates: the question gets a placeholder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-llm-noschema-'));
  closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const m = await mock((body, n) => (n === 0
    ? completion({ content: '', tool_calls: [toolCall('submit', { title: 'Orders', items: [] })] })
    : completion({ content: '{"title":"unused","items":[]}' })));
  await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER, tools: TOOLS({ root: dir }), budget: 5 });
  assert.ok(m.requests[0].body.tools?.length, 'tools are offered');
  assert.equal(m.requests[0].body.response_format, undefined, 'and the schema is not sent beside them');
  assert.match(systemOf(m.requests[0]), /JSON Schema/, 'the shape is still stated in the instructions');
});

test('the tool budget is a hard stop: no more tools run, and the model is told to answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-llm-budget-'));
  closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'x\n');
  let ran = 0;
  const tools = L.workspaceTools(dir).map((t) => ({ ...t, run: (args) => { ran++; return t.run(args); } }));
  const m = await mock(() => completion({ content: '', tool_calls: [toolCall('read_file', { path: 'a.js' })] }));
  const err = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER, tools, budget: 2 }).catch((e) => e);
  assert.equal(ran, 2, 'exactly the budget');
  assert.equal(err.code, 'invalid_answer', 'it kept calling a tool until it ran out of turns');
  assert.match(m.requests.at(-1).body.messages.map((x) => x.content || '').join('\n'), /last tool call/);
});

test('a provider that refuses one parameter gets asked again without it, and never again with it', async () => {
  // the three refusals real providers give: newer OpenAI models want max_completion_tokens, reasoning models
  // refuse a temperature, some refuse strict schemas
  const seen = [];
  const m = await mock((body) => {
    seen.push({ max_tokens: body.max_tokens, temperature: body.temperature, strict: body.response_format?.json_schema?.strict });
    if ('max_tokens' in body) return { status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } };
    if ('temperature' in body) return { status: 400, body: { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported." } } };
    if (body.response_format?.json_schema?.strict) return { status: 400, body: { error: { message: "Invalid schema for response_format: 'strict' is not supported by this endpoint" } } };
    return { content: '{"title":"Stripped","items":[]}' };
  });
  const client = clientFor(m);
  const r = await completeJson(client, { instructions: 'i', input: 'u', schema: ANSWER });
  assert.deepEqual(r.answer, { title: 'Stripped', items: [] });
  assert.deepEqual(seen, [
    { max_tokens: 8192, temperature: 0.2, strict: true },
    { max_tokens: undefined, temperature: 0.2, strict: true },
    { max_tokens: undefined, temperature: undefined, strict: true },
    { max_tokens: undefined, temperature: undefined, strict: undefined },
  ]);
  assert.deepEqual(client.caps, { tools: null, structured: 'schema', strictSchema: false, maxTokens: false, temperature: false });
  // and the next question goes straight through, with none of them
  await completeJson(client, { instructions: 'i', input: 'u', schema: ANSWER });
  assert.deepEqual(seen.at(-1), { max_tokens: undefined, temperature: undefined, strict: undefined });
});

test('an endpoint that refuses tools still answers, from the prompt alone', async () => {
  const seen = [];
  const m = await mock((body, n) => {
    seen.push(!!body.tools);
    if (body.tools) return { status: 400, body: { error: { message: 'tools are not supported by this model' } } };
    return { content: '{"title":"No tools","items":[]}' };
  });
  const client = clientFor(m);
  const r = await completeJson(client, { instructions: 'i', input: 'u', schema: ANSWER, tools: [{ name: 'read_file', description: 'r', run: () => ({}) }], budget: 3 });
  assert.deepEqual(r.answer, { title: 'No tools', items: [] });
  assert.deepEqual(seen, [true, false]);
  assert.equal(client.caps.tools, false);
});

test('tool results are masked before the model sees them, and tool errors come back as data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-llm-mask-'));
  closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.js'), 'const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";\n');
  const m = await mock((body, n) => (n === 0
    ? completion({ content: '', tool_calls: [toolCall('read_file', { path: 'config.js' }), toolCall('read_file', { path: '../outside.txt' }, 'call_2')] })
    : completion({ content: '{"title":"Masked","items":[]}' })));
  await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER, tools: L.workspaceTools(dir), budget: 5 });
  const results = m.requests[1].body.messages.filter((x) => x.role === 'tool').map((x) => x.content);
  assert.doesNotMatch(results[0], /sk-proj-/);
  assert.match(results[0], /«hidden»/);
  assert.match(results[1], /Can't read/);
});

// ---------- failures the map has to explain ----------
test('a 401 on a request with no key says how to give it one, not just the provider’s wording', async () => {
  const m = await mock(() => ({ status: 401, body: { error: { message: 'Authentication Fails (governor)' } } }));
  const err = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER }).catch((e) => e);
  assert.equal(err.code, 'not_logged_in');
  assert.match(err.message, /no key was sent/);
  assert.match(err.message, /apiKeyEnv/);
  assert.match(err.message, /Authentication Fails \(governor\)/, 'and what the provider actually said');
  // with a key, the provider's own message is enough
  const m2 = await mock(() => ({ status: 401, body: { error: { message: 'Incorrect API key provided' } } }));
  const err2 = await completeJson(clientFor(m2, { apiKey: 'sk-wrong' }), { instructions: 'i', input: 'u', schema: ANSWER }).catch((e) => e);
  assert.equal(err2.message, 'Incorrect API key provided');
});

test('HTTP failures map to the codes the Ask bar knows', async () => {
  for (const [status, code] of [[401, 'not_logged_in'], [403, 'not_logged_in'], [404, 'endpoint_not_found'], [429, 'rate_limited'], [500, 'server_error']]) {
    const m = await mock(() => ({ status, body: { error: { message: `nope ${status}` } } }));
    const err = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER }).catch((e) => e);
    assert.equal(err.code, code, String(status));
    assert.equal(err.status, status);
  }
  assert.equal(failCode('Invalid API key', 0), 'not_logged_in');
  assert.equal(failCode('You exceeded your current quota', 0), 'rate_limited');
  assert.equal(failCode('model "gpt-nope" not found', 0), 'model_not_found');
});

test('an endpoint that answers with something other than a completion is a bad response, not a crash', async () => {
  for (const out of [{ raw: '<html>not a completion</html>' }, { body: { nope: true } }, { body: { choices: [] } }]) {
    const m = await mock(() => out);
    const err = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER }).catch((e) => e);
    assert.ok(err instanceof LlmError, JSON.stringify(out));
    assert.equal(err.code, 'bad_response', JSON.stringify(out));
  }
});

test('a slow or unreachable endpoint fails with a code, not a hang', async () => {
  const hang = await mock(() => ({ hang: true }));
  const slow = await completeJson(clientFor(hang, { timeoutMs: 120 }), { instructions: 'i', input: 'u', schema: ANSWER }).catch((e) => e);
  assert.equal(slow.code, 'timeout');
  const none = await completeJson(createClient({ baseUrl: 'http://127.0.0.1:1/v1', timeoutMs: 2000 }), { instructions: 'i', input: 'u', schema: ANSWER }).catch((e) => e);
  assert.equal(none.code, 'unreachable');
});

test('stopping a question aborts the request', async () => {
  const m = await mock(() => new Promise((r) => setTimeout(() => r({ content: '{"title":"late","items":[]}' }), 3000)));
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const err = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER, signal: ac.signal }).catch((e) => e);
  assert.equal(err.code, 'aborted');
});

// ---------- the workspace tools the model reads the code with ----------
test('the workspace tools are read-only, bounded to the codebase, and keep the map out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-llm-ws-'));
  closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'floorplan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/app.js'), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'));
  fs.writeFileSync(path.join(dir, 'floorplan/index.html'), '<html>huge</html>');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'not here');
  const T = Object.fromEntries(L.workspaceTools(dir).map((t) => [t.name, t]));
  assert.equal(T.read_file.run({ path: '../outside.txt' }).error.includes('inside the codebase'), true);
  assert.match(T.read_file.run({ path: 'floorplan/index.html' }).error, /generated map/);
  assert.match(T.read_file.run({ path: 'nope.js' }).error, /no file/);
  // a key or settings file is not readable at all, whatever it is called
  for (const name of ['.env', '.env.local', 'id_rsa', 'certs/server.key', 'secrets.yaml', 'credentials.json']) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), 'STRIPE_SECRET_KEY=whatever\n');
    assert.match(T.read_file.run({ path: name }).error, /key or settings files/, name);
  }
  assert.ok(!T.list_files.run({ glob: '**/*' }).files.includes('.env'), 'and not listed');
  assert.deepEqual(T.grep.run({ pattern: 'STRIPE' }).matches, [], 'and not searched');
  const part = T.read_file.run({ path: 'src/app.js', start_line: 3, end_line: 4 });
  assert.equal(part.text, 'line 3\nline 4');
  assert.equal(part.lines, 40);
  assert.deepEqual(T.list_files.run({ glob: 'src/*.js' }).files, ['src/app.js']);
  assert.deepEqual(T.list_files.run({ glob: '**/*.js' }).files.sort(), ['src/app.js']);
  assert.deepEqual(T.grep.run({ pattern: '^line 3$' }).matches.map((h) => h.line), [3]);
  assert.match(T.grep.run({ pattern: '(' }).error, /not a valid regular expression/);
  // nothing a tool returns can be written: no write/delete tool exists at all
  assert.deepEqual(Object.keys(T).sort(), ['grep', 'list_files', 'read_file']);
});
test('a submit call is checked like any answer: a wrapped or partial one is sent back, not written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-llm-submit-'));
  closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const m = await mock((body, n) => {
    // a real model's first try: the answer nested under the document's name; then: the right shape
    if (n === 0) return completion({ content: '', tool_calls: [toolCall('submit', { architecture: { project: {}, nodes: [] } })] });
    return completion({ content: '', tool_calls: [toolCall('submit', { title: 'Checked', items: [] })] });
  });
  const r = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER, tools: L.workspaceTools(dir), budget: 5 });
  assert.deepEqual(r.answer, { title: 'Checked', items: [] });
  assert.equal(m.requests.length, 2);
  const pushed = m.requests[1].body.messages.filter((x) => x.role === 'tool').map((x) => x.content);
  assert.match(pushed[0], /doesn't fit: \$: missing/);
  assert.match(pushed[0], /not wrapped in another object/);
});

test('a model that keeps wrapping its submit call fails loudly instead of writing the wrapper', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-llm-submit2-'));
  closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const m = await mock(() => completion({ content: '', tool_calls: [toolCall('submit', { architecture: { project: { name: 'X' }, nodes: [] } })] }));
  const err = await completeJson(clientFor(m), { instructions: 'i', input: 'u', schema: ANSWER, tools: L.workspaceTools(dir), budget: 5 }).catch((e) => e);
  assert.equal(err.code, 'invalid_answer');
  assert.match(err.message, /missing "title"/);
});

test('an answer a model wrapped in one field is taken when the wrapped document is itself valid', async () => {
  const { unwrapAnswer } = L;
  const ok = { title: 'Hi', items: [] };
  assert.deepEqual(unwrapAnswer({ architecture: ok }, ANSWER), ok, '{"architecture": {...}}');
  assert.deepEqual(unwrapAnswer({ arguments: ok }, ANSWER), ok, '{"arguments": {...}}');
  assert.deepEqual(unwrapAnswer({ arguments: JSON.stringify(ok) }, ANSWER), ok, '{"arguments": "<json>"}');
  assert.deepEqual(unwrapAnswer(ok, ANSWER), ok, 'a plain answer is left as it is');
  // anything the schema would still reject stays rejected: no guessing, and only one key is forgiven
  assert.deepEqual(unwrapAnswer({ architecture: { nodes: [] } }, ANSWER), { architecture: { nodes: [] } });
  assert.deepEqual(unwrapAnswer({ a: ok, b: 1 }, ANSWER), { a: ok, b: 1 });
  // and the job's own rules still apply to the unwrapped document
  assert.deepEqual(unwrapAnswer({ architecture: ok }, ANSWER, () => ['"nodes" changed']), { architecture: ok });
});
