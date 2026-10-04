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

const express = require('express');
const bcrypt = require('bcryptjs');
const { createFakeDb } = require('../test/helpers/fakeDb');

const db = createFakeDb();
db.install();

const DEMO_EMAIL = 'super@automet.test';
const DEMO_PASSWORD = 'Super-Demo-123';

(async () => {
  await db.AdminUser.create({
    adminId: 'a_demo_super', name: 'Platform Owner', email: DEMO_EMAIL, role: 'super_admin', tenantId: null,
    passwordHash: bcrypt.hashSync(DEMO_PASSWORD, 10)
  });

  const app = express();
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-App-Id');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json());
  app.use('/api/admin', require('../routes/adminRoutes'));

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log('==============================================================');
    console.log(' FAKE IN-MEMORY DATABASE: nothing is saved, for local use only');
    console.log(` Admin API: http://localhost:${port}/api/admin`);
    console.log(` Demo super admin: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    console.log('==============================================================');
  });
})();
