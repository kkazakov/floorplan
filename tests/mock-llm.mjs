// A stand-in for any OpenAI-compatible model endpoint, for tests. Plain node:http, no dependencies: it answers
// /v1/chat/completions with whatever the test decides (a JSON answer, a tool call, an error status, a hang),
// and keeps every request so a test can check what the client sent.
//
//   const mock = await startMockLlm((body, n) => completion({ content: '{"title":"Hi"}' }));
//   const client = createClient({ baseUrl: mock.url, model: 'test' });
//   …
//   mock.requests // [{ url, headers, body, raw }]
//   await mock.close();
import http from 'node:http';

/** A 200 chat completion holding one assistant message. */
export function completion({ content = '', tool_calls, finish, role = 'assistant' } = {}) {
  return {
    id: 'chatcmpl-test', object: 'chat.completion', created: 1700000000, model: 'test',
    choices: [{ index: 0, message: { role, content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: finish || (tool_calls ? 'tool_calls' : 'stop') }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}
/** One function tool call, in the wire shape. */
export const toolCall = (name, args = {}, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/**
 * Starts a mock endpoint. `handler(body, n, record)` returns what to send:
 *   { content } / { tool_calls }                  → a chat completion
 *   { body, status }                              → that JSON as-is
 *   { status, raw }                               → that text as-is
 *   { hang: true }                                → never answers (for timeouts)
 * Any HTTP method other than POST, or another path, gets a 404.
 */
export async function startMockLlm(handler = () => ({ content: '{}' })) {
  const requests = [];
  let respond = handler;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 4e6) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const rec = { method: req.method, url: req.url, headers: req.headers, body, raw };
      const n = requests.length;
      requests.push(rec);
      let out;
      try { out = await respond(body, n, rec); } catch (e) { out = { status: 500, body: { error: { message: String(e?.message || e) } } }; }
      if (out?.hang) return; // the test wants the client to give up on its own
      if (out?.raw !== undefined) { res.writeHead(out.status || 200, { 'Content-Type': 'text/plain' }); return res.end(String(out.raw)); }
      const payload = out?.body !== undefined ? out.body : out?.choices ? out : completion(out || {});
      res.writeHead(out?.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    base: `http://127.0.0.1:${port}`,
    requests,
    set: (h) => { respond = h; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

/** The system message of a recorded request. */
export const systemOf = (rec) => rec?.body?.messages?.find((m) => m.role === 'system')?.content || '';
/** The last user message of a recorded request. */
export const lastUser = (rec) => [...(rec?.body?.messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
/** Whether a request carried a tool definition with this name. */
export const hasTool = (rec, name) => (rec?.body?.tools || []).some((t) => t?.function?.name === name);