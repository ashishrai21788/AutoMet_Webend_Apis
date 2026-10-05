/**
 * One small interface over two Postgres drivers, so the model layer is written once:
 *
 *   - `pg` (a connection pool) for a real server, e.g. Supabase used as plain hosted Postgres (DATABASE_URL);
 *   - PGlite (Postgres compiled to WebAssembly, in-process) when DATABASE_URL is `pglite:memory` or `pglite:<folder>`,
 *     used by the tests so they need no external service.
 *
 * Interface: query(text, params) -> { rows, rowCount }; transaction(fn) where fn receives { query }; end().
 */
let instance = null;

function pgClient(connectionString) {
  const { Pool, types } = require('pg');
  // keep timestamps as Date objects and numeric/int8 as numbers (the model layer expects plain JS values)
  types.setTypeParser(20, (v) => Number(v));
  types.setTypeParser(1700, (v) => Number(v));
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX) || 10,
    ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false }
  });
  pool.on('error', (e) => console.error('[postgres] idle client error:', e.message));
  return {
    kind: 'pg',
    query: (text, params) => pool.query(text, params).then((r) => ({ rows: r.rows, rowCount: r.rowCount })),
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn({ query: (t, p) => c.query(t, p).then((r) => ({ rows: r.rows, rowCount: r.rowCount })) });
        await c.query('COMMIT');
        return out;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) { /* the original error is the useful one */ }
        throw e;
      } finally {
        c.release();
      }
    },
    end: () => pool.end()
  };
}

function pgliteClient(spec) {
  const { PGlite } = require('@electric-sql/pglite');
  const dir = spec.replace(/^pglite:/, '');
  const db = new PGlite(dir && dir !== 'memory' ? dir : undefined);
  const wrap = (r) => ({ rows: r.rows, rowCount: r.affectedRows !== undefined ? r.affectedRows : r.rows.length });
  // PGlite runs one statement at a time; a transaction holds the queue so statements of other callers never interleave
  let chain = Promise.resolve();
  const serial = (fn) => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };
  return {
    kind: 'pglite',
    query: (text, params) => serial(() => db.query(text, params)).then(wrap),
    transaction: (fn) => serial(() => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p).then(wrap) }))),
    end: () => serial(() => db.close())
  };
}

function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DB_ENGINE=postgres needs DATABASE_URL (a Postgres connection string, or pglite:memory for tests).');
  if (instance) return instance;
  instance = /^pglite:/.test(url) ? pgliteClient(url) : pgClient(url);
  return instance;
}

const current = () => instance;
async function close() { if (instance) { const i = instance; instance = null; await i.end(); } }

module.exports = { connect, current, close };
