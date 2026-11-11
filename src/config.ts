import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { parse } from 'yaml';
import { SafeError } from './errors.js';
import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';

const profileSchema = z.object({
  description: z.string().max(300).optional(),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1).optional(),
  password_env: z.string().min(1).optional(),
  sslmode: z.enum(['disable', 'verify-full']).default('verify-full'),
  ssl_ca_file: z.string().optional(),
  ssl_servername: z.string().optional(),
}).strict().refine(p => Boolean(p.password) !== Boolean(p.password_env), {
  message: 'Specify exactly one of password or password_env',
});
const configSchema = z.object({
  profiles: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), profileSchema),
}).strict();
export type Profile = z.infer<typeof profileSchema>;
export type Profiles = Record<string, Profile>;

export async function loadProfiles(path: string): Promise<Profiles> {
  try {
    const raw: unknown = parse(await readFile(path, 'utf8'));
    if (raw && typeof raw === 'object' && 'profiles' in raw && raw.profiles && typeof raw.profiles === 'object' &&
      Object.values(raw.profiles).some(p => p && typeof p === 'object' && 'sslmode' in p && p.sslmode === 'require')) {
      throw new SafeError('Unsupported TLS mode require. Use verify-full with a trusted CA; require does not authenticate the server.');
    }
    const config = configSchema.parse(raw);
    if (!Object.keys(config.profiles).length) throw new Error();
    if (Object.values(config.profiles).some(p => p.password)) {
      const metadata = await stat(path);
      if (process.platform !== 'win32' && (metadata.mode & 0o077)) throw new Error();
    }
    return config.profiles;
  } catch (error) {
    if (error instanceof SafeError) throw error;
    // YAML and validation errors can contain credentials; never forward them.
    throw new Error('Cannot load profiles: check file, schema, and permissions (0600 for inline passwords).');
  }
}

export async function connectionConfig(profile: Profile) {
  if (profile.sslmode !== 'disable' && profile.sslmode !== 'verify-full') {
    throw new SafeError('Unsupported TLS mode. Use verify-full with a trusted CA; require does not authenticate the server.');
  }
  if (profile.sslmode !== 'disable' && profile.host.startsWith('/')) {
    throw new SafeError('TLS requires a TCP host, not a Unix socket path.');
  }
  const tlsHost = profile.ssl_servername || profile.host;
  const password = profile.password ?? process.env[profile.password_env!];
  if (!password) throw new SafeError('Profile password is unavailable. Set the configured password_env variable in the MCP process environment, then restart the MCP.');
  let ca: string | undefined;
  if (profile.sslmode !== 'disable' && profile.ssl_ca_file) {
    try { ca = await readFile(profile.ssl_ca_file, 'utf8'); }
    catch { throw new SafeError('Cannot read TLS CA file. Check ssl_ca_file and its file permissions.'); }
  }
  return {
    host: profile.host, port: profile.port, database: profile.database,
    user: profile.user, password,
    ssl: profile.sslmode === 'disable' ? false : {
      rejectUnauthorized: true,
      // Verify IP addresses too, even when TLS cannot send an SNI name.
      checkServerIdentity: (_hostname: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(tlsHost, cert),
      ...(ca !== undefined ? { ca } : {}),
      ...(!isIP(tlsHost) ? { servername: tlsHost } : {}),
    },
    connectionTimeoutMillis: 5000,
    application_name: 'postgres-readonly-mcp',
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=15000',
  };
}
