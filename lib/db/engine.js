/**
 * Which database engine this process runs on. Read once, at start-up.
 *
 *   DB_ENGINE=postgres   PostgreSQL (needs DATABASE_URL); standard default. See docs/POSTGRES_ENGINE.md
 *   DB_ENGINE=mongo      MongoDB through Mongoose (legacy fallback)
 *
 * An unknown value stops the server at start-up rather than silently choosing an engine.
 */
const ENGINES = ['postgres', 'mongo'];
const raw = String(process.env.DB_ENGINE || 'postgres').trim().toLowerCase();

if (!ENGINES.includes(raw)) {
  throw new Error(`DB_ENGINE must be one of ${ENGINES.join(', ')} (got "${raw}")`);
}

module.exports = { ENGINE: raw, isMongo: raw === 'mongo', isPostgres: raw === 'postgres', ENGINES };
