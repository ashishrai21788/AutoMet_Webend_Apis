/**
 * The one place the backend obtains "mongoose".
 *
 * With DB_ENGINE=mongo (the default) this exports the real mongoose module itself, not a wrapper, so every call behaves
 * exactly as it always has. With DB_ENGINE=postgres it exports a facade with the same surface (Schema, model, models,
 * connection, Types.ObjectId) backed by PostgreSQL. See docs/POSTGRES_ENGINE.md.
 */
const { isPostgres } = require('./engine');

module.exports = isPostgres ? require('./postgres') : require('mongoose');
