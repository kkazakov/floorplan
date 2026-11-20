// Which coding agent is running the skill. The map records it, so its Ask bar and "Fix with …" prompts name
// the right one, and serve.mjs answers through the same CLI when that agent has one.
// --agent <name> (or FLOORPLAN_AGENT) decides; otherwise each agent is recognised by the variables it sets
// for every command it runs. Adding an agent is an entry here and a branch in the map's label table
// (assets/viewer.html, `const AGENT_ID`).
// "none" is for maps made without an agent session (in CI, in scripts, from your own tooling): the map then
// names no agent in its prompts ("Fix with AI"). Unattended mode (FLOORPLAN_UNATTENDED=1) implies it unless
// one is named, and so does any harness this file doesn't recognise: naming Claude for an agent that isn't
// Claude is worse than naming none.
import { isUnattended } from './common.mjs';

// Order matters: the first match wins, so the two agents with a CLI are checked first.
const DETECT = {
  claude: (env) => !!(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID),
  codex: (env) => !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID),
  dsh: (env) => !!(env.DSH_SESSION_ID || env.DSH_PROFILE_DIR),
  cursor: (env) => !!(env.CURSOR_AGENT || env.CURSOR_TRACE_ID),
  opencode: (env) => !!(env.OPENCODE || env.OPENCODE_SESSION_ID),
  gemini: (env) => !!(env.GEMINI_CLI || env.GEMINI_CLI_SESSION_ID),
  none: () => false, // only when asked for, in unattended mode, or when nothing else matched
};
export const AGENTS = Object.keys(DETECT);

export function detectAgent(args = {}, env = process.env) {
  const v = String(args.agent || env.FLOORPLAN_AGENT || '').toLowerCase();
  if (AGENTS.includes(v)) return v;
  if (isUnattended(env)) return 'none';
  return AGENTS.find((a) => DETECT[a](env)) || 'none';
}

// What each agent is called in the map and in open.mjs's output. `cli` is the program that answers questions
// from the map when the agent has one (only Claude Code and Codex do today); `app` is what a prompt is pasted
// into. "none" deliberately names nobody.
const NAMES = {
  claude: { name: 'Claude', app: 'Claude Code', cli: 'the Claude Code CLI', site: 'https://docs.claude.com/en/docs/claude-code' },
  codex: { name: 'Codex', app: 'Codex', cli: 'Codex', site: 'https://developers.openai.com/codex' },
  dsh: { name: 'DeepSeek Harness', app: 'DeepSeek Harness', cli: 'DeepSeek Harness', site: '' },
  cursor: { name: 'Cursor', app: 'Cursor', cli: 'Cursor', site: 'https://cursor.com' },
  opencode: { name: 'OpenCode', app: 'OpenCode', cli: 'OpenCode', site: 'https://opencode.ai' },
  gemini: { name: 'Gemini CLI', app: 'Gemini CLI', cli: 'the Gemini CLI', site: 'https://github.com/google-gemini/gemini-cli' },
  none: { name: 'AI', app: 'your AI assistant', cli: '', site: '' },
};
export const agentInfo = (agent) => NAMES[agent] || NAMES.none;

/**
 * What the CLI answering the map's questions is called, for open.mjs: its usual name, or, when its --version
 * names another program (a wrapper installed under the same command, `devin 3000.11.238` answering to
 * `claude`), that program, so the label never claims Claude Code or Codex for something else.
 */
export function cliLabel(engine, version = '') {
  const usual = agentInfo(engine).cli || NAMES.claude.cli;
  const v = String(version || '').trim();
  const named = /^([A-Za-z][\w.-]{0,40})\s+v?\d/.exec(v)?.[1];
  if (!named || new RegExp(engine === 'codex' ? 'codex' : 'claude', 'i').test(v)) return usual;
  return `${named}, found as the ${engine === 'codex' ? 'codex' : 'claude'} command`;
}