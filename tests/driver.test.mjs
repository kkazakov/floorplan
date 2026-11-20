// The shipped driver (skills/floorplan/driver.mjs), end to end, against a mock OpenAI-compatible endpoint:
// no agent CLI, no key, no network. This is the "fresh machine with Node and one API key" promise in PLAN.md:
// scan → describe → build, with a model answering the jobs of workflow.json and the driver writing the files.
// tests/unattended.test.mjs keeps checking the workflow file with a canned in-process driver (the fast spec
// check); this file checks the real thing a person would run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { SKILL, shopApp, run, readJson, readGraph, cleanup } from './helpers.mjs';
import { startMockLlm, completion } from './mock-llm.mjs';

const DRIVER = path.join(SKILL, 'driver.mjs');
const GUIDE = 'See docs/unattended.md.';

/**
 * Runs the driver on a project; `env` is added to this process's. Always --json, so the object is checked.
 * Asynchronous on purpose: the mock endpoint lives in this process, so a blocking execFileSync would deadlock.
 */
function drive(root, env = {}, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIVER, root, '--json', ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }));
    child.on('close', (code) => { let json; try { json = JSON.parse(out); } catch {} resolve({ code, json, out, err }); });
  });
}
const commitAll = (dir, msg) => {
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...a], { stdio: 'ignore' });
  g('add', '-A'); g('commit', '-qm', msg);
};

// ---------- the model, as a mock endpoint ----------
// Every request is one job: the driver sends workflow.json's instructions as the system message, so the mock
// tells them apart the way a person reading the log would, from the first line of those instructions.
const ARCH = {
  project: { name: 'Shop', summary: 'A small shop: a website where customers see their orders, and the server behind it.' },
  nodes: [
    { id: 'api', label: 'Main server', kind: 'service', summary: 'Keeps orders and answers the website.', paths: ['shop-api/**'] },
    { id: 'web', label: 'Website', kind: 'ui', summary: 'The pages customers use.', paths: ['shop-web/**'] },
  ],
  flows: [{ id: 'remove-customer', title: 'Staff remove a customer', steps: [{ node: 'web', note: 'Staff ask to remove someone.' }, { node: 'shop-api/routes/admin.js', note: 'The server removes them.' }] }],
  tour: [
    { node: 'web', title: 'The website', note: 'Where customers see their orders.' },
    { node: 'api', title: 'The main server', note: 'Everything the website asks for is answered here.' },
  ],
};
const section = (user, name) => {
  const i = user.indexOf(`## ${name}\n`);
  if (i < 0) return undefined;
  const start = i + name.length + 4;
  const next = user.indexOf('\n\n## ', start);
  return user.slice(start, next < 0 ? undefined : next);
};
const jobs = []; // { job, system, user } for what the mock was asked
/** The mock's answers: one per job, from the same canned data the workflow tests use. */
function answer(body, n) {
  const system = body.messages.find((m) => m.role === 'system')?.content || '';
  const user = [...body.messages].reverse().find((m) => m.role === 'user')?.content || '';
  const job = /You are drawing a map of a codebase/.test(system) ? 'architecture'
    : /A map of a codebase is written for everyone/.test(system) ? 'plain_language'
    : /You keep a map of a codebase up to date/.test(system) ? 'update_architecture'
    : /You name and describe the files/.test(system) ? 'descriptions'
      : /You mark recent work/.test(system) ? 'recent_work' : 'unknown';
  jobs.push({ job, system, user, n });
  if (job === 'architecture') {
    // the first try leaves the website out, so the build reports it unassigned and the driver asks again
    const first = section(user, 'What the last build said about it') === undefined;
    return { content: JSON.stringify(first ? { ...ARCH, nodes: ARCH.nodes.slice(0, 1), flows: [], tour: [] } : ARCH) };
  }
  if (job === 'descriptions') {
    const d = JSON.parse(section(user, 'The file to fill in, as it stands'));
    const fill = (k, v) => ({ name: v.name || path.posix.basename(k), description: `Looks after ${k} for the shop.` });
    return { content: JSON.stringify({ files: Object.fromEntries(Object.entries(d.files).map(([k, v]) => [k, fill(k, v)])), ...(d.routes ? { routes: Object.fromEntries(Object.entries(d.routes).map(([k, v]) => [k, fill(k, v)])) } : {}) }) };
  }
  if (job === 'recent_work') return { content: JSON.stringify({ tasks: [{ title: 'Order screens', request: '', summary: 'The orders list is in place.', items: [{ ref: 'shop-api/routes/orders.js', change: 'new', note: 'Lists a customer’s orders.' }] }] }) };
  if (job === 'update_architecture') {
    // the NEXT item is given as the sentence a person would read, so the mock reads it the same way
    const task = section(user, "What to do (from the refresh's NEXT list)") || '';
    const arch = JSON.parse(section(user, 'The current architecture.json'));
    if (/^New files landed/.test(task) && !arch.nodes.some((x) => x.id === 'scripts')) arch.nodes.push({ id: 'scripts', label: 'Scripts', kind: 'script', summary: 'Jobs run by hand.', paths: ['scripts/**'] });
    if (/^Fix the build errors/.test(task)) arch.flows = [];
    return { content: JSON.stringify(arch) };
  }
  return { content: '{}' };
}

let root, mock;
before(async () => {
  mock = await startMockLlm(answer);
  root = shopApp();
  fs.rmSync(path.join(root, 'floorplan'), { recursive: true });
  commitAll(path.join(root, 'shop-api'), 'Add the shop server');
});
after(async () => { await mock.close(); cleanup(root); });

// nothing outside the map folder is written, git's own files included
function outside(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).replace(/\\/g, '/');
      if (rel === 'floorplan') continue;
      if (e.isDirectory()) { out[rel + '/'] = 'dir'; walk(p); } else out[rel] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

test('a first map with no agent at all: scan, describe and build, driven by an HTTP model', async () => {
  const before = outside(root);
  const r = await drive(root, { FLOORPLAN_BASE_URL: mock.url, FLOORPLAN_MODEL: 'mock-model' });
  assert.equal(r.code, 0, `${r.err || ''}\n${r.out.slice(-2000)}`);
  assert.equal(r.json.schema, 'floorplan/driver@1');
  assert.equal(r.json.ok, true);
  assert.equal(r.json.workflow, 'first_map');
  assert.equal(r.json.map.buildOk, true, JSON.stringify(r.json.map));
  assert.equal(r.json.map.descriptions, true, 'every file and endpoint is described');
  assert.deepEqual(r.json.notes, []);
  assert.equal(r.json.model, 'mock-model');
  // the workflow ran the jobs the file names, and the architecture job was asked twice
  const ran = jobs.map((j) => j.job);
  assert.ok(ran.includes('architecture') && ran.includes('descriptions') && ran.includes('recent_work'), ran.join(', '));
  assert.equal(ran.filter((j) => j === 'architecture').length, 2, 'the unassigned website sent the model back once');
  assert.match(jobs.find((j) => j.job === 'architecture' && j.n > 0).user, /unassigned, by directory[\s\S]*shop-web/);
  // the map is complete, and names no agent
  const g = readGraph(root);
  assert.equal(g.meta.agent, 'none');
  assert.ok(g.files.every((f) => !f.auto), 'no file is left with an automatic description');
  assert.match(readJson(path.join(root, 'floorplan', 'recent-work.json')).updatedAt, /^\d{4}-\d\d-\d\dT/);
  // and the one thing that must never happen in unattended mode
  assert.deepEqual(outside(root), before, 'nothing outside floorplan/ changed');
});

test('the same map again: refresh asks only for what changed, and the driver follows NEXT', async () => {
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/seed.js'), 'export function seed() { return 1; }\n');
  const notes = path.join(root, 'shop-api/routes/notes.js');
  fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace('export default', `router.get('/notes', async (req, res) => { res.json([]); });\nexport default`));
  commitAll(path.join(root, 'shop-api'), 'Add a seed script and a notes endpoint');
  jobs.length = 0;
  const r = await drive(root, { FLOORPLAN_BASE_URL: mock.url });
  assert.equal(r.code, 0, `${r.err || ''}\n${r.out.slice(-2000)}`);
  assert.equal(r.json.workflow, 'refresh');
  assert.equal(r.json.map.buildOk, true);
  assert.equal(r.json.map.descriptions, true);
  assert.equal(r.json.map.unassigned, 0);
  const ran = jobs.map((j) => j.job);
  assert.ok(ran.includes('update_architecture'), ran.join(', '));
  assert.ok(ran.includes('descriptions'), ran.join(', '));
  assert.ok(!ran.includes('architecture'), 'a refresh does not start from scratch');
  assert.ok(readGraph(root).routes.some((x) => x.p === '/api/notes' && x.m === 'GET' && !x.auto));
});

test('settings come from floorplan/config.json too, and a key never has to be in it', async () => {
  fs.writeFileSync(path.join(root, 'floorplan', 'config.json'), JSON.stringify({ engine: 'http', baseUrl: mock.url, model: 'from-config', apiKeyEnv: 'MOCK_KEY' }, null, 2));
  jobs.length = 0;
  const r = await drive(root, { MOCK_KEY: 'sk-test-not-logged-anywhere' });
  assert.equal(r.code, 0, r.err || r.out);
  assert.equal(r.json.model, 'from-config');
  assert.ok(jobs.length >= 1, 'the model answered');
  // the key travelled in the header only, and never to a file
  assert.equal(mock.requests.at(-1).headers.authorization, 'Bearer sk-test-not-logged-anywhere');
  assert.ok(!fs.readFileSync(path.join(root, 'floorplan', 'config.json'), 'utf8').includes('sk-test'));
  for (const f of fs.readdirSync(path.join(root, 'floorplan'))) assert.ok(!f.endsWith('.log'), 'no log to leak into');
});

test('no engine configured: the driver says what to set and exits 1', async () => {
  const p = shopApp();
  try {
    fs.rmSync(path.join(p, 'floorplan'), { recursive: true });
    const r = await drive(p, { FLOORPLAN_BASE_URL: '', FLOORPLAN_MODEL: '' });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error.code, 'not_configured');
    assert.match(r.json.error.message, /FLOORPLAN_BASE_URL/);
    assert.match(r.json.error.message, /config\.json/);
    assert.ok(!fs.existsSync(path.join(p, 'floorplan')), 'nothing was written');
  } finally { cleanup(p); }
});

test('a model that cannot answer well fails the run with the job and the reason, not a half map', async () => {
  const p = shopApp();
  const bad = await startMockLlm(() => ({ content: '{"project":{"name":"X"},"nodes":"not a list"}' }));
  try {
    fs.rmSync(path.join(p, 'floorplan'), { recursive: true });
    const r = await drive(p, { FLOORPLAN_BASE_URL: bad.url });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error.message, /didn't fit/i);
    assert.equal(r.json.error.code, 'invalid_answer');
    assert.ok(r.json.log.length >= 1, 'the steps that ran are in the report');
    assert.ok(!fs.existsSync(path.join(p, 'floorplan', 'graph.json')), 'no map was written from a bad answer');
    assert.equal(bad.requests.length, 1 + 2, 'the first answer and the two retries, then it gave up');
  } finally { await bad.close(); cleanup(p); }
});

test('--json is the only thing on stdout, and a failure object has the same shape as a success', async () => {
  const r = await drive(root, { FLOORPLAN_BASE_URL: 'http://127.0.0.1:1/v1' });
  assert.equal(r.code, 1);
  assert.ok(r.json, `stdout must be one JSON object: ${r.out.slice(0, 300)}`);
  assert.deepEqual(Object.keys(r.json).sort(), ['error', 'log', 'ok', 'schema']);
  assert.equal(r.json.error.code, 'unreachable');
  assert.match(r.json.error.message, /Could not reach 127\.0\.0\.1:1/);
});