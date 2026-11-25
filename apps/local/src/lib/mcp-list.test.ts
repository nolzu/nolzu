import { expect, it } from 'vitest';
import { emptyEntry, entryProblem, gridPhases, MCP_FILE, type McpEntry, mcpListText, parseMcpList, secretKeysOf, serversFor, unlimitedReadOnly, urlWarning } from './mcp-list.ts';

const local = (patch: Partial<McpEntry> = {}): McpEntry => ({ ...emptyEntry(), name: 'db', command: 'db-mcp', ...patch });
const remote = (patch: Partial<McpEntry> = {}): McpEntry => ({ ...emptyEntry(), name: 'docs', kind: 'remote', url: 'https://mcp.example.com/mcp', ...patch });

it('writes the list and reads it back the same, with no secret value in the file', () => {
  const servers = [
    local({ description: 'The test database', args: ['--read-only'], cwd: 'tools', env: [{ name: 'DB_TOKEN', secret: true, value: 'hunter2' }, { name: 'LEVEL', secret: false, value: '1' }], tools: ['query'], phases: ['plan', 'qa'] }),
    remote({ transport: 'sse', headers: [{ name: 'Authorization', secret: true, value: 'Bearer abc' }, { name: 'X-Team', secret: false, value: 'web' }] }),
  ];
  const text = mcpListText(servers);

  expect(text).not.toContain('hunter2');
  expect(text).not.toContain('Bearer abc');
  const back = parseMcpList(text);
  expect(back.problems).toEqual([]);
  expect(back.servers).toEqual([
    { ...servers[0], env: [{ name: 'DB_TOKEN', secret: true }, { name: 'LEVEL', secret: false, value: '1' }] },
    { ...servers[1], headers: [{ name: 'Authorization', secret: true }, { name: 'X-Team', secret: false, value: 'web' }] },
  ]);
});

it('drops a value a teammate left beside a secret, and never hands it on', () => {
  const file = JSON.stringify({ servers: [{ name: 'db', kind: 'local', command: 'x', env: [{ name: 'T', secret: true, value: 'leaked' }] }] });
  expect(parseMcpList(file).servers[0]?.env).toEqual([{ name: 'T', secret: true }]);
});

it('names each entry it leaves out, keeps it for the next write, and reads no server from a file that is no list', () => {
  const file = JSON.stringify({ servers: [local(), 'nope', local(), local({ name: 'a b' })] });
  const read = parseMcpList(file);
  expect(read.servers.map((one) => one.name)).toEqual(['db']);
  expect(read.problems).toEqual([
    `Entry 2 of ${MCP_FILE} is not a server. Nolzu keeps it in the file as it is.`,
    `Entry 3 of ${MCP_FILE} is left out and kept in the file as it is. There is a server named db already.`,
    `Entry 4 of ${MCP_FILE} is left out and kept in the file as it is. A server name holds letters, digits, - and _ only, at most 64 of them, and does not start with -.`,
  ]);
  expect(read.rest.kept).toHaveLength(3);
  expect(read.broken).toBeNull();
  expect(parseMcpList('{').broken).toMatch(/is not JSON, so Nolzu reads no server from it and writes nothing to it/);
  expect(parseMcpList('{}').broken).toMatch(/has no list of servers/);
  expect(parseMcpList('<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> b\n').broken).toMatch(/git conflict/);
  expect(parseMcpList(null)).toEqual({ servers: [], problems: [], broken: null, rest: { top: {}, kept: [] } });
});

it('names a secret value a hand edit left in the file, and drops it on the next write', () => {
  const read = parseMcpList(JSON.stringify({ servers: [{ ...local(), env: [{ name: 'T', secret: true, value: 'leaked' }] }] }));
  expect(read.problems[0]).toMatch(/holds a value for the secret T of db, which every teammate gets with the file/);
  expect(mcpListText(read.servers, read.rest)).not.toContain('leaked');
});

it('refuses secret mode for a name an engine reads for itself', () => {
  for (const name of ['HOME', 'PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'codex_anything', 'NOLZU_X']) {
    expect(entryProblem(local({ env: [{ name, secret: true }] }), [])).toMatch(/cannot be a secret/);
    expect(entryProblem(local({ env: [{ name, secret: false, value: 'x' }] }), [])).toBeNull();
  }
  expect(entryProblem(local({ env: [{ name: 'DB_LOGIN', secret: true }] }), [])).toBeNull();
});

it('warns on an address with a key that looks like a login', () => {
  expect(urlWarning(remote({ url: 'https://mcp.example.com/mcp?token=abc' }))).toMatch(/holds token=/);
  expect(urlWarning(remote({ url: 'https://mcp.example.com/mcp?team=web' }))).toBeNull();
  expect(urlWarning(local())).toBeNull();
});

it.each([
  [local({ name: '-x' }), /does not start with -/],
  [local({ command: ' ' }), /no command/],
  [local({ command: '--flag' }), /reads as an option/],
  [remote({ url: 'mcp.example.com' }), /full address/],
  [remote({ url: 'http://mcp.example.com/mcp' }), /https/],
  [remote({ url: 'https://me:pw@mcp.example.com/mcp' }), /password/],
  [local({ env: [{ name: '1X', secret: true }] }), /cannot take/],
  [local({ env: [{ name: 'A', secret: true }, { name: 'a', secret: false, value: '' }] }), /twice/],
  [local({ env: [{ name: 'A', secret: false, value: 'one\ntwo' }] }), /line break/],
  [remote({ headers: [{ name: 'Bad Header', secret: false, value: 'x' }] }), /cannot take/],
  [local({ tools: ['ok', 'not ok'] }), /tool name/],
  [local({ phases: ['deploy'] }), /no phase/],
])('refuses %#', (entry, said) => {
  expect(entryProblem(entry, [])).toMatch(said);
});

it('takes http on this machine and a name another server does not have', () => {
  expect(entryProblem(remote({ url: 'http://localhost:4000/mcp' }), [])).toBeNull();
  expect(entryProblem(local({ name: 'DB' }), [local()])).toMatch(/already/);
});

it('lists the secrets of a server, env and headers apart', () => {
  expect(secretKeysOf(remote({ env: [{ name: 'A', secret: true }, { name: 'B', secret: false, value: '' }], headers: [{ name: 'A', secret: true }] }))).toEqual([
    { where: 'env', name: 'A' },
    { where: 'header', name: 'A' },
  ]);
});

it('draws a column per phase of the boards that are on, read-only marked', () => {
  const all = gridPhases([]).map((column) => column.phase);
  expect(all).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup', 'architecture', 'design', 'investigate', 'research', 'pr-review', 'feedback']);
  const few = gridPhases(['epics', 'investigations', 'questions', 'prreview']).map((column) => column.phase);
  expect(few).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup', 'feedback']);
  expect(gridPhases([]).find((column) => column.phase === 'implement')?.readOnly).toBe(false);
  expect(gridPhases([]).find((column) => column.phase === 'plan')).toEqual({ phase: 'plan', label: 'Plan', readOnly: true });
});

it('warns about a server with no tool list on a read-only phase, and hands a run only the servers on for it', () => {
  expect(unlimitedReadOnly(local({ phases: ['implement', 'plan', 'qa'] }))).toEqual(['plan', 'qa']);
  expect(unlimitedReadOnly(local({ phases: ['plan'], tools: ['query'] }))).toEqual([]);
  // A new server is off everywhere.
  expect(serversFor([local(), remote({ phases: ['plan'] })], 'plan').map((one) => one.name)).toEqual(['docs']);
  expect(emptyEntry().phases).toEqual([]);
});
