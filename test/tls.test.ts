import { expect, it } from 'vitest';
import { connectionConfig, type Profile } from '../src/config.js';
import type { PeerCertificate } from 'node:tls';

const profile: Profile = { host: '127.0.0.1', port: 5432, database: 'test', user: 'reader', password: 'secret', sslmode: 'verify-full' };
it('requires certificate verification even for IP hosts', async () => {
  const { ssl } = await connectionConfig(profile);
  if (!ssl) throw new Error('TLS missing');
  expect(ssl.rejectUnauthorized).toBe(true);
  expect(ssl.checkServerIdentity('ignored', { subjectaltname: 'IP Address:127.0.0.1' } as PeerCertificate)).toBeUndefined();
  expect(ssl.checkServerIdentity('ignored', { subjectaltname: 'DNS:localhost' } as PeerCertificate)?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
});
it('authenticates the configured tunnel server name rather than the local address', async () => {
  const { ssl } = await connectionConfig({ ...profile, ssl_servername: 'db.example.com' });
  if (!ssl) throw new Error('TLS missing');
  expect(ssl.servername).toBe('db.example.com');
  expect(ssl.checkServerIdentity('127.0.0.1', { subjectaltname: 'DNS:db.example.com' } as PeerCertificate)).toBeUndefined();
  expect(ssl.checkServerIdentity('127.0.0.1', { subjectaltname: 'IP Address:127.0.0.1' } as PeerCertificate)).toBeInstanceOf(Error);
});
it('rejects encryption-only TLS modes and socket TLS bypasses', async () => {
  await expect(connectionConfig({ ...profile, sslmode: 'require' } as unknown as Profile)).rejects.toThrow('Unsupported TLS mode');
  await expect(connectionConfig({ ...profile, host: '/var/run/postgresql' })).rejects.toThrow('TCP host');
  expect((await connectionConfig({ ...profile, sslmode: 'disable' })).ssl).toBe(false);
});
