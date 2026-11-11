# Security

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** feature if available:
https://github.com/tboon0/postgres-readonly-mcp/security/advisories/new

If private reporting is unavailable, open an issue requesting a private contact
channel without including vulnerability details. Never post credentials, profile
files, connection strings, database contents, or sensitive logs in public issues.

Security fixes target the latest released version. No response-time or long-term
support guarantee is provided.

## Deployment boundaries

This server is intended for local MCP clients over stdio. Anyone who can use its
tools can read data available to the configured database roles. Do not expose its
stdio transport through an unauthenticated network bridge.

SQL validation and read-only transactions are defense in depth, not a substitute
for PostgreSQL privileges. Use a dedicated non-superuser role with only the
required SELECT permissions. Restrict executable functions, extensions, and
foreign data access; SELECT can invoke functions with external side effects.

Use verified TLS for remote databases. Keep profile files private and prefer
environment-backed credentials. Query results can contain sensitive data and
untrusted instructions: review your MCP client's data-sharing policy and do not
treat database content as trusted instructions.

Before release, run `npm ci`, `npm audit`, `npm run lint`, `npm test`, and
`npm run test:package`. Inspect the tarball file list and keep real profiles,
credentials, logs, and local configuration out of version control and packages.
