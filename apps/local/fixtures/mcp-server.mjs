/* global process */
// A small stdio MCP server for the tests of the MCP probe. FAKE_MODE picks how it behaves:
// answer (the default) answers initialize and tools/list, exit writes an error and exits, and hang
// reads and never answers. FAKE_ECHO, when set, goes to stderr as is, the way a server that prints its
// own settings would.
const mode = process.env.FAKE_MODE ?? 'answer';
if (process.env.FAKE_ECHO !== undefined) process.stderr.write(`starting with key ${process.env.FAKE_ECHO}\n`);
if (mode === 'exit') {
  process.stderr.write('Error: the database at postgres://localhost/recipes refused the connection\n');
  process.exit(3);
}
const pages = [
  [{ name: 'search_recipes', description: 'Find recipes by title' }, { name: 'read_recipe' }],
  [{ name: 'list_menus' }],
];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (mode === 'hang' || message.id === undefined) continue;
    const answer = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
    if (message.method === 'initialize') answer({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake' } });
    else if (message.method === 'tools/list') {
      const page = Number(message.params?.cursor ?? 0);
      answer({ tools: pages[page], ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}) });
    } else process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not allowed in this test` } })}\n`);
  }
});
