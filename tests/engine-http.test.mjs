// The map's `http` engine: asking, tracing a flow and changing a blueprint with any OpenAI-compatible model, no
// agent CLI anywhere. A mock endpoint (tests/mock-llm.mjs) stands in for the model, so these run offline and
// without a key; what they check is what the server sends, what it does with the answer, and what it keeps out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, makeProject, shopApp, run, readGraph, readJson, routeKeys, cleanup } from './helpers.mjs';
import { startMockLlm, completion, toolCall } from './mock-llm.mjs';

const servers = [], roots = [], mocks = [];
after(async () => {
  await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((resolve) => { s.once('exit', resolve); s.kill(); })));
  for (const m of mocks) await m.close();
  for (const r of roots) cleanup(r);
});
const pick = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);
const sse = (text) => text.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (\w+)/.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));
/** The answer event's JSON, without the session the server adds. */
const withoutSession = ({ session, ...rest }) => rest;

/** Starts the map's server on a project, with no CLI installed and the endpoint in floorplan/config.json. */
async function serveMap(root, mock, env = {}, { config = true } = {}) {
  if (config) fs.writeFileSync(path.join(root, 'floorplan', 'config.json'), JSON.stringify({ engine: 'http', baseUrl: mock.url, model: 'mock-model' }, null, 2));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(root, 'floorplan', 'serve.mjs'), '--port', String(port), '--no-open'], {
    cwd: root,
    env: { ...process.env, FLOORPLAN_ENGINE: '', FLOORPLAN_CLAUDE: path.join(root, 'no-such-claude'), FLOORPLAN_CODEX: path.join(root, 'no-such-codex'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server didn't start: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Floorplan: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
  });
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(base + '/')).text())[1]);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': page.token }, body: JSON.stringify(body || {}) });
  return {
    root, base, page, server,
    health: async () => (await fetch(base + '/api/health', { headers: { 'x-floorplan-token': page.token } })).json(),
    async ask(body) { return sse(await (await post('/api/ask', body)).text()); },
    undo: async () => (await post('/api/plan/undo')).json(),
  };
}

const ANSWER = { title: 'Refunds', answer: 'Refunds go through [[f:shop-api/routes/orders.js]].', items: [{ id: 'f:shop-api/routes/orders.js', note: 'Where a refund is written.' }], steps: [], followups: ['Who can ask for one?'] };
const FLOW = { title: 'Checkout', description: 'How a checkout becomes an order.', steps: [{ id: 'f:shop-api/routes/orders.js', note: 'The order is written.' }, { id: 'r:1', note: 'The website asks for it.' }] };

// ---------- asking ----------
let shop, shopMock;
test('a model endpoint answers, with the map tools, no CLI and no key', async () => {
  shopMock = await startMockLlm((body, n) => {
    const system = body.messages.find((m) => m.role === 'system')?.content || '';
    if (/You answer questions/.test(system)) {
      // first look something up on the map, then answer: the person sees progress while it works
      return n === 0 ? completion({ content: '', tool_calls: [toolCall('find_items', { query: 'refund' })] }) : completion({ content: '', tool_calls: [toolCall('submit', ANSWER)] });
    }
    if (/You build guided flows/.test(system)) return completion({ content: '', tool_calls: [toolCall('submit', FLOW)] });
    return completion({ content: '{"title":"unused"}' });
  });
  mocks.push(shopMock);
  shop = shopApp();
  roots.push(shop);
  run('scan.mjs', shop);
  run('build.mjs', shop, '--no-claude-md', '--agent', 'claude');
  shop = await serveMap(shop, shopMock);

  // the page is told what answers, and that it isn't a CLI
  assert.equal(shop.page.engine, 'http');
  assert.equal(shop.page.cli, false);
  assert.equal(shop.page.configured, true);
  assert.equal(shop.page.engineLabel, 'local mock-model', 'named for what it is, without the endpoint path');
  assert.equal(shop.page.model, 'mock-model');
  assert.equal(shop.page.tools, 'auto');
  assert.match(shop.page.baseUrlHost, /^127\.0\.0\.1:\d+$/);
  assert.equal(shop.page.change, true, 'a model endpoint gets the change schema, so Change is offered');
  assert.ok(!JSON.stringify(shop.page).includes('sk-'), 'no key reaches the page');

  const events = await shop.ask({ question: 'How do refunds work?' });
  assert.deepEqual(pick(events, 'failure'), []);
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Searching the map for "refund"']);
  const [answer] = pick(events, 'answer');
  assert.deepEqual(withoutSession(answer), ANSWER);
  assert.match(answer.session, /^[0-9a-f]{16}$/);

  // what the server sent: the graph tools and read-only source tools, and no response_format beside them —
  // some OpenAI-compatible servers (vLLM) honour the schema and drop the tool calls, and the model then
  // answers with a stub that fits the schema, so the tools must be the only way it is told the shape.
  const first = shopMock.requests.at(-1);
  assert.equal(first.body.response_format, undefined, 'no response_format beside tools');
  const names = first.body.tools.map((t) => t.function.name);
  for (const t of ['find_items', 'get_item', 'dependency_path', 'read_file', 'list_files', 'grep', 'submit']) assert.ok(names.includes(t), `${t} is offered (${names.join(', ')})`);
  assert.match(first.body.messages[0].content, /Use the tools find_items, get_item and dependency_path[\s\S]*read_file/);
  assert.equal(shopMock.requests.at(-1).headers.authorization, undefined, 'a local endpoint needs no key');

  // the lookup tool really searched the map this server is serving
  const toolMsg = first.body.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /orders|refund/i);
});

test('the page sends the http engine to the map server, not down the Claude app path', async () => {
  // Pressing Enter is the page's own code path, which a POST to /api/ask doesn't exercise. It used to ask the
  // Claude app for anything that wasn't the `cli` engine, so an http map answered every question with
  // "Cannot read properties of null (reading 'json')" (askState.sample is null). One list now decides.
  const html = await (await fetch(shop.base + '/')).text();
  assert.match(html, /const SERVER_ENGINES = \['cli', 'http'\]/, 'the engines the server answers are listed in one place');
  assert.match(html, /onServer\(\) \? await askViaCli\(question, progress\)/, 'Ask goes through the server for the http engine');
  assert.match(html, /onServer\(\) \? await askViaCli\(prompt, progress, 'flow'\)/, 'and so does a requested flow');
  assert.doesNotMatch(html, /askState\.engine === 'cli' \?/, 'nothing decides "server or app" from the cli engine alone');
});

test('a follow-up carries the conversation, and a flow is traced the same way', async () => {
  const [first] = pick(await shop.ask({ question: 'How do refunds work?' }), 'answer');
  await shop.ask({ question: 'Who can ask for one?', session: first.session });
  assert.match(shopMock.requests.at(-1).body.messages.at(-1).content, /Earlier in this conversation:\nQ: How do refunds work\?/);
  // and a new session starts clean
  await shop.ask({ question: 'Start over' });
  assert.doesNotMatch(shopMock.requests.at(-1).body.messages.at(-1).content, /Earlier in this conversation/);

  const flow = await shop.ask({ question: 'Show me checkout', mode: 'flow' });
  assert.deepEqual(pick(flow, 'failure'), []);
  assert.deepEqual(pick(flow, 'answer')[0].title, 'Checkout');
});

test('the health check names the endpoint and its model, and never its key', async () => {
  const h = await shop.health();
  assert.equal(h.engine, 'http');
  assert.equal(h.engineLabel, 'local mock-model');
  assert.equal(h.model, 'mock-model');
  assert.match(h.baseUrlHost, /^127\.0\.0\.1:\d+$/);
  assert.equal(h.configured, true);
  assert.equal(h.cli, false);
  assert.doesNotMatch(JSON.stringify(h), /"apiKey"|sk-/);
});

test('changing a blueprint works through the model, with the plan checked before it is saved', async () => {
  const mock = await startMockLlm(async () => {
    // the same change tests/fixtures/blueprint makes: refunds added to the plan and the map
    const plan = readJson(path.join(REPO, 'tests', 'fixtures', 'blueprint', 'floorplan', 'plan.json'));
    plan.files.push({ path: 'api/src/routes/refunds.ts', name: 'Refund endpoints', description: 'Refunds a cancelled walk to the owner’s card.', uses: ['api/src/services/payments.ts', 'api/src/db/bookings.ts'] });
    plan.files.find((f) => f.path === 'web/app/bookings/page.tsx').calls.push('POST /api/refunds');
    plan.endpoints.push({ method: 'POST', path: '/api/refunds', file: 'api/src/routes/refunds.ts', name: 'Refund a walk', description: 'Sends the money back for a cancelled walk.', access: 'signed-in', who: 'the owner who booked it' });
    return completion({ content: '', tool_calls: [toolCall('submit', {
      title: 'Planned out refunds',
      summary: 'Added a refund endpoint the My walks page calls.',
      plan: JSON.stringify(plan),
      architecture: fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'blueprint', 'floorplan', 'architecture.json'), 'utf8'),
      changes: [{ ref: 'api/src/routes/refunds.ts', change: 'new', note: 'Where refunds are handled.' }, { ref: 'POST /api/refunds', change: 'new', note: 'The request that refunds a walk.' }],
      followups: ['Email the owner'],
    })] });
  });
  mocks.push(mock);
  const root = makeProject({});
  roots.push(root);
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'blueprint'), root, { recursive: true });
  run('plan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'claude');
  const s = await serveMap(root, mock, { FLOORPLAN_TOOL_CALLS: '4' });
  assert.equal(s.page.change, true);
  const events = await s.ask({ question: 'also plan out refunds', mode: 'change' });
  assert.deepEqual(pick(events, 'failure'), []);
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Checking the updated plan']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.title, 'Planned out refunds');
  assert.equal(answer.changes, 2);
  assert.match(answer.undo, /^[0-9a-z]+$/);
  assert.ok(routeKeys(readGraph(root)).includes('POST /api/refunds'), 'the map was redrawn with the change');
  assert.equal(readJson(path.join(root, 'floorplan', 'plan.json')).endpoints.at(-1).who, 'the owner who booked it');
  assert.deepEqual(await s.undo(), { ok: true, left: 0 });
});

// ---------- tools off, and failures ----------
test('tools off: the map answers from the graph alone, and says so in the prompt', async () => {
  const mock = await startMockLlm(() => completion({ content: '', tool_calls: [toolCall('submit', ANSWER)] }));
  mocks.push(mock);
  const root = shopApp();
  roots.push(root);
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'claude');
  const s = await serveMap(root, mock, { FLOORPLAN_TOOLS: 'off' });
  assert.equal(s.page.tools, 'off');
  await s.ask({ question: 'How do refunds work?' });
  const req = mock.requests.at(-1);
  assert.deepEqual(req.body.tools.map((t) => t.function.name).sort(), ['dependency_path', 'find_items', 'get_item', 'submit']);
  assert.match(req.body.messages[0].content, /cannot read source files/);
  // with no tools to look anything up, the map itself travels in the prompt: the parts, the flows, and the
  // cards nearest the question
  const user = req.body.messages.find((m) => m.role === 'user').content;
  assert.match(user, /## The map \(its parts, flows and the cards nearest this question\)/);
  assert.match(user, /"systems"/);
  assert.match(user, /"matches"/);
  // a card that only names the source is still allowed to answer: the read-only tools are simply not offered
  const h = await s.health();
  assert.equal(h.tools, 'off');
});

test('a model endpoint that refuses the key fails with the code the Ask bar explains', async () => {
  const mock = await startMockLlm(() => ({ status: 401, body: { error: { message: 'Incorrect API key provided' } } }));
  mocks.push(mock);
  const root = shopApp();
  roots.push(root);
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'claude');
  const s = await serveMap(root, mock);
  const [failure] = pick(await s.ask({ question: 'Anything?' }), 'failure');
  assert.equal(failure.code, 'not_logged_in');
  assert.match(failure.message, /Incorrect API key/);
});

test('an endpoint that is down says how to fix it, and the map itself still works', async () => {
  const mock = await startMockLlm(() => ({ hang: true }));
  mocks.push(mock);
  const root = shopApp();
  roots.push(root);
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'claude');
  const s = await serveMap(root, mock, { FLOORPLAN_TIMEOUT_MS: '150' });
  const [failure] = pick(await s.ask({ question: 'Anything?' }), 'failure');
  assert.equal(failure.code, 'timeout');
  assert.match(failure.message, /did not answer/);
  assert.equal((await fetch(s.base + '/')).status, 200, 'the page is still served');
});

test('a config.json with a key in it is refused, and the key is never used', async () => {
  const root = shopApp();
  roots.push(root);
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'claude');
  fs.writeFileSync(path.join(root, 'floorplan', 'config.json'), JSON.stringify({ engine: 'http', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-should-never-be-here' }));
  const mock = await startMockLlm(() => completion({ content: '{}' }));
  mocks.push(mock);
  const s = await serveMap(root, mock, {}, { config: false });
  // the file's problem is reported, and the map still opens: it just has no usable endpoint
  assert.equal(s.page.configured, false);
  const [failure] = pick(await s.ask({ question: 'Anything?' }), 'failure');
  assert.equal(failure.code, 'cli_missing');
  assert.match(failure.message, /config\.json/);
});