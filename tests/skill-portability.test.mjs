// SKILL.md has to run unchanged in any harness: Claude Code, Codex, DeepSeek Harness, Cursor, OpenCode,
// Gemini CLI, or a plain script that follows the workflow file. Those harnesses disagree about the syntax
// they fill in before the model reads a skill (`${CLAUDE_SKILL_DIR}`, `$ARGUMENTS`, a leading `!` command),
// so the file may use exactly one portable placeholder, `${FP}`, and no harness syntax outside the
// Claude-only frontmatter that declares which scripts run without a prompt.
// If one of these fails, someone has to edit SKILL.md for Floorplan to work in a new place: see
// docs/development.md ("Portable skills").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL } from './helpers.mjs';

const text = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
const frontmatter = m?.[1] || '';
const body = text.slice(m?.[0]?.length || 0);
const bodyLines = body.split('\n');
const UPDATE = 'If this is intended, update tests/skill-portability.test.mjs and docs/development.md together.';

test('SKILL.md starts with plain-YAML frontmatter a harness can parse without help', () => {
  assert.ok(m, 'the file starts with a --- frontmatter block');
  // the subset every harness accepts: `key: value`, a quoted value, and a list of `- item`s under one key
  const parsed = {};
  let list = null;
  for (const line of frontmatter.split('\n')) {
    if (!line.trim()) continue;
    if (/^ {2}- /.test(line)) {
      assert.ok(list, `a list item outside a list: ${line}`);
      list.push(line.replace(/^ {2}- /, '').trim());
      continue;
    }
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    assert.ok(kv, `frontmatter line isn't plain YAML: ${line}`);
    const [, k, v] = kv;
    list = null;
    if (v === '') { list = parsed[k] = []; continue; }
    if (v.startsWith('"')) {
      // a one-line double-quoted string: the description, which must not wrap
      assert.match(v, /^".*"$/, `a quoted value must close on its own line: ${k}. ${UPDATE}`);
      parsed[k] = v.slice(1, -1).replace(/\\"/g, '"');
    } else parsed[k] = v;
  }
  assert.deepEqual(Object.keys(parsed).sort(), ['allowed-tools', 'argument-hint', 'description', 'name'], `frontmatter keys. ${UPDATE}`);
  assert.equal(parsed.name, 'floorplan');
  assert.ok(parsed.description.length > 50, 'the description says when to use the skill');
  // `${...}` in the frontmatter is Claude Code's, and allowed only in the pre-approved script list
  for (const line of frontmatter.split('\n')) {
    if (line.includes('${')) assert.match(line, /^ {2}- Bash\(node \$\{CLAUDE_SKILL_DIR\}\/scripts\/(\w+\.mjs) \*\)$/, `frontmatter templates. ${UPDATE}`);
  }
});

test('the body uses one portable placeholder, not a harness’s syntax', () => {
  const mentions = bodyLines.filter((l) => l.includes('${CLAUDE_SKILL_DIR}'));
  assert.equal(mentions.length, 1, `the body may mention ${'${CLAUDE_SKILL_DIR}'} only in the note that maps it to ${'${FP}'}. ${UPDATE}`);
  assert.match(mentions[0], /`\$\{FP\}` in the commands below is the folder holding this SKILL\.md/, 'the note defines FP where it mentions the Claude-specific name');
  // no `${...}` other than the two the note documents, and the {now} template the scripts print
  // (uppercase names are harness variables; ${'${file(...)}'} and the like are Serverless config syntax quoted from a user's repo)
  for (const line of bodyLines) for (const [, name] of line.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)) assert.ok(['FP', 'CLAUDE_SKILL_DIR'].includes(name), `unknown placeholder \${${name}}. ${UPDATE}`);
  // a leading `!` runs a command before the model reads the skill: Claude Code only, and invisible elsewhere
  const bang = bodyLines.filter((l) => /^\s*!`/.test(l) || /`\s*!`node /.test(l));
  assert.deepEqual(bang, [], `no harness-run command lines. ${UPDATE}`);
  // Claude Code fills this in before the model sees the skill; elsewhere it would be read as literal text
  assert.doesNotMatch(body, /\$ARGUMENTS\b/, `no $ARGUMENTS placeholder. ${UPDATE}`);
  // every script it tells the model to run exists, and is one the frontmatter pre-approves for Claude Code
  const scripts = [...new Set([...body.matchAll(/\$\{FP\}\/scripts\/(\w+\.mjs)/g)].map((x) => x[1]))];
  assert.ok(scripts.length >= 8, `SKILL.md names the skill's scripts (found ${scripts.join(', ')})`);
  for (const s of scripts) assert.ok(fs.existsSync(path.join(SKILL, 'scripts', s)), `scripts/${s}`);
  for (const s of scripts) assert.match(frontmatter, new RegExp(`scripts/${s.replaceAll('.', '\\.')} \\*\\)`), `scripts/${s} is in allowed-tools`);
});

test('the skill says how each harness is recognised, and that an unknown one names nobody', () => {
  assert.match(body, /DeepSeek Harness/, 'the harnesses it names include the ones it can detect');
  assert.match(body, /a harness they\s+don't recognise is treated as no agent at all/, 'an unknown harness is named as none, not Claude');
});

test('a driver and an engine can be run without a harness at all', () => {
  // the files a plain script follows: the workflow, and the map's own server
  assert.ok(fs.existsSync(path.join(SKILL, 'workflow.json')));
  assert.ok(fs.existsSync(path.join(SKILL, 'driver.mjs')), 'the shipped driver follows workflow.json with any model');
  assert.match(body, /driver\.mjs/, 'SKILL.md says a model endpoint replaces the agent session');
  assert.match(body, /config\.json/, 'SKILL.md says where a model endpoint is configured');
});