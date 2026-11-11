#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadProfiles } from './config.js';
import { createServer } from './server.js';

try {
  const { values } = parseArgs({ options: { profiles: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('postgres-readonly-mcp [--profiles /path/to/profiles.yaml]\nDefault: POSTGRES_READONLY_PROFILES or ~/.postgres-readonly/profiles.yaml');
  } else {
    const path = values.profiles ?? process.env.POSTGRES_READONLY_PROFILES ?? join(homedir(), '.postgres-readonly', 'profiles.yaml');
    const server = createServer(await loadProfiles(path));
    await server.connect(new StdioServerTransport());
    const shutdown = async () => { await server.close(); process.exit(0); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
} catch {
  console.error('Unable to start postgres-readonly-mcp. Check arguments, profile configuration, and file permissions.');
  process.exitCode = 1;
}
