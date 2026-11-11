import { afterAll, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateQuery } from '../src/sql.js';
import { loadProfiles } from '../src/config.js';
import { Database } from '../src/database.js';
import { createServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

it.each(['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x', 'SELECT $1::text', "SELECT ';DELETE FROM x'", 'VALUES (1)'])('accepts %s', async sql => {
  await expect(validateQuery(sql)).resolves.toBeUndefined();
});
it.each(['', 'SELECT 1; SELECT 2', 'DELETE FROM x', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'SELECT * INTO x FROM y', 'SELECT * FROM x FOR UPDATE', 'COMMIT', 'SET transaction_read_only = off', "COPY x TO '/tmp/x'", 'EXPLAIN ANALYZE SELECT 1', 'SELECT FROM'])('rejects %s', async sql => {
  await expect(validateQuery(sql)).rejects.toThrow();
});
it.each([
  'SELECT 1; /* hidden */ COMMIT',
  'WITH x AS (UPDATE t SET n = 1 RETURNING *) SELECT * FROM x',
  'SELECT * FROM (SELECT * FROM t FOR SHARE) x',
  "SELECT pg_catalog.set_config('transaction_read_only', 'off', false)",
  "SELECT pg_catalog.\"set_config\"('statement_timeout', '0', false)",
  'SELECT pg_advisory_lock(1)', 'SELECT pg_try_advisory_lock(1)',
  "SELECT pg_notify('channel', 'payload')", "SELECT lo_export(1, '/tmp/file')",
  "SELECT dblink_exec('connection', 'DELETE FROM t')", 'SELECT pg_terminate_backend(1)',
  "SELECT nextval('sequence')",
])('blocks transaction and known function side effects: %s', async sql => {
  await expect(validateQuery(sql)).rejects.toThrow();
});
it('does not mistake comments and string literals for executable functions', async () => {
  await expect(validateQuery("SELECT 'set_config(' AS value /* pg_advisory_lock(1) */")).resolves.toBeUndefined();
});
const dir = await mkdtemp(join(tmpdir(), 'pg-mcp-test-'));
afterAll(() => rm(dir, { recursive: true, force: true }));
it('validates configuration and hides malformed secrets', async () => {
  const file = join(dir, 'profiles.yaml');
  await writeFile(file, 'profiles:\n  local:\n    port: 5432\n    database: app\n    user: reader\n    password: secret-canary\n');
  await chmod(file, 0o644);
  await expect(loadProfiles(file)).rejects.toThrow('permissions');
  await chmod(file, 0o600);
  expect((await loadProfiles(file)).local.host).toBe('127.0.0.1');
  await writeFile(file, 'password: [secret-canary');
  await expect(loadProfiles(file)).rejects.not.toThrow('secret-canary');
});
it('gives safe migration guidance for encryption-only TLS', async () => {
  const file = join(dir, 'require.yaml');
  await writeFile(file, 'profiles:\n  local:\n    sslmode: require\n    password: secret-canary\n');
  await expect(loadProfiles(file)).rejects.toThrow('Unsupported TLS mode require');
  await expect(loadProfiles(file)).rejects.not.toThrow('secret-canary');
});
it('exposes only safe profile metadata over MCP', async () => {
  const server = createServer({ local: { port: 5432, host: 'secret-host', database: 'app', user: 'reader', password: 'secret-canary', sslmode: 'disable' } });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    expect((await client.listTools()).tools).toHaveLength(5);
    const result = await client.callTool({ name: 'list_profiles', arguments: {} });
    expect(JSON.stringify(result)).toContain('local');
    expect(JSON.stringify(result)).not.toContain('secret');
  } finally { await client.close(); await server.close(); }
});

describe.skipIf(!process.env.TEST_PG_PORT)('PostgreSQL integration', () => {
  const db = new Database({ test: { host: '127.0.0.1', port: Number(process.env.TEST_PG_PORT), database: 'postgres', user: 'postgres', password: 'test-only', sslmode: 'disable' } });
  it('binds parameters and enforces read-only even with an elevated test role', async () => {
    expect((await db.query('test', 'SELECT $1::text AS value', ['hello'])).rows).toEqual([{ value: 'hello' }]);
    expect((await db.query('test', "SELECT current_setting('transaction_read_only') AS value")).rows).toEqual([{ value: 'on' }]);
    await expect(db.query('test', "SELECT nextval('test_sequence')")).rejects.toThrow('side-effect');
    // This helper exists only in the disposable test database and bypasses the
    // syntactic function denylist, exercising PostgreSQL's transaction boundary.
    await expect(db.query('test', 'SELECT test_sequence_write()')).rejects.toThrow('25006');
  });
  it('truncates rows and bytes and leaves subsequent queries usable', async () => {
    const result = await db.query('test', 'SELECT generate_series(1, 100) AS n', [], 3);
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(true);
    const large = await db.query('test', "SELECT repeat('a', 1000001) AS value");
    expect(large.truncated).toBe(true);
    expect(large.rows).toHaveLength(0);
    expect((await db.query('test', 'SELECT 1')).rowCount).toBe(1);
  });
  it('redacts errors and rejects writes and unknown profiles', async () => {
    await expect(db.query('test', "SELECT 'secret-canary'::integer")).rejects.toThrow('22P02');
    await expect(db.query('test', 'CREATE TABLE bad (id int)')).rejects.toThrow();
    await expect(db.query('__proto__', 'SELECT 1')).rejects.toThrow('Unknown profile');
  });
  it('times out slow queries', async () => {
    await expect(db.query('test', 'SELECT count(*) FROM generate_series(1, 1000000000)')).rejects.toThrow('57014');
  }, 20000);
});
