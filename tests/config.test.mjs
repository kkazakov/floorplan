// floorplan/config.json and the FLOORPLAN_* overrides (skills/floorplan/assets/config.mjs): which engine, which
// endpoint, which model, and the name of the variable a key lives in. The rules the docs promise: the
// environment wins over the file, a key is never written to the file, and a typo is reported rather than ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shopApp, run, cleanup } from './helpers.mjs';

const C = await import(new URL('../skills/floorplan/assets/config.mjs', import.meta.url));
const { readConfig, resolveConfig, saveConfig, engineName, publicConfig, configPath } = C;
const L = await import(new URL('../skills/floorplan/assets/llm.mjs', import.meta.url));

/** A map folder with a config.json (or none). */
function mapWith(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-config-'));
  if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}
const dirs = [];
const dir = (config) => { const d = mapWith(config); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

test('no config.json is not an error: the map just has no endpoint', () => {
  const d = dir();
  assert.deepEqual(readConfig(d), { file: configPath(d), present: false, value: {} });
  const cfg = resolveConfig(d, {});
  assert.equal(cfg.present, false);
  assert.equal(cfg.baseUrl, '');
  assert.equal(cfg.configured, false);
  assert.deepEqual(cfg.problems, []);
  assert.equal(cfg.tools, 'auto', 'tools default to auto');
});

test('the file is read, and the environment wins over it', () => {
  const d = dir({ engine: 'http', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder', apiKeyEnv: 'OLLAMA_KEY', tools: 'on' });
  const file = resolveConfig(d, {});
  assert.equal(file.engine, 'http');
  assert.equal(file.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(file.model, 'qwen3-coder');
  assert.equal(file.tools, 'on');
  assert.equal(file.configured, true);
  assert.deepEqual(file.problems, []);
  const env = resolveConfig(d, { FLOORPLAN_BASE_URL: 'https://api.deepseek.com/v1', FLOORPLAN_MODEL: 'deepseek-chat', FLOORPLAN_ENGINE: 'http', FLOORPLAN_TOOLS: 'off' });
  assert.equal(env.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(env.model, 'deepseek-chat');
  assert.equal(env.tools, 'off');
  assert.equal(env.apiKeyEnv, 'OLLAMA_KEY', 'the file still names the variable when the environment only sets the address');
  // an empty variable is unset, not "empty"
  assert.equal(resolveConfig(d, { FLOORPLAN_BASE_URL: '' }).baseUrl, 'http://127.0.0.1:11434/v1');
});

test('a key is read from the variable named, and only from there', () => {
  const d = dir({ baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'MY_MODEL_KEY' });
  assert.equal(resolveConfig(d, { MY_MODEL_KEY: 'from-the-name' }).apiKey, 'from-the-name');
  assert.equal(resolveConfig(d, { MY_MODEL_KEY: 'from-the-name', FLOORPLAN_API_KEY: 'generic' }).apiKey, 'generic', 'the generic variable wins');
  assert.equal(resolveConfig(d, {}).apiKey, '', 'no variable, no key: a local model needs none');
});

test('the common hosted APIs find their key in their own documented variable, and nobody else sees one', () => {
  // OPENAI_API_KEY=… node driver.mjs works with no apiKeyEnv at all; so do DeepSeek and OpenRouter
  const openai = resolveConfig(dir({ baseUrl: 'https://api.openai.com/v1' }), { OPENAI_API_KEY: 'sk-openai' });
  assert.equal(openai.apiKey, 'sk-openai');
  assert.equal(openai.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(openai.keyEnvNamed, false, 'inferred, not named by the person');
  assert.equal(resolveConfig(dir({ baseUrl: 'https://api.deepseek.com/v1' }), { DEEPSEEK_API_KEY: 'sk-deepseek' }).apiKey, 'sk-deepseek');
  assert.equal(resolveConfig(dir({ baseUrl: 'https://openrouter.ai/api/v1' }), { OPENROUTER_API_KEY: 'sk-or' }).apiKey, 'sk-or');
  // a key named by the person always wins, even on those hosts
  const named = resolveConfig(dir({ baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'MY_PROXY' }), { OPENAI_API_KEY: 'sk-openai', MY_PROXY: 'sk-mine' });
  assert.equal(named.apiKey, 'sk-mine');
  assert.equal(named.keyEnvNamed, true);
  // and an address that isn't one of them never gets a conventional key: it could belong to another service
  assert.equal(resolveConfig(dir({ baseUrl: 'https://gateway.example.com/v1' }), { OPENAI_API_KEY: 'sk-openai' }).apiKey, '');
  assert.equal(resolveConfig(dir({ baseUrl: 'http://127.0.0.1:11434/v1' }), { OPENAI_API_KEY: 'sk-openai' }).apiKey, '', 'a local endpoint never gets one either');
});

test('a typo, a bad address or a key in the file is reported, not ignored', () => {
  assert.match(resolveConfig(dir({ engine: 'chatgpt' }), {}).problems.join('\n'), /"engine" must be one of http, claude, codex/);
  assert.match(resolveConfig(dir({ baseUrl: 'not-an-address' }), {}).problems.join('\n'), /"baseUrl" \(not-an-address\) is not an address/);
  assert.match(resolveConfig(dir({ baseUrl: 'ftp://host/v1' }), {}).problems.join('\n'), /http:\/\/ or https:\/\//);
  assert.match(resolveConfig(dir({ tools: 'maybe' }), {}).problems.join('\n'), /"tools" must be auto, on or off/);
  assert.match(resolveConfig(dir({ apiKey: 'sk-nope' }), {}).problems.join('\n'), /never put a key in this file/);
  assert.match(resolveConfig(dir({ baseURL: 'http://host/v1' }), {}).problems.join('\n'), /"baseURL" isn't a setting/);
  assert.match(resolveConfig(dir('{ not json'), {}).problems.join('\n'), /not valid JSON/);
  // a file with only problems is not a configured endpoint
  assert.equal(resolveConfig(dir({ baseUrl: 'not-an-address' }), {}).configured, false);
});

test('the engine is named for a person: the product it is, or the model', () => {
  assert.equal(engineName({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder' }), 'Ollama');
  assert.equal(engineName({ baseUrl: 'http://localhost:1234/v1', model: 'qwen' }), 'LM Studio');
  assert.equal(engineName({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' }), 'OpenAI');
  assert.equal(engineName({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }), 'DeepSeek');
  assert.equal(engineName({ baseUrl: 'http://gpu-box:8080/v1', model: 'qwen3-coder:30b' }), 'qwen3-coder', 'a local endpoint with a model: the model, without its tag');
  assert.equal(engineName({ baseUrl: 'http://gpu-box:8080/v1', model: '' }), 'gpu-box', 'no model: the host');
});

test('what the page is told about the endpoint: never the key, never the path', () => {
  const cfg = resolveConfig(dir({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder' }), { OPENAI_API_KEY: 'sk-secret' });
  const pub = publicConfig(cfg, { hostOf: L.hostOf, engineLabel: engineName });
  assert.deepEqual(pub, { configured: true, engineLabel: 'Ollama', baseUrlHost: '127.0.0.1:11434', model: 'qwen3-coder', tools: 'auto' });
  assert.doesNotMatch(JSON.stringify(pub), /sk-secret|\/v1/);
  assert.deepEqual(publicConfig({ configured: false }, { hostOf: L.hostOf, engineLabel: engineName }), { configured: false, engineLabel: '', baseUrlHost: '', model: '', tools: 'auto' });
});

test('writing a config refuses to put a key on disk, and keeps only the settings it knows', () => {
  const d = dir();
  const file = saveConfig(d, { engine: 'http', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder', apiKeyEnv: 'MY_KEY', tools: 'auto', note: 'not a setting' });
  assert.equal(file, configPath(d));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { engine: 'http', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder', apiKeyEnv: 'MY_KEY', tools: 'auto' });
  assert.throws(() => saveConfig(d, { baseUrl: 'http://host/v1', apiKey: 'sk-nope' }), /Never write a key/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { engine: 'http', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-coder', apiKeyEnv: 'MY_KEY', tools: 'auto' }, 'a refused write changes nothing');
});

test('a config.json in a built map is kept out of git with the rest of the folder', () => {
  const root = shopApp();
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--no-claude-md', '--agent', 'none');
    saveConfig(path.join(root, 'floorplan'), { engine: 'http', baseUrl: 'http://127.0.0.1:11434/v1' });
    const ignore = fs.readFileSync(path.join(root, 'floorplan', '.gitignore'), 'utf8');
    assert.match(ignore, /^\*$/m, 'the folder ignores everything in it, config.json included');
    assert.equal(resolveConfig(path.join(root, 'floorplan'), {}).baseUrl, 'http://127.0.0.1:11434/v1');
  } finally { cleanup(root); }
});
test('a key pasted into apiKeyEnv is refused with the variable-name explanation, and nothing is sent', () => {
  const pasted = ['sk', 'sp', 'H.RHHDR.dYfQ.MEQCIBPgp', 'xma2B', 'z0q2SAi9sdSy2i8TPvnzntHn43xh'].join('-');
  const cfg = resolveConfig(dir({ baseUrl: 'https://maas.example.com/compatible-mode/v1', model: 'm', apiKeyEnv: pasted }), {});
  assert.match(cfg.problems.join('\n'), /"apiKeyEnv" must be the NAME of the environment variable/);
  assert.equal(cfg.apiKeyEnv, '', 'the key is not used as a variable name');
  assert.equal(cfg.apiKey, '', 'and no key is sent');
  assert.equal(cfg.keySet, false);
  assert.ok(!JSON.stringify(cfg.problems).includes(pasted.slice(20)), 'the message never repeats the key');
  // an ordinary name is fine, and the key comes from it
  assert.equal(resolveConfig(dir({ baseUrl: 'https://maas.example.com/compatible-mode/v1', apiKeyEnv: 'MAAS_KEY' }), { MAAS_KEY: 'abc' }).apiKey, 'abc');
  // a local endpoint needs none, and is reported as local
  assert.equal(resolveConfig(dir({ baseUrl: 'http://127.0.0.1:11434/v1' }), {}).local, true);
  assert.equal(resolveConfig(dir({ baseUrl: 'https://maas.example.com/v1' }), {}).local, false);
});

test('a key file holds the key outside the project, and loses to an explicit environment', () => {
  const home = dir();
  const keyFile = path.join(home, 'model-key');
  fs.writeFileSync(keyFile, 'sk-from-the-file\n', { mode: 0o600 });
  const cfg = resolveConfig(dir({ baseUrl: 'https://maas.example.com/v1', apiKeyFile: keyFile }), {});
  assert.equal(cfg.apiKey, 'sk-from-the-file');
  assert.equal(cfg.keySet, true);
  assert.deepEqual(cfg.problems, []);
  // ~ is expanded, the file's first line is the key, and an environment variable wins over it
  const base = path.join(home, 'map');
  fs.mkdirSync(path.join(base), { recursive: true });
  fs.writeFileSync(path.join(home, 'tilde-key'), 'sk-tilde\n');
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ baseUrl: 'https://maas.example.com/v1', apiKeyFile: '~/tilde-key' }));
  assert.equal(resolveConfig(base, { HOME: home }).apiKey, 'sk-tilde');
  assert.equal(resolveConfig(base, { HOME: home, FLOORPLAN_API_KEY: 'sk-env' }).apiKey, 'sk-env');
  // a missing or empty file is reported, and no key is sent
  const bad = resolveConfig(dir({ baseUrl: 'https://maas.example.com/v1', apiKeyFile: '/no/such/key' }), {});
  assert.match(bad.problems.join('\n'), /"apiKeyFile" can't be read/);
  assert.equal(bad.keySet, false);
  const empty = path.join(home, 'empty-key');
  fs.writeFileSync(empty, '   \n');
  assert.match(resolveConfig(dir({ baseUrl: 'https://maas.example.com/v1', apiKeyFile: empty }), {}).problems.join('\n'), /points at a file that is empty/);
});
