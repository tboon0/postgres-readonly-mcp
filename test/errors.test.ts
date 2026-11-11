import { expect, it } from 'vitest';
import { databaseError } from '../src/errors.js';
import { Database } from '../src/database.js';
import { connectionConfig, type Profile } from '../src/config.js';
import { createServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const profile: Profile = {
  host: '127.0.0.1', port: 5432, database: 'app', user: 'reader',
  password_env: 'POSTGRES_MCP_TEST_UNSET_PASSWORD_93721', sslmode: 'disable',
};

it.each([
  ['ECONNREFUSED', 'Connection refused'],
  ['ENOTFOUND', 'hostname could not be resolved'],
  ['ETIMEDOUT', 'Connection timed out'],
  ['28P01', 'Password authentication failed'],
  ['42501', 'Insufficient privileges'],
  ['3D000', 'database does not exist'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'hostname mismatch'],
  ['57014', 'statement timeout'],
  ['22P02', 'SQLSTATE 22P02'],
])('provides safe guidance for %s', (code, hint) => {
  const result = databaseError({ code, message: 'secret-canary', detail: 'secret-canary' }, 'connect');
  expect(result.message).toContain(hint);
  expect(result.message).not.toContain('secret-canary');
});

it('redacts unknown errors and distinguishes phases and client deadline', () => {
  for (const error of [null, new Error('secret-canary'), { code: 'secret-canary' }, { code: 'constructor' }]) {
    expect(databaseError(error, 'connect').message).toContain('Database connection failed');
    expect(databaseError(error, 'query').message).toContain('Database query failed');
    expect(databaseError(error, 'query', true).message).toContain('15-second client deadline');
  }
});

it('preserves validation feedback before attempting a connection', async () => {
  const db = new Database({ test: profile });
  await expect(db.query('test', 'DELETE FROM users')).rejects.toThrow('Only a single SELECT');
});

it('redacts unreadable TLS CA paths', async () => {
  await expect(connectionConfig({ ...profile, password: 'secret-canary', sslmode: 'verify-full',
    ssl_ca_file: '/nonexistent/secret-canary/ca.pem',
  })).rejects.toThrow('Cannot read TLS CA file');
});

it('returns actionable missing-password feedback over MCP without secrets', async () => {
  expect(process.env[profile.password_env!]).toBeUndefined();
  const server = createServer({ test: profile });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({ name: 'list_tables', arguments: { profile: 'test' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Set the configured password_env variable');
    expect(JSON.stringify(result)).not.toContain(profile.password_env);
  } finally { await client.close(); await server.close(); }
});
