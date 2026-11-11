import pg from 'pg';
import QueryStream from 'pg-query-stream';
import { connectionConfig, type Profiles } from './config.js';
import { validateQuery } from './sql.js';
import { databaseError, SafeError } from './errors.js';

export const MAX_ROWS = 1000;
export const MAX_BYTES = 1_000_000;
export const MAX_PARAM_BYTES = 100_000;
export class Database {
  private active = 0;
  constructor(private readonly profiles: Profiles) {}

  listProfiles() {
    return Object.entries(this.profiles).map(([name, p]) => ({ name, description: p.description }));
  }

  async query(profile: string, sql: string, values: unknown[] = [], maxRows = MAX_ROWS) {
    const config = Object.hasOwn(this.profiles, profile) ? this.profiles[profile] : undefined;
    if (!config) throw new SafeError('Unknown profile.');
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) throw new SafeError('Invalid row limit.');
    if (!Array.isArray(values) || values.length > 100 || values.some(value =>
      value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))) ||
      Buffer.byteLength(JSON.stringify(values)) > MAX_PARAM_BYTES) {
      throw new SafeError('Parameters must be at most 100 scalar values and 100000 encoded bytes.');
    }
    if (this.active >= 4) throw new SafeError('Server busy; retry later.');
    // Reserve before asynchronous parsing so pending validations are bounded too.
    this.active++;
    let client: pg.Client | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let timedOut = false;
    let stage: 'connect' | 'query' = 'connect';
    try {
      await validateQuery(sql);
      client = new pg.Client(await connectionConfig(config));
      // Idle connection errors must not crash the stdio server.
      client.on('error', () => {});
      await client.connect();
      stage = 'query';
      deadline = setTimeout(() => {
        timedOut = true;
        void client!.end().catch(() => {});
      }, 15_000);
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL search_path = pg_catalog, public");
      const stream = client.query(new QueryStream(sql, values, { batchSize: 1 }));
      const rows: Record<string, unknown>[] = [];
      let bytes = 2;
      let truncated = false;
      for await (const row of stream) {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (rows.length >= maxRows || bytes + size > MAX_BYTES) {
          truncated = true;
          break;
        }
        rows.push(row);
        bytes += size;
      }
      if (timedOut) throw new Error('Query deadline exceeded.');
      return { rows, rowCount: rows.length, truncated };
    } catch (error) {
      throw databaseError(error, stage, timedOut);
    } finally {
      // Disconnect rolls back the transaction and releases session locks. Do not
      // queue ROLLBACK behind a potentially stuck query during deadline cleanup.
      if (client) await client.end().catch(() => {});
      if (deadline) clearTimeout(deadline);
      this.active--;
    }
  }
}
