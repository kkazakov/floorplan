#!/usr/bin/env node
// driver.mjs: make or update a Floorplan map with no agent session at all, following workflow.json (the same
// steps SKILL.md describes in prose) against any OpenAI-compatible model endpoint. It writes only the map
// folder, exits non-zero with a named reason when a job can't be completed, and needs Node 18+ and nothing else.
//
// usage: node driver.mjs [root] [--json] [--open]
//                        [--base-url URL] [--model NAME] [--api-key-env VAR] [--tools auto|on|off]
//                        [--max-retries N]
//
// Settings come from the flags, then FLOORPLAN_BASE_URL / FLOORPLAN_MODEL / FLOORPLAN_API_KEY(_ENV) /
// FLOORPLAN_TOOLS, then <root>/floorplan/config.json (assets/config.mjs). No key is ever written or logged.
// `--json` prints one object and nothing else; the human report goes to stdout otherwise, and progress to stderr.
// docs/unattended.md is the worked example.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, mapDir } from './scripts/lib/common.mjs';
import { maskSecrets } from './scripts/lib/health.mjs';
import { createClient, completeJson, workspaceTools, renderInputs, unknownKeywords, LlmError } from './assets/llm.mjs';
import { resolveConfig, engineName } from './assets/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = JSON.parse(fs.readFileSync(path.join(HERE, 'workflow.json'), 'utf8').replace(/^\uFEFF/, ''));
const ANSWER_RETRIES = Number(WORKFLOW.conventions?.answerRetries ?? 2);
const GUIDE = 'See docs/unattended.md.';

/** A step that failed with what a person needs to fix it. */
class DriverError extends Error {
  constructor(message, { step = '', code = 'step_failed', detail = '' } = {}) { super(message); this.name = 'DriverError'; this.step = step; this.code = code; this.detail = detail; }
}

// `--open` is a switch, but parseArgs (correctly, for `--days 3`) would eat the next argument: make it explicit.
const argv = process.argv.slice(2).map((a) => (a === '--open' ? `${a}=1` : a));
const args = parseArgs(argv);
const root = path.resolve(args._[0] || '.');
const asJson = !!args.json;
const say = (s) => process.stderr.write(`${s}\n`);

// ---------- settings ----------
const map = mapDir(root);
const config = resolveConfig(map, process.env);
for (const [flag, key] of [['base-url', 'baseUrl'], ['model', 'model'], ['api-key-env', 'apiKeyEnv'], ['tools', 'tools']]) {
  if (typeof args[flag] === 'string') config[key] = args[flag];
}
if (typeof args.engine === 'string' && args.engine !== 'http') {
  fail(`This driver only speaks to an OpenAI-compatible endpoint ("http"). Run the map's server for ${args.engine}.`, 'not_configured');
}
if (config.problems.length) fail(config.problems.join('\n'), 'bad_config');
if (!config.baseUrl) {
  fail(['No model endpoint is configured.', 'Set one of:', '  FLOORPLAN_BASE_URL=http://127.0.0.1:11434/v1 FLOORPLAN_MODEL=qwen3-coder node driver.mjs <root>', `  { "engine": "http", "baseUrl": "…", "model": "…" } in ${path.join(map, 'config.json')}`, GUIDE].join('\n'), 'not_configured');
}
const client = createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, timeoutMs: Number(process.env.FLOORPLAN_TIMEOUT_MS) || 180000 });
const ENGINE = engineName(config);

function fail(message, code, extra = {}) {
  if (asJson) process.stdout.write(JSON.stringify({ schema: 'floorplan/driver@1', ok: false, error: { code, message }, ...extra }, null, 2) + '\n');
  else process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

// ---------- following workflow.json ----------
const results = {}; // a step's saved JSON, under the name it asked for
const notes = []; // optional steps that failed: { step, reason }
const log = []; // every step, in order, for the report and --json

const get = (p, scope = {}) => String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), { ...results, ...scope });
const holds = (conds, scope) => (conds || []).every((c) => {
  const v = get(c.path, scope);
  if (v === undefined) return false;
  switch (c.op) {
    case 'equals': return v === c.value;
    case 'notEquals': return v !== c.value;
    case 'lessThan': return v < c.value;
    case 'atMost': return v <= c.value;
    case 'greaterThan': return v > c.value;
    case 'in': return c.value.includes(v);
    default: throw new DriverError(`workflow.json uses an unknown condition op "${c.op}"`, { code: 'bad_workflow' });
  }
});
const fill = (s, scope) => String(s).replace(/\{([\w.]+)\}/g, (m, p) => {
  if (p === 'now') return new Date().toISOString();
  const v = get(p, scope);
  return v === undefined ? m : typeof v === 'string' ? v : JSON.stringify(v);
});
const fillDeep = (v, scope) => JSON.parse(JSON.stringify(v ?? null), (k, x) => (typeof x === 'string' ? fill(x, scope) : x));
const stepsOf = (name) => {
  const steps = WORKFLOW.procedures?.[name] || WORKFLOW.workflows?.[name]?.steps;
  if (!steps) throw new DriverError(`workflow.json names "${name}", which is neither a procedure nor a workflow`, { code: 'bad_workflow' });
  return steps;
};
const readJsonIf = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return undefined; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); };
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

/** Runs one of the skill's scripts with --json, and returns { code, json, out, err }. */
function execScript(step) {
  const script = path.join(HERE, 'scripts', step.run);
  if (!fs.existsSync(script)) throw new DriverError(`workflow.json runs scripts/${step.run}, which doesn't exist`, { step: step.id, code: 'bad_workflow' });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, root, ...(step.args || [])], { cwd: root, env: { ...process.env, ...(WORKFLOW.conventions?.environment || {}) }, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message), json: undefined }));
    child.on('close', (code) => resolve({ code, out, err, json: (() => { try { return JSON.parse(out); } catch { return undefined; } })() }));
  });
}

async function runScript(step) {
  const r = await execScript(step);
  if (!r.json || typeof r.json !== 'object') throw new DriverError(`${step.id}: ${step.run} printed no JSON object. ${GUIDE}\n${(r.out || r.err).slice(0, 400)}`, { step: step.id, code: 'bad_script_output' });
  if (r.code !== 0 && !step.allowFailure) {
    const why = (r.json.errors || []).slice(0, 3).join('; ') || r.err.trim().split('\n').pop() || `exit ${r.code}`;
    throw new DriverError(`${step.id}: ${step.run} failed: ${why}`, { step: step.id, code: 'script_failed', detail: r.err });
  }
  if (step.save) results[step.save] = r.json;
  for (const [name, field] of Object.entries(step.saveFields || {})) results[name] = r.json[field];
  return r;
}

/** What an answer changed outside the fields onlyChange allows ("nodes[].label"): a list of problems. */
function onlyChangeCheck(was, fields) {
  const blank = (doc) => {
    const copy = JSON.parse(JSON.stringify(doc));
    for (const f of fields) {
      const m = /^(\w+)\[\]\.(\w+)$/.exec(f);
      if (!m) throw new DriverError(`onlyChange field "${f}" isn't of the form list[].field`, { code: 'bad_workflow' });
      if (Array.isArray(copy[m[1]])) for (const item of copy[m[1]]) if (item && typeof item === 'object') delete item[m[2]];
    }
    return copy;
  };
  const a = blank(was);
  return (answer) => {
    const b = blank(answer);
    const problems = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) problems.push(`"${k}" changed, but only ${fields.join(', ')} may change`);
    }
    return problems;
  };
}

async function runJob(name, scope = {}) {
  const job = WORKFLOW.jobs?.[name];
  if (!job) throw new DriverError(`workflow.json has no job "${name}"`, { code: 'bad_workflow' });
  const schema = WORKFLOW.schemas?.[job.schema];
  if (!schema) throw new DriverError(`job ${name}: its answer schema "${job.schema}" is missing`, { code: 'bad_workflow' });
  const unknown = unknownKeywords(schema);
  if (unknown.length) throw new DriverError(`job ${name}: its answer schema uses keywords no driver knows: ${unknown.join(', ')}`, { code: 'bad_workflow' });
  // the references it must follow, and the files and facts it needs
  const docs = (job.read || []).map((ref) => {
    const file = path.join(HERE, ref);
    if (!fs.existsSync(file)) throw new DriverError(`job ${name} reads ${ref}, which doesn't exist`, { code: 'bad_workflow' });
    return `# ${ref}\n${fs.readFileSync(file, 'utf8')}`;
  });
  const inputs = {};
  for (const inp of job.input || []) {
    let v;
    if (inp.from) v = get(inp.from, scope);
    else { const f = path.resolve(root, fill(inp.file, scope)); v = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined; }
    if (v === undefined) {
      if (inp.optional) continue;
      throw new DriverError(`job ${name}: its input "${inp.name}" (${inp.from || inp.file}) is missing`, { step: name, code: 'missing_input' });
    }
    inputs[inp.name] = v;
  }
  if (docs.length) inputs['Reference documents'] = docs.join('\n\n');
  const was = job.onlyChange ? readJsonIf(path.resolve(root, fill(job.onlyChange.file, scope))) : undefined;
  if (job.onlyChange && !was) throw new DriverError(`job ${name}: ${job.onlyChange.file} is missing, so there is nothing to change`, { code: 'missing_input' });
  const budget = Number.isFinite(job.toolCalls) ? job.toolCalls : 0;
  const r = await completeJson(client, {
    instructions: job.instructions.join('\n\n'),
    input: renderInputs(inputs),
    schema,
    tools: workspaceTools(root, { mask: maskSecrets }),
    budget,
    mask: maskSecrets,
    retries: Number.isFinite(Number(args['max-retries'])) ? Number(args['max-retries']) : ANSWER_RETRIES,
    check: was ? onlyChangeCheck(was, job.onlyChange.fields) : undefined,
    onProgress: (text) => say(`  ${name}: ${text}`),
    signal: stopping.signal,
  });
  const answer = { ...r.answer };
  Object.assign(answer, fillDeep(job.set || {}, scope));
  const out = path.resolve(root, fill(job.writes, scope));
  writeJson(out, answer);
  return { file: rel(out), turns: r.turns };
}

async function runStep(step, scope = {}) {
  const started = Date.now();
  if (step.when && !holds(step.when, scope)) { log.push({ id: step.id, status: 'skipped', ms: 0 }); say(`· ${step.id}: skipped`); return; }
  if (!step.optional) return runRequired(step, scope, started);
  // optional: keep the restore files, and on failure put them back, run onFail, note it and carry on
  const kept = (step.restore || []).map((p) => { const f = path.resolve(root, fill(p, scope)); return [f, fs.existsSync(f) ? fs.readFileSync(f) : null]; });
  try { await runRequired(step, scope, started); } catch (e) {
    if (e instanceof LlmError && e.code === 'aborted') throw e;
    for (const [f, data] of kept) { if (data == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, data); }
    notes.push({ step: step.id, reason: e.message });
    log.push({ id: step.id, status: 'optional-failed', ms: Date.now() - started, reason: e.message });
    say(`! ${step.id}: ${e.message} (the files it changed are back as they were)`);
    for (const s of step.onFail || []) await runStep(s, scope);
  }
}

async function runRequired(step, scope = {}, started = Date.now()) {
  if (step.run) {
    await runScript(step);
    log.push({ id: step.id, kind: 'script', status: 'ok', ms: Date.now() - started });
    say(`✓ ${step.run}`);
    return;
  }
  if (step.job) {
    if (!step.forEach) {
      const r = await runJob(step.job, scope);
      log.push({ id: step.id, kind: 'job', job: step.job, status: 'ok', ms: Date.now() - started, file: r.file, turns: r.turns });
      say(`✓ ${step.job} → ${r.file}`);
      return;
    }
    const items = get(step.forEach, scope);
    if (!Array.isArray(items)) throw new DriverError(`${step.id}: forEach ${step.forEach} is not a list`, { step: step.id, code: 'bad_workflow' });
    const one = async (it) => {
      const r = await runJob(step.job, { ...scope, [step.as || 'item']: it });
      log.push({ id: step.id, kind: 'job', job: step.job, status: 'ok', ms: Date.now() - started, file: r.file, turns: r.turns, item: it?.key || it?.code || '' });
      say(`✓ ${step.job}${it?.key ? ` (${it.key})` : it?.code ? ` (${it.code})` : ''} → ${r.file}`);
    };
    if (!step.parallel) { for (const it of items) await one(it); return; }
    // parallel: true: a few at a time, so a local model isn't asked for more than it can answer at once
    const width = Math.max(1, Number(process.env.FLOORPLAN_CONCURRENCY) || 3);
    for (let i = 0; i < items.length; i += width) await Promise.all(items.slice(i, i + width).map(one));
    return;
  }
  if (step.write) {
    const file = path.resolve(root, fill(step.write, scope));
    writeJson(file, fillDeep(step.value, scope));
    log.push({ id: step.id, kind: 'write', status: 'ok', ms: Date.now() - started, file: rel(file) });
    say(`✓ wrote ${rel(file)}`);
    return;
  }
  if (step.repeat) {
    for (let i = 0; ; i++) {
      if (i >= (step.minAttempts || 0) && holds(step.until, scope)) { log.push({ id: step.id, kind: 'repeat', status: 'ok', ms: Date.now() - started, attempts: i }); return; }
      if (i >= step.maxAttempts) throw new DriverError(`${step.id}: ${step.failMessage}`, { step: step.id, code: 'repeat_failed' });
      for (const s of step.repeat) await runStep(s, scope);
    }
  }
  if (step.use) { for (const s of stepsOf(step.use)) await runStep(s, scope); return; }
  if (step.next) {
    for (const item of get(step.next, scope) || []) {
      const h = step.handlers?.[item.code];
      if (!h) throw new DriverError(`no handler in workflow.json for NEXT code "${item.code}"`, { step: step.id, code: 'bad_workflow' });
      if (h.fail) throw new DriverError(h.fail, { step: step.id, code: `next_${item.code}` });
      if (h.skip) continue;
      for (const s of stepsOf(h)) await runStep(s, { ...scope, item });
    }
    log.push({ id: step.id, kind: 'next', status: 'ok', ms: Date.now() - started });
    return;
  }
  throw new DriverError(`workflow.json has a step of an unknown kind: ${JSON.stringify(step).slice(0, 200)}`, { step: step.id, code: 'bad_workflow' });
}

// Ctrl-C stops the model call rather than leaving it running
const stopping = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping.abort(); process.exit(130); });

/** Follows workflow.json from its start step to the end. Returns { workflow, results, log, notes }. */
async function drive() {
  await runScript({ id: 'start', ...WORKFLOW.start });
  const pick = (WORKFLOW.start.choose || []).find((c) => holds(c.when, {}));
  if (!pick) throw new DriverError(`no workflow for status state "${results.status?.state}"`, { code: 'bad_status' });
  if (pick.fail) throw new DriverError(pick.fail, { code: 'needs_a_person' });
  const wf = WORKFLOW.workflows[pick.workflow];
  if (!wf) throw new DriverError(`workflow.json has no workflow "${pick.workflow}"`, { code: 'bad_workflow' });
  say(`Floorplan driver: ${pick.workflow} in ${root} via ${ENGINE}${config.model ? ` (${config.model})` : ''}`);
  for (const s of wf.steps) await runStep(s, {});
  const done = holds(wf.done, {});
  if (!done) {
    const why = (results.build?.errors || []).slice(0, 4).join('; ') || 'its done conditions do not hold';
    throw new DriverError(`workflow ${pick.workflow} finished but ${why}`, { code: 'incomplete' });
  }
  return { workflow: pick.workflow, results, log, notes };
}

// ---------- the report ----------
try {
  const run = await drive();
  const build = run.results.build || {};
  const desc = build.descriptions || {};
  const summary = {
    workflow: run.workflow,
    engine: ENGINE,
    model: config.model || null,
    ok: true,
    steps: run.log.length,
    jobs: run.log.filter((s) => s.kind === 'job').length,
    notes: run.notes,
    map: { buildOk: build.ok ?? null, unassigned: build.files?.unassigned ?? null, descriptions: desc.complete === true, files: desc.files || null, routes: desc.routes || null },
    html: rel(path.join(map, 'index.html')),
  };
  if (asJson) {
    process.stdout.write(JSON.stringify({ schema: 'floorplan/driver@1', ...summary, log: run.log }, null, 2) + '\n');
  } else {
    const lines = [
      `✓ ${run.workflow}: the map is in ${rel(map)}/index.html`,
      `  ${summary.jobs} model job(s), ${run.log.length} step(s), via ${ENGINE}${config.model ? ` (${config.model})` : ''}`,
      build.ok === true ? '  the build is clean' : '',
      desc.complete ? `  every file and endpoint is described (${desc.files?.described ?? '?'}/${desc.files?.total ?? '?'} files)` : '',
      ...run.notes.map((n) => `  ! ${n.step}: ${n.reason}`),
      '  open it: node ' + path.join(rel(map), 'serve.mjs'),
    ];
    process.stdout.write(lines.filter(Boolean).join('\n') + '\n');
  }
  if (args.open === '1' || args.open === true) {
    // open.mjs refuses in unattended mode, and this driver is always unattended: ask it with that switch off
    const env = { ...process.env };
    delete env.FLOORPLAN_UNATTENDED;
    spawn(process.execPath, [path.join(HERE, 'scripts', 'open.mjs'), root], { cwd: root, env, stdio: 'inherit', windowsHide: true });
  }
} catch (e) {
  const err = e instanceof DriverError || e instanceof LlmError
    ? { code: e.code || 'step_failed', message: e.message, step: e.step || undefined }
    : { code: 'unexpected', message: `the driver stopped unexpectedly: ${e.message}` };
  if (!(e instanceof DriverError) && !(e instanceof LlmError)) say(e.stack || '');
  if (asJson) process.stdout.write(JSON.stringify({ schema: 'floorplan/driver@1', ok: false, error: err, log }, null, 2) + '\n');
  else process.stderr.write(`✗ ${err.step ? `${err.step}: ` : ''}${err.message}\n${GUIDE}\n`);
  process.exit(1);
}