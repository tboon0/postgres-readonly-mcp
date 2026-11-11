import { parse } from 'pgsql-parser';
import { SafeError } from './errors.js';

// Defense in depth only: views, operators, casts and user functions can also
// execute code. Restrict EXECUTE and other capabilities on the database role.
const unsafeFunctions = /^(?:set_config|nextval|setval|pg_(?:advisory_.*|try_advisory_.*|sleep.*|notify|cancel_backend|terminate_backend|reload_conf|rotate_logfile|log_backend_memory_contexts|read_file|read_binary_file|ls_.*|stat_file|write_file|file_.*|logical_.*|create_.*|drop_.*|replication_.*|switch_.*|promote|backup_.*|start_backup|stop_backup)|lo_(?:import|export|create|creat|unlink|put|from_bytea|open|write|truncate.*)|lowrite|dblink.*)$/i;

export async function validateQuery(sql: string): Promise<void> {
  if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql) > 100_000) throw new SafeError('Query must be 1–100000 bytes.');
  let tree;
  try { tree = await parse(sql); } catch { throw new SafeError('Invalid PostgreSQL query.'); }
  const statement = tree.stmts?.[0]?.stmt;
  if (tree.stmts?.length !== 1 || !statement || !('SelectStmt' in statement)) {
    throw new SafeError('Only a single SELECT query is allowed.');
  }
  const pending: unknown[] = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      if ((key.endsWith('Stmt') && key !== 'SelectStmt') || key === 'intoClause' || key === 'lockingClause') {
        throw new SafeError('Writes, SELECT INTO, and row locks are not allowed.');
      }
      if (key === 'FuncCall') {
        const names = (value as { funcname?: { String?: { sval?: string } }[] }).funcname;
        const name = names?.at(-1)?.String?.sval;
        if (name && unsafeFunctions.test(name)) throw new SafeError('Session-changing or side-effect functions are not allowed.');
      }
      pending.push(value);
    }
  }
}
