// The double-entry ledger: balanced, immutable, idempotent, tenant-scoped. Runs on both database engines (TEST_DB=postgres).
process.env.JWT_SECRET = 'test-secret-for-ledger';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDb } = require('./helpers/fakeDb');

const db = createFakeDb();
db.install();

const ledger = require('../lib/ledger');
const { ACCOUNTS: A } = ledger;

const reset = () => { db.LedgerTxn.rows.length = 0; };
const post = (over = {}) => ledger.post({
  tenantId: 't1', eventKey: 'evt-1', type: 'ONLINE_PAYMENT', currency: 'INR', tripId: 'T1', driverId: 'D1',
  entries: [
    { account: A.GATEWAY_CLEARING, debitMinor: 20000 },
    { account: A.DRIVER_PAYABLE, driverId: 'D1', creditMinor: 17000 },
    { account: A.COMMISSION_REVENUE, creditMinor: 3000 }
  ], ...over
});

test('entries must balance, be whole minor units, name a known account and put each amount on one side only', () => {
  const ok = [{ account: A.GATEWAY_CLEARING, debitMinor: 100 }, { account: A.COMMISSION_REVENUE, creditMinor: 100 }];
  assert.doesNotThrow(() => ledger.validateEntries(ok));
  const bad = (entries, re) => assert.throws(() => ledger.validateEntries(entries), re);
  bad([{ account: A.GATEWAY_CLEARING, debitMinor: 100 }, { account: A.COMMISSION_REVENUE, creditMinor: 99 }], /do not balance/);
  bad([{ account: A.GATEWAY_CLEARING, debitMinor: 100 }], /at least two/);
  bad([{ account: A.GATEWAY_CLEARING, debitMinor: 0 }, { account: A.COMMISSION_REVENUE, creditMinor: 0 }], /positive/);
  bad([{ account: A.GATEWAY_CLEARING, debitMinor: 100, creditMinor: 100 }, { account: A.COMMISSION_REVENUE, creditMinor: 0 }], /one side/);
  bad([{ account: 'NOPE', debitMinor: 100 }, { account: A.COMMISSION_REVENUE, creditMinor: 100 }], /unknown account/);
  bad([{ account: A.GATEWAY_CLEARING, debitMinor: 100.5 }, { account: A.COMMISSION_REVENUE, creditMinor: 100.5 }], /whole/);
  bad([{ account: A.GATEWAY_CLEARING, debitMinor: -100 }, { account: A.COMMISSION_REVENUE, creditMinor: -100 }], /whole|positive/);
  bad([{ account: A.DRIVER_PAYABLE, debitMinor: 100 }, { account: A.COMMISSION_REVENUE, creditMinor: 100 }], /driverId/);
  bad('not an array', /entries/);
});

test('a posting is stored whole, with every entry, and cannot be posted unbalanced', async () => {
  reset();
  const r = await post();
  assert.equal(r.duplicate, false);
  assert.equal(db.LedgerTxn.rows.length, 1);
  assert.equal(db.LedgerTxn.rows[0].entries.length, 3);
  await assert.rejects(post({ eventKey: 'evt-bad', entries: [{ account: A.GATEWAY_CLEARING, debitMinor: 10 }, { account: A.COMMISSION_REVENUE, creditMinor: 9 }] }), /do not balance/);
  assert.equal(db.LedgerTxn.rows.length, 1, 'a refused posting leaves nothing behind');
});

test('posting the same event twice is harmless: one transaction, the same id back, no second entry', async () => {
  reset();
  const first = await post();
  const again = await post();
  assert.equal(again.duplicate, true);
  assert.equal(again.txnId, first.txnId);
  assert.equal(db.LedgerTxn.rows.length, 1);
});

test('the same event key with different content is refused (an event key names one business event)', async () => {
  reset();
  await post();
  await assert.rejects(post({ entries: [{ account: A.GATEWAY_CLEARING, debitMinor: 50 }, { account: A.COMMISSION_REVENUE, creditMinor: 50 }] }), (e) => e.code === 'EVENT_KEY_REUSED');
  assert.equal(db.LedgerTxn.rows.length, 1);
});

test('twenty simultaneous postings of one event leave exactly one transaction', async () => {
  reset();
  const results = await Promise.all(Array.from({ length: 20 }, () => post({ eventKey: 'evt-conc' })));
  assert.equal(db.LedgerTxn.rows.length, 1);
  assert.equal(new Set(results.map((r) => r.txnId)).size, 1);
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
});

test('event keys are per business: the same key in two businesses posts twice, and balances never mix', async () => {
  reset();
  await post({ tenantId: 't1' });
  await post({ tenantId: 't2', driverId: 'D9', entries: [{ account: A.GATEWAY_CLEARING, debitMinor: 500 }, { account: A.DRIVER_PAYABLE, driverId: 'D9', creditMinor: 500 }] });
  assert.equal(db.LedgerTxn.rows.length, 2);
  const b1 = await ledger.balances({ tenantId: 't1' });
  const b2 = await ledger.balances({ tenantId: 't2' });
  assert.equal(b1[A.GATEWAY_CLEARING], 20000);
  assert.equal(b2[A.GATEWAY_CLEARING], 500);
  assert.equal(await ledger.driverBalance({ tenantId: 't1', driverId: 'D9', account: A.DRIVER_PAYABLE }), 0, 'another business\'s driver is invisible');
});

test('balances are debit minus credit per account; a driver account is read per driver', async () => {
  reset();
  await post();
  await post({ eventKey: 'evt-2', tripId: 'T2', entries: [{ account: A.GATEWAY_CLEARING, debitMinor: 10000 }, { account: A.DRIVER_PAYABLE, driverId: 'D1', creditMinor: 8500 }, { account: A.COMMISSION_REVENUE, creditMinor: 1500 }] });
  const b = await ledger.balances({ tenantId: 't1' });
  assert.equal(b[A.GATEWAY_CLEARING], 30000);
  assert.equal(b[A.COMMISSION_REVENUE], -4500, 'revenue is a credit balance');
  assert.equal(await ledger.driverBalance({ tenantId: 't1', driverId: 'D1', account: A.DRIVER_PAYABLE }), -25500, 'payable is a credit balance: the business owes this');
  assert.equal(await ledger.owedToDriver({ tenantId: 't1', driverId: 'D1' }), 25500);
});

test('a reversal swaps the entries, is linked to the original, nets the books to zero, and can happen only once', async () => {
  reset();
  const orig = await post();
  const rev = await ledger.reverse({ tenantId: 't1', txnId: orig.txnId, reason: 'duplicate capture', createdBy: 'admin:a1' });
  assert.equal(rev.duplicate, false);
  const row = db.LedgerTxn.rows.find((r) => r.txnId === rev.txnId);
  assert.equal(row.reversalOf, orig.txnId);
  assert.equal(row.eventKey, `reverse:${orig.txnId}`);
  assert.deepEqual(row.entries.map((e) => [e.account, e.debitMinor || 0, e.creditMinor || 0]).sort(), [[A.COMMISSION_REVENUE, 3000, 0], [A.DRIVER_PAYABLE, 17000, 0], [A.GATEWAY_CLEARING, 0, 20000]]);
  const b = await ledger.balances({ tenantId: 't1' });
  assert.ok(Object.values(b).every((v) => v === 0), 'the books are back to zero');
  const again = await ledger.reverse({ tenantId: 't1', txnId: orig.txnId, reason: 'again', createdBy: 'admin:a1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.txnId, rev.txnId);
  assert.equal(db.LedgerTxn.rows.length, 2);
  await assert.rejects(ledger.reverse({ tenantId: 't1', txnId: rev.txnId, reason: 'x', createdBy: 'a' }), /cannot be reversed/);
  await assert.rejects(ledger.reverse({ tenantId: 't2', txnId: orig.txnId, reason: 'x', createdBy: 'a' }), /not found/);
  await assert.rejects(ledger.reverse({ tenantId: 't1', txnId: orig.txnId, reason: '', createdBy: 'a' }), /reason/);
});

test('the ledger code never edits or deletes a posted transaction', async () => {
  reset();
  const orig = await post();
  const snapshot = JSON.stringify(db.LedgerTxn.rows[0]);
  await ledger.reverse({ tenantId: 't1', txnId: orig.txnId, reason: 'r', createdBy: 'a' });
  await post();
  await ledger.balances({ tenantId: 't1' });
  await ledger.verify({ tenantId: 't1' });
  assert.equal(JSON.stringify(db.LedgerTxn.rows[0]), snapshot, 'the original row is byte-for-byte unchanged');
});

test('verify finds a transaction that does not balance (e.g. written around the ledger) and reports the books balanced otherwise', async () => {
  reset();
  await post();
  await post({ eventKey: 'evt-2', tripId: 'T2' });
  const clean = await ledger.verify({ tenantId: 't1' });
  assert.deepEqual(clean.problems, []);
  assert.equal(clean.transactions, 2);
  assert.equal(clean.totalDebitMinor, clean.totalCreditMinor);
  await db.LedgerTxn.create({ tenantId: 't1', txnId: 'bad', eventKey: 'rogue', type: 'X', currency: 'INR', entries: [{ account: A.GATEWAY_CLEARING, debitMinor: 100 }, { account: A.COMMISSION_REVENUE, creditMinor: 90 }] });
  const dirty = await ledger.verify({ tenantId: 't1' });
  assert.equal(dirty.problems.length, 1);
  assert.match(dirty.problems[0], /bad.*balance/);
});
