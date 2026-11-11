import { beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';

const mock = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn(), configs: [] as unknown[] }));
vi.mock('pg', () => ({ default: { Client: class {
  constructor(config: unknown) { mock.configs.push(config); }
  on() {}
  connect = mock.connect;
  query = mock.query;
  end = mock.end;
} } }));
import { Database, MAX_BYTES } from '../src/database.js';

const profile = { host: 'localhost', port: 5432, database: 'test', user: 'reader', password: 'secret-canary', sslmode: 'disable' as const };
const db = () => new Database({ test: profile });
beforeEach(() => {
  vi.resetAllMocks();
  mock.configs.length = 0;
  mock.connect.mockResolvedValue(undefined);
  mock.end.mockResolvedValue(undefined);
  mock.query.mockImplementation((sql: unknown) => typeof sql === 'string' ? Promise.resolve({}) : Readable.from([{ n: 1 }, { n: 2 }]));
});

it('starts read-only before user SQL, caps rows and disconnects without reusing a session', async () => {
  const result = await db().query('test', 'SELECT 1', [], 1);
  expect(result).toEqual({ rows: [{ n: 1 }], rowCount: 1, truncated: true });
  expect(mock.query.mock.calls[0]).toEqual(['BEGIN READ ONLY']);
  expect(mock.query.mock.calls[1]).toEqual(['SET LOCAL search_path = pg_catalog, public']);
  expect(mock.end).toHaveBeenCalledOnce();
  expect(mock.query).not.toHaveBeenCalledWith('ROLLBACK');
});
it('caps encoded result bytes', async () => {
  mock.query.mockImplementation((sql: unknown) => typeof sql === 'string' ? Promise.resolve({}) : Readable.from([{ value: 'x'.repeat(MAX_BYTES) }]));
  expect(await db().query('test', 'SELECT 1')).toEqual({ rows: [], rowCount: 0, truncated: true });
});
it.each([[{}], [Infinity], [undefined], ['x'.repeat(100_001)], Array(101).fill(1)])('rejects invalid or excessive parameters without connecting: %j', async (...values) => {
  await expect(db().query('test', 'SELECT $1', values)).rejects.toThrow('Parameters');
  expect(mock.connect).not.toHaveBeenCalled();
});
it('bounds pending requests before parsing and releases capacity after errors', async () => {
  const database = db();
  const queries = Array.from({ length: 4 }, () => database.query('test', 'DELETE FROM t'));
  await expect(database.query('test', 'SELECT 1')).rejects.toThrow('Server busy');
  await Promise.all(queries.map(query => expect(query).rejects.toThrow('single SELECT')));
  expect((await database.query('test', 'SELECT 1')).rowCount).toBe(2);
});
it('redacts driver failures and closes failed connections', async () => {
  mock.connect.mockRejectedValue(new Error('secret-canary'));
  await expect(db().query('test', 'SELECT 1')).rejects.not.toThrow('secret-canary');
  expect(mock.end).toHaveBeenCalledOnce();
});
it('disconnects on client deadline even if a function defeats server timeouts', async () => {
  vi.useFakeTimers();
  try {
    const stream = new Readable({ objectMode: true, read() {} });
    mock.query.mockImplementation((sql: unknown) => typeof sql === 'string' ? Promise.resolve({}) : stream);
    mock.end.mockImplementation(async () => { stream.destroy(new Error('secret-canary')); });
    const query = db().query('test', 'SELECT custom_function()');
    const assertion = expect(query).rejects.toThrow('15-second client deadline');
    await vi.waitFor(() => expect(mock.query).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(mock.end).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
