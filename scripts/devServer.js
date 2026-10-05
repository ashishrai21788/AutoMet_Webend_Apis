/**
 * LOCAL DEVELOPMENT ONLY. Runs the real /api/admin routes against an in-memory stand-in for MongoDB, so the admin
 * dashboard can be developed and tested without a database. Nothing is persisted: restarting loses everything.
 *
 *   npm run dev:fake            (port 3000, or PORT)
 *
 * Seeds one super admin with the demo credentials below (test values for local use; they do not exist anywhere real).
 * The rider and driver APIs are NOT served by this script.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('scripts/devServer.js uses a fake in-memory database and must never run in production.');
  process.exit(1);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-dev-only-secret';
process.env.REQUIRE_PLATFORM_2FA = process.env.REQUIRE_PLATFORM_2FA || '0'; // set to 1 to try the platform owner's two-step setup locally
process.env.ADMIN_DASHBOARD_URL = process.env.ADMIN_DASHBOARD_URL || 'http://localhost:5173'; // reset links open the local dashboard

const express = require('express');
const bcrypt = require('bcryptjs');
const { createFakeDb } = require('../test/helpers/fakeDb');
const { createMemoryStorage } = require('../test/helpers/memoryStorage');
const privateStorage = require('../lib/privateStorage');

const db = createFakeDb();
db.install();

const PORT = Number(process.env.PORT) || 3000;
// Uploaded documents live in memory and are served only through signed, expiring links, like the real storage.
const storage = createMemoryStorage({ baseUrl: `http://localhost:${PORT}/dev-files` });
privateStorage.setBackend(storage);
const images = require('../lib/publicImages');
const logoStore = images.createMemoryImages({ baseUrl: `http://localhost:${PORT}/dev-files` });
images.setBackend(logoStore);
// No real email locally: messages are printed here (so the reset link can be opened), and never leave this machine.
require('../lib/mailer').setTransport({ async send({ to, subject, text }) { console.log(`
[dev mail] to ${to}: ${subject}
${text}
`); } });

const DEMO_EMAIL = 'super@automet.test';
const DEMO_PASSWORD = 'Super-Demo-123';

(async () => {
  await db.AdminUser.create({
    adminId: 'a_demo_super', name: 'Platform Owner', email: DEMO_EMAIL, role: 'super_admin', tenantId: null,
    passwordHash: bcrypt.hashSync(DEMO_PASSWORD, 10)
  });

  let demo = null;
  if (process.env.DEMO_DATA === '1') {
    const { seedDemo, startDemoMovement, DEMO_ADMIN } = require('./devSeed');
    await seedDemo(db);
    startDemoMovement(db);
    demo = DEMO_ADMIN;
  }

  const app = express();
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-App-Id');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Expose-Headers', 'Content-Disposition, X-Row-Count, X-Truncated, Retry-After');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json());
  app.get('/dev-files/logo/:id', (req, res) => {
    const bytes = logoStore.read(req.params.id);
    if (!bytes) return res.sendStatus(404);
    const png = bytes.slice(0, 4).toString('hex') === '89504e47';
    res.set('Content-Type', png ? 'image/png' : 'image/jpeg').send(bytes);
  });
  app.get('/dev-files/files', (req, res) => {
    const hit = storage.read(`http://localhost:${PORT}${req.originalUrl}`);
    if (hit.status !== 200) return res.sendStatus(hit.status);
    res.set('Content-Type', hit.mime).send(hit.buffer);
  });
  app.use('/api/admin', require('../routes/adminRoutes'));

  const port = PORT;
  app.listen(port, () => {
    console.log('==============================================================');
    console.log(' FAKE IN-MEMORY DATABASE: nothing is saved, for local use only');
    console.log(` Admin API: http://localhost:${port}/api/admin`);
    console.log(` Demo super admin: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    if (demo) console.log(` Demo business admin: ${demo.email} / ${demo.password} (Demo Rides, with sample drivers, riders and trips)`);
    console.log('==============================================================');
  });
})();
