// config.mjs: the map's engine settings, in one place for serve.mjs (the Ask bar), driver.mjs (headless) and
// open.mjs. A person sets them in floorplan/config.json, and every one has an environment variable that wins,
// so CI or a shell can point the same map at another model without editing a file.
//
//   { "engine": "http", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3-coder",
//     "apiKeyEnv": "OPENAI_API_KEY", "tools": "auto" }
//
// The key itself is never stored here: `apiKeyEnv` names the variable to read it from. Nothing in this module
// ever logs a key, and only `apiKey` (resolved, in memory) carries one.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'config.json';
export const ENGINES = ['http', 'claude', 'codex'];
export const TOOLS = ['auto', 'on', 'off'];

/** Where a map folder keeps its settings. */
export const configPath = (mapDir) => path.join(mapDir, CONFIG_FILE);

/** The settings in a map folder, unread or invalid ones included, so a caller can say what is wrong. */
export function readConfig(dir) {
  const file = configPath(dir);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { file, present: false, value: {} }; }
  try {
    const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? { file, present: true, value } : { file, present: true, value: {}, problem: 'config.json must hold one JSON object.' };
  } catch (e) { return { file, present: true, value: {}, problem: `config.json is not valid JSON: ${e.message}` }; }
}

/** Everything the server and the driver need, with the environment's answers on top of the file's. */
export function resolveConfig(dir, env = process.env) {
  const { file, present, value: f, problem } = readConfig(dir);
  const pick = (envName, fileValue) => { const v = env[envName]; return v === undefined || v === '' ? fileValue : v; };
  const engine = String(pick('FLOORPLAN_ENGINE', f.engine) || '').toLowerCase();
  const baseUrl = String(pick('FLOORPLAN_BASE_URL', f.baseUrl) || '').trim();
  const model = String(pick('FLOORPLAN_MODEL', f.model) || '').trim();
  let givenKeyEnv = String(pick('FLOORPLAN_API_KEY_ENV', f.apiKeyEnv) || '').trim();
  // No variable named: use the one this provider's own documentation uses, so `OPENAI_API_KEY=… node driver.mjs`
  // just works for the common hosted APIs. Only these hosts (never an arbitrary address: sending a key meant for
  // one service to another would leak it). A local endpoint needs no key, and a gateway is named with apiKeyEnv.
  const conventional = { 'api.openai.com': 'OPENAI_API_KEY', 'api.deepseek.com': 'DEEPSEEK_API_KEY', 'openrouter.ai': 'OPENROUTER_API_KEY' }[(() => { try { return new URL(baseUrl).hostname; } catch { return ''; } })()] || '';
  const apiKeyFile = String(pick('FLOORPLAN_API_KEY_FILE', f.apiKeyFile) || '').trim();
  const tools = String(pick('FLOORPLAN_TOOLS', f.tools) || 'auto').toLowerCase();
  const problems = [];
  if (problem) problems.push(problem);
  // apiKeyEnv names a variable. A key pasted into it would silently send no key at all (and is exactly the kind
  // of thing someone does when the variable is awkward to set), so say so and refuse it rather than fail later.
  if (givenKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(givenKeyEnv)) {
    problems.push('config.json: "apiKeyEnv" must be the NAME of the environment variable that holds the key, not the key itself (a name is letters, digits and _ only, e.g. "OPENAI_API_KEY"). Nothing was sent to the endpoint. Either put the key in that variable, or put it in a file and point "apiKeyFile" at the file, or run the server with FLOORPLAN_API_KEY=<key>.');
    givenKeyEnv = '';
  }
  const apiKeyEnv = givenKeyEnv || conventional;
  if (engine && !ENGINES.includes(engine)) problems.push(`config.json: "engine" must be one of ${ENGINES.join(', ')}.`);
  if (baseUrl) { try { const u = new URL(baseUrl); if (!/^https?:$/.test(u.protocol)) problems.push('config.json: "baseUrl" must be an http:// or https:// address.'); } catch { problems.push(`config.json: "baseUrl" (${baseUrl}) is not an address.`); } }
  if (!TOOLS.includes(tools)) problems.push(`config.json: "tools" must be auto, on or off.`);
  if (f.apiKey) problems.push('config.json: never put a key in this file; set apiKeyEnv to the name of the variable that holds it, or apiKeyFile to a file that holds it.');
  for (const k of Object.keys(f)) if (!['engine', 'baseUrl', 'model', 'apiKeyEnv', 'apiKeyFile', 'tools', '$schema', 'about'].includes(k)) problems.push(`config.json: "${k}" isn't a setting. Use engine, baseUrl, model, apiKeyEnv, apiKeyFile or tools.`);
  // A key file is the desktop-friendly option: the key stays out of the project and out of the map folder (keep the
  // file readable by you only, and outside any repo), and a server started by an app finds it where a shell
  // variable wouldn't be set.
  let fileKey = '';
  if (apiKeyFile) {
    const expanded = apiKeyFile.replace(/^~(?=$|[\\/])/, env.HOME || env.USERPROFILE || '~');
    try {
      const text = fs.readFileSync(expanded, 'utf8').trim();
      if (text) fileKey = text.split(/\r?\n/)[0].trim();
      else problems.push(`config.json: "apiKeyFile" points at a file that is empty: ${apiKeyFile}.`);
    } catch { problems.push(`config.json: "apiKeyFile" can't be read: ${apiKeyFile}.`); }
  }
  const apiKey = env.FLOORPLAN_API_KEY || (apiKeyEnv ? env[apiKeyEnv] || '' : '') || fileKey;
  // whether this endpoint is on this machine (a local model needs no key, and says nothing to anyone)
  const local = (() => { try { return /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(new URL(baseUrl).host); } catch { return false; } })();
  return {
    file, present, engine, baseUrl, model, apiKeyEnv, apiKey, tools, problems,
    // whether the variable was named by the person (config.json / environment) or inferred from the provider
    keyEnvNamed: !!givenKeyEnv, apiKeyFile, local, keySet: !!apiKey,
    // an endpoint is configured when it has an address; the key is optional (local models have none)
    configured: !!baseUrl && !problems.some((p) => /baseUrl|config\.json is not/.test(p)),
  };
}

/** What the map's page is told: never the key, never the path of the endpoint, just enough to name it. */
export function publicConfig(cfg, { hostOf, engineLabel }) {
  return {
    configured: !!cfg?.configured,
    engineLabel: cfg?.baseUrl ? engineLabel(cfg) : '',
    baseUrlHost: cfg?.baseUrl ? hostOf(cfg.baseUrl) : '',
    model: cfg?.model || '',
    tools: cfg?.tools || 'auto',
  };
}

/** A short name for the engine, for the Ask bar and the server's log: "Ollama", "OpenAI", or the model's name. */
export function engineName(cfg) {
  const host = (() => { try { return new URL(cfg.baseUrl).hostname; } catch { return ''; } })();
  const local = /^(127\.0\.0\.1|localhost|::1)$/.test(host);
  if (/ollama|11434/.test(cfg.baseUrl)) return 'Ollama';
  if (/lmstudio|1234/.test(cfg.baseUrl)) return 'LM Studio';
  if (/vllm|8000\/v1/.test(cfg.baseUrl)) return 'vLLM';
  if (/api\.openai\.com/.test(cfg.baseUrl)) return 'OpenAI';
  if (/api\.deepseek\.com/.test(cfg.baseUrl)) return 'DeepSeek';
  const model = cfg.model ? cfg.model.replace(/:.*$/, '') : '';
  if (model) return local ? `local ${model}` : model;
  return local ? 'a local model' : host || 'a model endpoint';
}

/** Writes a config.json, refusing anything that would put a key on disk. Returns the file written. */
export function saveConfig(dir, value) {
  const clean = {};
  for (const k of ['engine', 'baseUrl', 'model', 'apiKeyEnv', 'tools']) if (value?.[k] !== undefined) clean[k] = value[k];
  if (value?.apiKey) throw new Error('Never write a key into config.json: set apiKeyEnv to the name of the environment variable that holds it.');
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(dir);
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
  return file;
}