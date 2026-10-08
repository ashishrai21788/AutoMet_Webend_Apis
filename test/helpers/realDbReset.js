/**
 * Resets a REAL Postgres database for a test run, safely: it drops only tables that AutoMet's own models and raw
 * collections create, and REFUSES (changes nothing) if the public schema contains any other table, so it can never
 * touch another application's data.
 */
// collections reached without a model of their own, and the open generic collections (/api/:collectionName)
const KNOWN_RAW = ['driver_notification', 'users_notification', 'driver_faq', 'driver_faqs', 'driver_issues', 'drivers_notification', 'user_app_analytics', 'driver_app_analytics'];

async function resetOwnTables(query, ownTables) {
  // case-insensitive: Mongo collection names are case-sensitive, and the generic routes create 'Driver_Faqs' as a separate collection
  const allowed = new Set([...ownTables, ...KNOWN_RAW].map((t) => t.toLowerCase()));
  const { rows } = await query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
  const foreign = rows.map((r) => r.table_name).filter((t) => !allowed.has(t.toLowerCase()) && !t.startsWith('pg_'));
  if (foreign.length) {
    throw new Error('Refusing to reset: the database has tables that are not AutoMet test tables (' + foreign.slice(0, 5).join(', ') + '). Nothing was changed.');
  }
  for (const r of rows) await query('drop table if exists "' + r.table_name.replace(/"/g, '""') + '" cascade');
}

module.exports = { resetOwnTables };
