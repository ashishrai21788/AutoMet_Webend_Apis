/**
 * The object the backend receives as "mongoose" when DB_ENGINE=postgres: the same surface (Schema, Types, model, models,
 * connect, connection ...) over Postgres. See docs/POSTGRES_ENGINE.md.
 */
const realMongoose = require('mongoose');
const clientModule = require('./client');
const { factory } = require('./model');
const { collection } = require('./plain');

// a private Mongoose instance that is never connected: it supplies schema behaviour (casting, defaults, validation) only
const internal = new realMongoose.Mongoose();
internal.set('bufferCommands', false);
const { register } = factory(internal);

const handlers = {};
const connection = {
  readyState: 0, // 0 disconnected, 1 connected: the health checks read this
  name: 'postgres',
  // the raw-collection interface: connection.db.collection(name) and connection.collection(name)
  db: { collection },
  collection,
  host: '',
  on(event, fn) { (handlers[event] = handlers[event] || []).push(fn); return connection; },
  once(event, fn) { return connection.on(event, fn); },
  emit(event, ...args) { for (const fn of handlers[event] || []) fn(...args); },
  async close() { await clientModule.close(); connection.readyState = 0; connection.emit('disconnected'); }
};

const registered = [];

async function connect(url) {
  const c = clientModule.connect(url || process.env.DATABASE_URL);
  await c.query('SELECT 1');
  for (const r of registered) await r.ensure();
  connection.readyState = 1;
  connection.emit('connected');
  return facade;
}

const facade = {
  Schema: realMongoose.Schema,
  Types: realMongoose.Types,
  SchemaTypes: realMongoose.SchemaTypes,
  isValidObjectId: realMongoose.isValidObjectId,
  models: internal.models,
  connection,
  set: () => facade,
  model(name, schema, collection) {
    if (schema === undefined) {
      if (!internal.models[name]) throw new Error(`Schema hasn't been registered for model "${name}".`);
      return internal.models[name];
    }
    const r = register(name, schema, collection);
    registered.push(r);
    return r.Model;
  },
  connect,
  disconnect: () => connection.close()
};

module.exports = facade;
