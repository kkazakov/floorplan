# Engines: which model answers the map

Floorplan's map works on its own. **Asking** it questions, tracing a flow, or changing a blueprint needs an
**engine**: something that can read the map (and, when it can, the code) and answer.

There are three, and you need exactly one:

| Engine | What it is | Needs |
|---|---|---|
| `http` | Any model behind an **OpenAI-compatible** endpoint: OpenAI, DeepSeek, OpenRouter and most gateways, and local models on **Ollama**, **LM Studio**, **vLLM**, llama.cpp | Node 18+ and an address |
| `claude` | The **Claude Code CLI**, on your own sign-in | `claude` installed and signed in |
| `codex` | The **Codex CLI**, in its read-only sandbox | `codex` installed and signed in |

No CLI is needed for `http`, and no key is needed for a local model. The map is the same either way: the Ask
bar, flows, Health and Change behave identically, and the page is told which engine is answering so its
buttons say "Fix with …" for the right one.

## Choosing an engine

The map's server picks one, in this order:

1. `--engine` on the command line, `FLOORPLAN_ENGINE`, or `"engine"` in `floorplan/config.json`. This never
   falls back: if you ask for an engine and it isn't available, the Ask bar says so.
2. The agent that built the map, if its CLI is installed (`--agent claude` or `--agent codex`, or the harness
   that ran the skill).
3. A model endpoint configured in `floorplan/config.json` (or `FLOORPLAN_BASE_URL`).
4. The other agent CLI, if it's installed (the map has always fallen back from Claude Code to Codex and back).
5. Nothing: the map still opens, and the Ask bar explains how to give it an engine.

`--claude <path>` and `--codex <path>` point at an unusual install. `--model <name>` picks the model for a CLI,
and `--base-url`, `--model` and `--api-key-env` override the settings file for one run.

## Configuring a model endpoint

Put this in `floorplan/config.json`:

```json
{
  "engine": "http",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "model": "qwen3-coder",
  "apiKeyEnv": "OPENAI_API_KEY",
  "tools": "auto"
}
```

| Key | What it is |
|---|---|
| `baseUrl` | The endpoint. Either the API root (`https://api.deepseek.com/v1`, `http://127.0.0.1:11434`) or the full `…/chat/completions` address; `/v1/chat/completions` is added when it's missing |
| `model` | The model name the endpoint expects |
| `apiKeyEnv` | **The name of the environment variable that holds the key**, never the key itself (a pasted key is refused with a message, because it would silently send no key at all). Omit it for a local model that needs none. For a few well-known hosted APIs you can leave it out entirely and the variable their own documentation uses is tried: `OPENAI_API_KEY` for `api.openai.com`, `DEEPSEEK_API_KEY` for `api.deepseek.com`, `OPENROUTER_API_KEY` for `openrouter.ai`. Any other address, including a gateway, must name its variable: a key meant for one service is never sent to another |
| `apiKeyFile` | A file that holds the key (the first line), for when an environment variable is awkward — a map server started by a desktop app doesn't see your shell's variables. Keep it outside the project and readable by you only: `chmod 600 ~/.config/floorplan/model.key`. `~` is expanded. An explicit `apiKeyEnv` or `FLOORPLAN_API_KEY` wins over it |
| `tools` | `"auto"` (default), `"on"` or `"off"`: whether the model may use the lookup and file tools |
| `engine` | Optional, `"http"`; it makes the choice explicit when the map was built by a CLI |

Every setting has an environment variable that wins over the file, which is how CI and a shell switch models
without editing anything:

| Variable | Overrides |
|---|---|
| `FLOORPLAN_ENGINE` | `engine` |
| `FLOORPLAN_BASE_URL` | `baseUrl` |
| `FLOORPLAN_MODEL` | `model` |
| `FLOORPLAN_API_KEY_ENV` | `apiKeyEnv` |
| `FLOORPLAN_API_KEY` | the key itself, read from this variable first (never written anywhere) |
| `FLOORPLAN_API_KEY_FILE` | `apiKeyFile` |
| `FLOORPLAN_TOOLS` | `tools` |
| `FLOORPLAN_TOOL_CALLS` | how many tool calls one question may make (default 12, 30 for a change) |
| `FLOORPLAN_TIMEOUT_MS` | how long to wait for an answer (default 180000) |

The map folder ignores itself in git, so `config.json` is never committed. Keys are never written to it: a
`config.json` with an `apiKey` in it is refused, and a key pasted into `apiKeyEnv` is refused too (with a message
saying what to do instead), because either one would otherwise fail at the endpoint with a confusing 401. Put the
key in the variable `apiKeyEnv` names, or in a file `apiKeyFile` points at, both outside the map folder. The map's
page and `/api/health` receive the engine's **name**, its **model**, the endpoint's **host** and whether a key was
found — never the key and never the endpoint's path.

### Recipes

**Ollama** (local, no key):

```bash
ollama pull qwen3-coder
printf '%s\n' '{ "engine": "http", "baseUrl": "http://127.0.0.1:11434/v1", "model": "qwen3-coder" }' > floorplan/config.json
node floorplan/serve.mjs
```

**LM Studio**: start its local server, then use `http://127.0.0.1:1234/v1` and the model name it shows.

**OpenAI**:

```json
{ "engine": "http", "baseUrl": "https://api.openai.com/v1", "model": "gpt-4.1-mini", "apiKeyEnv": "OPENAI_API_KEY" }
```

Or with no `apiKeyEnv` at all, since that is the variable OpenAI's own docs use:

```bash
OPENAI_API_KEY=sk-… node floorplan/serve.mjs
```

**DeepSeek**: `https://api.deepseek.com/v1` with `deepseek-chat`, and `DEEPSEEK_API_KEY` in the environment.

**A gateway** (OpenRouter, LiteLLM, a company proxy): its base URL, a model id it accepts, and the variable
holding its key.

## What the model gets, and what happens when it can't use it

Three qualities of answer, chosen per endpoint, degrading honestly rather than failing:

1. **Full: tools and source.** The model gets the map's lookup tools (`find_items`, `get_item`,
   `dependency_path`, served by the map's server) and read-only file tools (`read_file`, `list_files`, `grep`),
   so it can answer from the code itself.
2. **Graph-only.** Models that don't take tools still answer: the prompt carries the map, and the instructions
   say plainly that the source can't be read. This is the same flavor the map gives a tool-less agent, and it's
   honest about what it doesn't know. `"tools": "off"` asks for it deliberately.
3. **No structured output.** `Change` on a blueprint needs the endpoint to accept a JSON Schema (or JSON mode,
   which is tried next). If it accepts neither, the model still answers questions and the answer is read out of
   its text; Change is simply not offered.

Every question also carries a small digest of the map itself — its parts, its flows, and the cards nearest the
question — so a model that can't look anything up still has the map in front of it rather than having to guess.

The client tries function calling and structured output first, and on the first refusal from the endpoint (a
`400` naming `tools` or `response_format`) it drops that feature and carries on. It remembers the result for the
life of the server, so a model is never asked twice for something it already refused.

The same happens for single request parameters, which real providers refuse one at a time: newer OpenAI models
want `max_completion_tokens` rather than `max_tokens`, reasoning models refuse a temperature, and some refuse a
`strict` schema. Each is dropped on the first refusal and remembered, so the model answers with the provider's
own defaults instead of the question failing. Nothing about this is provider-specific: it is all plain
`/chat/completions`, and a local runtime that accepts the standard parameters never sees a retry.

If an answer doesn't match the schema, the problems are sent back and the model is asked again — up to two
retries, the same budget the [headless workflow](unattended.md) uses — before anything is written. That holds
for an answer given as a tool call too: a `submit` call is checked exactly like prose, so a model that wraps the
document in another field or fills in only part of it is corrected rather than written. A document wrapped in
exactly one field is unwrapped when the inner document is itself valid (`{"architecture": {…}}` and
`{"arguments": {…}}` are common), so a cosmetic difference doesn't cost a retry.

## Privacy: where each engine sends what

A question you ask the map leaves your computer only if the engine you chose sends it somewhere. Nothing else
does: the map makes no outside requests, and Health, the scan and the build are entirely local.

| Engine | What leaves the computer | Where it goes |
|---|---|---|
| `http` | the question, the map's digest of names/descriptions/connections, and any file the model asks to read (through its tools) | the endpoint in `floorplan/config.json`, over `http://` or `https://` as you configured it. A local endpoint (Ollama, LM Studio) is on your own machine: nothing leaves it |
| `claude` | the question and whatever the CLI reads | Anthropic, on your own sign-in |
| `codex` | the question and whatever the CLI reads | OpenAI, on your own sign-in |
| nothing | — | the Ask bar says what's missing |

What is **never** sent, on any engine: the map's `config.json`, your API key as content (it travels only in the
`Authorization` header of the request it belongs to), and the values of anything that looks like a secret in a
file the model reads. Tool results and answers pass through a masker first: private key blocks, well-known key
formats (`sk-…`, `AKIA…`, `ghp_…`, `sk_live_…` and the rest), passwords in connection URLs, and quoted values
given to names like `PASSWORD` or `apiKey` come back as `«hidden»`. Files that exist only to hold secrets
(`.env`, `*.pem`, `id_rsa`, `credentials.json`) can't be read by the tools at all.

The [headless driver](unattended.md) additionally uses the skill's full `maskSecrets` on every tool result and
every answer it writes: it also hides long random-looking strings and the lines Health would flag.

## What the tools may touch

The `http` engine's tools are read-only and bounded to the codebase root:

- **Inside the root only.** `../` and absolute paths outside it are refused.
- **No writes.** There is no write, delete, move or shell tool at all.
- **The generated map is skipped**: `floorplan/index.html` (about 2 MB on one line — the layout engine and fonts
  — which would blow a small model's context), `serve.mjs`, `llm.mjs`, `page-safety.mjs`, `.cache/**` and
  `artifact.html`.
- **Secret and settings files are skipped**: `.env` and friends, `*.pem`, `*.key`, `id_rsa`,
  `secrets.yaml`, `credentials.json`.
- **A budget per question** (`FLOORPLAN_TOOL_CALLS`), after which the model is told to answer with what it has.

## Troubleshooting

| What the Ask bar says | What it means |
|---|---|
| *not found, and no model endpoint is set* | nothing is configured: add `baseUrl`/`model` to `floorplan/config.json`, or install a CLI |
| *isn't signed in* / *401* | the endpoint refused the key: check the variable named by `apiKeyEnv`, or the file `apiKeyFile` points at. If the message says *no key was sent*, nothing named one: set `apiKeyEnv`, `apiKeyFile` or `FLOORPLAN_API_KEY` |
| *rate limited* / *429* | the provider is throttling: wait, or switch model |
| *did not answer within …* | raise `FLOORPLAN_TIMEOUT_MS`, or use a smaller model |
| *Could not reach …* | wrong `baseUrl`, or the local server isn't running (`ollama serve`) |
| *model … not found* | the model id isn't what the endpoint expects |
| *its answer didn't fit* | the model can't follow the answer schema well enough: try a larger model, or `"tools": "on"` |

Restart `serve.mjs` after editing `config.json`: settings are read at startup.

## Without a map server at all

`driver.mjs` runs the whole pipeline — scan, architecture, describe, recent work — against the same kind of
endpoint, with no server, no browser and no agent session. It reads the same `config.json` and the same
environment variables. See [Running Floorplan without an agent session](unattended.md).

## Not in this version

- Native Anthropic and Gemini HTTP adapters. The OpenAI-compatible surface covers OpenAI, DeepSeek, most
  gateways and every local runtime; Anthropic and Gemini both offer an OpenAI-compatible endpoint today.
- A picker for the engine inside the map. `config.json` and the `FLOORPLAN_*` variables are the surface for now;
  a picker would be a UI change on top of this, not a different engine.