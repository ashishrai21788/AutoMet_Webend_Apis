/**
 * Which database engine this process runs on. Read once, at start-up.
 *
 *   DB_ENGINE=mongo      MongoDB through Mongoose, exactly as before (the default)
 *   DB_ENGINE=postgres   PostgreSQL (needs DATABASE_URL); see docs/POSTGRES_ENGINE.md
 *
 * An unknown value stops the server at start-up rather than silently choosing an engine.
 */
const ENGINES = ['mongo', 'postgres'];
const raw = String(process.env.DB_ENGINE || 'mongo').trim().toLowerCase();

if (!ENGINES.includes(raw)) {
  throw new Error(`DB_ENGINE must be one of ${ENGINES.join(', ')} (got "${raw}")`);
}

module.exports = { ENGINE: raw, isMongo: raw === 'mongo', isPostgres: raw === 'postgres', ENGINES };
