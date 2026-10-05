#!/usr/bin/env node
/**
 * RECOVERY for a locked-out admin (typically the only platform owner): sets a new one-time password for one admin account of
 * the database named in your environment (.env or Render's variables).
 *
 *   node scripts/resetAdminPassword.js --email=owner@yourcompany.com             dry run: shows the account, changes nothing
 *   node scripts/resetAdminPassword.js --email=owner@yourcompany.com --execute   sets and prints a new one-time password
 *   add --disable-2fa  to also turn off two-step verification (lost phone and recovery codes); they set it up again at next sign-in
 *
 * The account is unlocked, every existing session of it is ended, any pending reset link is cancelled, and the person must
 * choose their own password at the next sign-in. The new password is printed once to this terminal and stored nowhere else.
 * The event is written to the audit log (actor "recovery-script"). Run it only from a machine you trust.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const value = (name) => { const a = args.find((x) => x.startsWith(`${name}=`)); return a ? a.slice(name.length + 1) : null; };

function connectionString() {
  const { MONGODB_USERNAME, MONGODB_PASSWORD, MONGODB_CLUSTER, DB_NAME } = process.env;
  if (!MONGODB_USERNAME || !MONGODB_PASSWORD || !MONGODB_CLUSTER || !DB_NAME) {
    throw new Error('MONGODB_USERNAME, MONGODB_PASSWORD, MONGODB_CLUSTER and DB_NAME must be set (in .env or the environment).');
  }
  return `mongodb+srv://${encodeURIComponent(MONGODB_USERNAME)}:${encodeURIComponent(MONGODB_PASSWORD)}@${MONGODB_CLUSTER}/${DB_NAME}?retryWrites=true&w=majority&appName=AshishRai`;
}

function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(15), (b) => alphabet[b % alphabet.length]).join('');
}

async function main() {
  const email = String(value('--email') || '').trim().toLowerCase();
  if (!email) throw new Error('Pass --email=<the admin account email>.');
  await mongoose.connect(connectionString(), { serverSelectionTimeoutMS: 15000 });
  const users = mongoose.connection.db.collection('admin_users');
  const account = await users.findOne({ email });
  if (!account) throw new Error(`No admin account has the email ${email}.`);
  console.log(`\nDatabase: ${process.env.DB_NAME}\nAccount:  ${account.name} <${account.email}>  role: ${account.role}  ${account.active === false ? '(INACTIVE)' : ''}\n`);
  if (!args.includes('--execute')) {
    console.log('Dry run: nothing changed. Add --execute to set a new one-time password.\n');
    return;
  }
  const password = temporaryPassword();
  await users.updateOne({ _id: account._id }, {
    $set: { passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true, failedLogins: 0, lockUntil: null, active: true, resetTokenHash: null, resetTokenExpires: null, ...(args.includes('--disable-2fa') ? { totpEnabled: false, totpSecret: null, totpPending: null, recoveryHashes: [], totpLastStep: -1 } : {}) },
    $inc: { tokenVersion: 1 }
  });
  await mongoose.connection.db.collection('admin_audit_logs').insertOne({
    tenantId: account.tenantId || null, actorId: null, actorEmail: 'recovery-script', action: 'auth.password_recovered', targetType: 'admin_user', targetId: account.adminId, meta: args.includes('--disable-2fa') ? { twoFactorDisabled: true } : null, ip: null, at: new Date()
  });
  console.log(`New one-time password for ${account.email}:\n\n    ${password}\n\nThey must choose their own password at the next sign-in. This is not shown again.\n`);
}

main().catch((e) => { console.error(`\nFailed: ${e.message}\n`); process.exitCode = 1; }).finally(() => mongoose.disconnect());
