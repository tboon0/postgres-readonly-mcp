# postgres-readonly-mcp

A stdio MCP server for PostgreSQL with named YAML profiles, including databases reached through locally forwarded ports. Credentials stay in local configuration or environment variables, not tool arguments/results. Node.js 22+ required.

## Install the MCP server

Requires Node.js 22+. The package name is `@tboon0/postgres-readonly-mcp`; the command below requires that package to have been published to npm:

```sh
npx @tboon0/postgres-readonly-mcp --profiles /absolute/path/to/profiles.yaml
```

Alternatively, build from a source checkout:

```sh
git clone https://github.com/tboon0/postgres-readonly-mcp.git
cd postgres-readonly-mcp
npm ci
npm run build
mkdir -p ~/.postgres-readonly
cp profiles.yaml.example ~/.postgres-readonly/profiles.yaml
chmod 600 ~/.postgres-readonly/profiles.yaml
```

Edit the profiles and export the referenced password variables in the environment used to launch the server. Remove unused example profiles. Start your SSH/Kubernetes tunnel separately; this server does not manage tunnels.

```sh
ssh -N -L 127.0.0.1:15432:database.internal:5432 bastion
# In another terminal, with the password environment variable already set:
node dist/index.js --profiles ~/.postgres-readonly/profiles.yaml
```

The server waits for MCP input on stdin. Protocol output goes to stdout; startup errors go to stderr.

### MCP client configuration

Use your client's equivalent of:

```json
{
  "mcpServers": {
    "postgres_readonly": {
      "command": "node",
      "args": [
        "/absolute/path/to/postgres-readonly-mcp/dist/index.js",
        "--profiles",
        "/absolute/path/to/profiles.yaml"
      ]
    }
  }
}
```

The client process must inherit the password environment variables (GUI clients may not inherit your shell environment). Profile path precedence: `--profiles`, `POSTGRES_READONLY_PROFILES`, then `~/.postgres-readonly/profiles.yaml`.

## Profiles

```yaml
profiles:
  staging:
    description: Staging reporting database
    host: 127.0.0.1
    port: 15432
    database: app
    user: mcp_reader
    password_env: PG_STAGING_READER_PASSWORD
    sslmode: verify-full
    ssl_servername: database.internal
    # ssl_ca_file: /absolute/path/to/root-ca.pem
```

- Profile names contain letters, digits, underscores, or hyphens.
- `port`, `database`, `user`, and exactly one of `password_env` or `password` are required. `host` defaults to `127.0.0.1`.
- Inline passwords require a file with no group/other permissions on POSIX systems (`chmod 600`). Environment references are preferred. Permission enforcement is not available on Windows; use appropriate ACLs.
- `sslmode` defaults to `verify-full`: encryption with certificate verification. `ssl_servername` supplies the certificate hostname when connecting through localhost. Optional `ssl_ca_file` is a PEM CA file (use an absolute path).
- `require` is not supported: encryption without server authentication is unsafe. `disable` explicitly disables PostgreSQL TLS; use only for trusted local development or where a separately authenticated tunnel protects the entire connection path. An SSH tunnel to a bastion does not encrypt the bastion-to-database hop.
- Unknown configuration keys are rejected. There is no connection URL or agent-selectable destination.
- Configuration is loaded at startup. Restart after changes. All profiles are available to the connected MCP client; use separate server configurations when different clients need different access.

Never commit real profiles, passwords, or private keys. The example file is safe to commit. Profile descriptions are exposed to the agent, so do not put secrets in them.

## Install the agent skill (optional)

The [skills.sh CLI](https://github.com/vercel-labs/skills) installs agent instructions, **not** the MCP server, dependencies, profiles, or database permissions. Configure the MCP server above separately. The CLI requires Node.js 22.20+.

From your agent project, install the bundled skill from a local checkout:

```sh
npx skills add /absolute/path/to/postgres-readonly-mcp --skill postgres-readonly
```

Once the repository is publicly available, the equivalent GitHub command is:

```sh
npx skills add tboon0/postgres-readonly-mcp --skill postgres-readonly
```

These commands do not imply that npm publication or a skills.sh directory listing has been verified.

The CLI prompts for target agents and installs to the current project by default; add `-g` for a global install. Inspect available skills without installing with `npx skills add /absolute/path/to/postgres-readonly-mcp --list`, and check installed skills with `npx skills list`.

Ask your agent: “Use postgres-readonly to check the configured profiles and inspect the reporting schema. Do not read application rows.” The skill defaults to metadata tools and requires explicit approval of the target and scope before any data query, including counts or samples. Installing it does not enforce authorization: database privileges remain the security boundary. See [`skills/postgres-readonly/SKILL.md`](skills/postgres-readonly/SKILL.md).

## Tools

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `list_profiles` | none | Names and optional descriptions only |
| `list_schemas` | `profile` | Schemas with USAGE access |
| `list_tables` | `profile`, `schema` (default `public`) | Tables/views with SELECT access |
| `describe_table` | `profile`, `schema`, `table` | Accessible columns, types, constraints, indexes |
| `query` | `profile`, `sql`, optional `params`, `max_rows` | One SELECT/read-only CTE/VALUES statement |

Use `$1`, `$2`, etc. for parameters. Parameter values may be strings, numbers, booleans, or null. Identifiers cannot be bound as values. Query output contains `rows`, `rowCount` (returned rows, not total matches), and `truncated`. Use unique column aliases: duplicate column names overwrite earlier values in object rows. PostgreSQL bigint/numeric values retain the driver's default string representation to avoid precision loss.

Metadata results are also bounded; narrow the schema or use a filtered query when truncated. `describe_table` repeats table constraints/indexes per column. No EXPLAIN tool or write escape hatch is provided.

## Security boundaries

**Use a dedicated least-privileged database role. The SQL parser is not the primary security boundary.** An administrator can adapt the following for a specific database/schema (run manually, not through this MCP):

```sql
CREATE ROLE mcp_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
-- Set the password securely, e.g. with psql's \password mcp_reader.
GRANT CONNECT ON DATABASE app TO mcp_reader;
GRANT USAGE ON SCHEMA reporting TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO mcp_reader;
ALTER ROLE mcp_reader SET default_transaction_read_only = on;
ALTER ROLE mcp_reader SET statement_timeout = '10s';
```

Prefer a curated reporting schema/views or a reporting replica. Grant future-table access only deliberately; the example does not configure default privileges. Do not make the role an object owner or member of write/elevated roles. Audit inherited PUBLIC privileges, schema creation/TEMP privileges, executable functions (especially SECURITY DEFINER), extensions, and row-level security. NOINHERIT alone does not prevent SET ROLE into granted roles.

Defense in depth:

- Real PostgreSQL parser; exactly one SELECT statement. Nested modifying CTEs, SELECT INTO, row locks, transaction/session commands, COPY, and EXPLAIN are rejected before connecting.
- Every operation begins an explicit read-only transaction and rolls back afterward. Fresh connections are closed rather than pooled, preventing session settings or advisory locks from leaking to the next request.
- At most four concurrent validations/database operations; excess calls fail immediately. SQL is limited to 100 KB; parameters to 100 scalar values and 100 KB of JSON-encoded data.
- Known session-changing and side-effect functions are rejected as defense in depth, not as a complete function sandbox.
- Five-second connection timeout, ten-second statement timeout, one-second lock timeout, fifteen-second transaction-idle timeout, and a fifteen-second connection-close deadline after connection establishment.
- Cursor-based fetching with batches of one row; at most 1000 returned rows and approximately 1 MB of serialized row data. Oversized rows are omitted and `truncated` is true.
- Errors provide allowlisted guidance for connection, TLS, authentication, permissions, and timeout failures, with SQLSTATE or recognized network codes where available. Raw PostgreSQL/driver messages, SQL text, details, and credentials are never returned. Missing password environment variables and unreadable CA files receive safe configuration guidance. Startup/config errors are similarly redacted. The server does not log queries.

**Remaining risks:** SELECT can reveal any data the role can read, execute expensive queries, acquire advisory locks, or invoke functions with external effects. Read-only transactions do not sandbox functions or external systems. Functions may alter session timeouts; the client deadline adds a connection-close bound, not a guaranteed server-side cancellation time. Result limits bound returned row data, not PostgreSQL work or peak memory: an individual large field must reach the driver before its size can be checked. Database contents are untrusted data, not instructions. Read-only MCP annotations are hints to clients, not authorization controls.

## Verification

```sh
npm run build
npm run lint
npm test
npm audit
```

Default tests cover SQL validation, configuration redaction/permissions, and MCP tool discovery/profile output. Integration tests are skipped unless `TEST_PG_PORT` is set. They intentionally use an elevated role in a **disposable local database** to verify transaction enforcement independently of role permissions; never point them at production.

```sh
docker run --name postgres-readonly-mcp-test \
  -e POSTGRES_PASSWORD=test-only -p 127.0.0.1:25432:5432 -d postgres:17
# Wait for PostgreSQL to be ready, then:
docker exec postgres-readonly-mcp-test psql -U postgres \
  -c 'CREATE SEQUENCE test_sequence' \
  -c "CREATE FUNCTION test_sequence_write() RETURNS bigint LANGUAGE sql AS \$\$ SELECT nextval('test_sequence'); \$\$;"
TEST_PG_PORT=25432 npm test
docker rm -f -v postgres-readonly-mcp-test
```

Integration tests cover parameter binding, read-only enforcement through a function wrapper that bypasses the SQL denylist, row/byte truncation, subsequent connection usability, rejected writes, unknown profiles, redacted SQL errors, and query timeout. PostgreSQL 17 is tested; the bundled SQL parser uses PostgreSQL 18 grammar, so newer syntax may pass validation but still be rejected by an older database.
