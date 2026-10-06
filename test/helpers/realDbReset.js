/**
 * Resets a REAL Postgres database for a test run, safely: it drops only tables that AutoMet's own models and raw
 * collections create, and REFUSES (changes nothing) if the public schema contains any other table, so it can never
 * touch another application's data.
 */
const KNOWN_RAW = ['driver_notification', 'users_notification', 'driver_faq', 'drivers_notification', 'user_app_analytics', 'driver_app_analytics'];

async function resetOwnTables(query, ownTables) {
  const allowed = new Set([...ownTables, ...KNOWN_RAW]);
  const { rows } = await query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
  const foreign = rows.map((r) => r.table_name).filter((t) => !allowed.has(t) && !t.startsWith('pg_'));
  if (foreign.length) {
    throw new Error('Refusing to reset: the database has tables that are not AutoMet test tables (' + foreign.slice(0, 5).join(', ') + '). Nothing was changed.');
  }
  for (const r of rows) await query('drop table if exists "' + r.table_name.replace(/"/g, '""') + '" cascade');
}

module.exports = { resetOwnTables };
