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
let pushCount = 0; // message ids are a counter, so replays are deterministic
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
      return `projects/contract/messages/fake-${++pushCount}`;
    }
  })
};

// ---- File storage stand-ins. Names are counters, so a replay gives the same names; nothing leaves this process.
const path = require('node:path');
const crypto = require('node:crypto');
const { createMemoryStorage } = require(path.join(__dirname, '..', 'helpers', 'memoryStorage'));
let imageCount = 0;
const cloudinaryStandIn = {
  v2: {
    config: () => ({}),
    api: { ping: async () => ({ status: 'ok' }) },
    uploader: {
      async upload(file, options = {}) {
        imageCount += 1;
        const folder = options.folder || 'uploads';
        const bytes = require('node:fs').statSync(file).size;
        return { public_id: `${folder}/image-${imageCount}`, secure_url: `https://images.contract.test/${folder}/image-${imageCount}.png`, url: `http://images.contract.test/${folder}/image-${imageCount}.png`, width: 1, height: 1, format: 'png', bytes };
      },
      async destroy(publicId) { return { result: publicId && !String(publicId).includes('missing') ? 'ok' : 'not found' }; },
      upload_stream: () => { throw new Error('not used by the contract server'); }
    }
  }
};
const privateStore = (() => {
  const m = createMemoryStorage({ secret: 'contract-storage-secret', baseUrl: 'https://files.contract.test' });
  let n = 0;
  m.put = async (buffer, { folder, mime }) => { n += 1; const key = `${folder}/file-${n}`; m.files.set(key, { buffer, mime }); return key; };
  return m;
})();

const original = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'dotenv') return { config: () => ({ parsed: {} }) };
  if (request === 'firebase-admin') return admin;
  if (request === 'cloudinary') return cloudinaryStandIn;
  const loaded = original.apply(this, arguments);
  // The billing scheduler runs once, 90 seconds after start-up, and stamps the platform settings' lastRunAt. Whether a scenario
  // reaches that moment depends on how fast the database is, so a scenario's answers would differ between a fast and a slow
  // database. Pushing the first run far out makes the answers independent of speed (no production code is changed).
  if (/billingJobs(.js)?$/.test(request) && loaded && typeof loaded.startBillingScheduler === 'function' && !loaded.__contractPatched) {
    const real = loaded.startBillingScheduler;
    loaded.startBillingScheduler = (opts = {}) => real({ ...opts, firstDelayMs: 6 * 60 * 60 * 1000 });
    loaded.__contractPatched = true;
  }
  // private documents and public logos use in-memory storage in the contract server
  if (/privateStorage(\.js)?$/.test(request) && loaded && typeof loaded.setBackend === 'function' && !loaded.__contractPatched) {
    loaded.setBackend(privateStore);
    loaded.__contractPatched = true;
  }
  if (/publicImages(\.js)?$/.test(request) && loaded && typeof loaded.setBackend === 'function' && !loaded.__contractPatched) {
    loaded.setBackend(loaded.createMemoryImages({ baseUrl: 'https://images.contract.test' }));
    loaded.__contractPatched = true;
  }
  return loaded;
};
