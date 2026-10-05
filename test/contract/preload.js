/**
 * Loaded into the TEST server only (node -r), never into production. It makes the contract server unable to touch anything
 * real, even though parts of the backend read the project's .env by absolute path:
 *
 *  - `dotenv` does nothing, so the project's real credentials are never loaded.
 *  - `firebase-admin` is replaced by a recorder: "sending" a push appends the message to CONTRACT_PUSH_LOG instead of
 *    contacting Google, so scenarios can assert exactly what the apps would have been sent.
 */
const Module = require('node:module');
const fs = require('node:fs');

const pushLog = process.env.CONTRACT_PUSH_LOG;
const admin = {
  apps: [],
  credential: { cert: (o) => o, applicationDefault: () => ({}) },
  initializeApp(options) {
    const app = { name: '[DEFAULT]', options };
    admin.apps.push(app);
    return app;
  },
  messaging: () => ({
    async send(message) {
      if (pushLog) fs.appendFileSync(pushLog, `${JSON.stringify(message)}\n`);
      return `projects/contract/messages/fake-${Date.now()}`;
    }
  })
};

const original = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'dotenv') return { config: () => ({ parsed: {} }) };
  if (request === 'firebase-admin') return admin;
  return original.apply(this, arguments);
};
