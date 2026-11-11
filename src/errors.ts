export class SafeError extends Error {}

const hints: Record<string, string> = {
  ECONNREFUSED: 'Connection refused. Check that PostgreSQL or the local port-forward is running on the configured host and port.',
  ENOTFOUND: 'Database hostname could not be resolved. Check the profile host.',
  EAI_AGAIN: 'Database hostname lookup temporarily failed. Retry or check DNS.',
  ETIMEDOUT: 'Connection timed out. Check the port-forward, network, and firewall.',
  ECONNRESET: 'Connection was reset. Check the database and port-forward, then reconnect.',
  EHOSTUNREACH: 'Database host is unreachable. Check the network or tunnel.',
  ENETUNREACH: 'Database network is unreachable. Check the network or tunnel.',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate hostname mismatch. Check ssl_servername in the profile.',
  CERT_HAS_EXPIRED: 'TLS certificate has expired. Ask the database administrator to renew it.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed. Configure a trusted CA using ssl_ca_file.',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate chain is not trusted. Check ssl_ca_file.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified. Check ssl_ca_file and the server certificate chain.',
  '28P01': 'Password authentication failed. Check the profile user and password; reconnect the MCP after changing credentials.',
  '28000': 'Database authorization failed. Check the role and server authentication rules.',
  '3D000': 'Configured database does not exist. Check the profile database name.',
  '42501': 'Insufficient privileges. Check CONNECT, schema USAGE, and table SELECT grants for the profile user.',
  '42P01': 'Table or view does not exist. Check the schema and table name.',
  '42703': 'Column does not exist. Check the table definition.',
  '25006': 'Operation is not permitted in a read-only transaction.',
  '57014': 'Query was cancelled or exceeded the statement timeout. Narrow the query and retry.',
  '55P03': 'Lock could not be acquired within the timeout. Retry later.',
  '53300': 'Database has too many connections. Retry later.',
  '57P03': 'Database is not ready to accept connections. Retry later.',
};

export function databaseError(error: unknown, stage: 'connect' | 'query', timedOut = false): Error {
  if (timedOut) return new SafeError('Query exceeded the 15-second client deadline. Narrow the query and retry.');
  if (error instanceof SafeError) return error;
  // Never forward driver messages/details: they may contain credentials or query data.
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && Object.hasOwn(hints, code)) {
    return new SafeError(`${hints[code]} (${code})`);
  }
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    return new SafeError(`Database operation failed (SQLSTATE ${code}).`);
  }
  return new SafeError(stage === 'connect'
    ? 'Database connection failed. Check the port-forward, host/port, credentials, and TLS settings. Reconnect the MCP after profile or environment changes.'
    : 'Database query failed. Check the SELECT query and database availability.');
}
