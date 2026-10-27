/**
 * The double-entry ledger (the only code that writes `ledger_transactions`).
 *
 *  - A transaction carries its entries and is inserted whole, so it is posted completely or not at all.
 *  - Debits equal credits in every transaction (checked here, and again by `verify`).
 *  - Posting is idempotent by `eventKey` (unique per business): replaying an event returns the first transaction and writes nothing.
 *    The same key with different content is an error (a key names exactly one business event).
 *  - Nothing is edited or deleted. `reverse` posts a new transaction with the entries swapped; an event can be reversed once.
 *  - Reads are always for one business (`tenantId` is required); balances never mix businesses.
 *
 * Sign convention: a balance is debits minus credits. Assets and expenses are normally positive; liabilities and revenue are normally
 * negative (a credit balance). `owedToDriver` flips the sign for the one question people ask: how much does the business owe this driver.
 * Amounts are whole minor units (paise).
 */
const crypto = require('crypto');
const { LedgerTxn } = require('../models/paymentModels');

const ACCOUNTS = Object.freeze({
  GATEWAY_CLEARING: 'GATEWAY_CLEARING', // money the payment provider holds for the business, not yet settled to the bank
  SETTLEMENT_CLEARING: 'SETTLEMENT_CLEARING', // money in transit between the provider or the business and a bank
  DRIVER_PAYABLE: 'DRIVER_PAYABLE', // what the business owes a driver (per driver)
  PAYOUT_RESERVED: 'PAYOUT_RESERVED', // payable amounts set aside for a payout that is not finished (per driver)
  DRIVER_COMMISSION_RECEIVABLE: 'DRIVER_COMMISSION_RECEIVABLE', // commission a driver owes after collecting a fare in cash (per driver)
  COMMISSION_REVENUE: 'COMMISSION_REVENUE', // the business's commission, earned
  GATEWAY_FEES: 'GATEWAY_FEES', // what the provider charges
  REFUND_CLEARING: 'REFUND_CLEARING', // refunds sent to the provider and not yet confirmed
  TAX_PAYABLE: 'TAX_PAYABLE', // tax collected for the authorities (only when a tax configuration is active)
  FINANCIAL_ADJUSTMENTS: 'FINANCIAL_ADJUSTMENTS' // the other side of an authorised manual correction
});
const DRIVER_ACCOUNTS = new Set([ACCOUNTS.DRIVER_PAYABLE, ACCOUNTS.PAYOUT_RESERVED, ACCOUNTS.DRIVER_COMMISSION_RECEIVABLE]);
const KNOWN = new Set(Object.values(ACCOUNTS));

const newId = () => `led_${crypto.randomBytes(9).toString('hex')}`;
const dup = (e) => e && e.code === 11000;

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 2) throw new TypeError('a transaction needs at least two entries (entries must be an array)');
  let debit = 0; let credit = 0;
  for (const e of entries) {
    if (!e || !KNOWN.has(e.account)) throw new TypeError(`unknown account ${e && e.account}`);
    const d = e.debitMinor == null ? 0 : e.debitMinor;
    const c = e.creditMinor == null ? 0 : e.creditMinor;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0) throw new TypeError('entry amounts must be whole, non-negative minor units');
    if (d > 0 && c > 0) throw new TypeError('an entry is on one side only (debit or credit)');
    if (d === 0 && c === 0) throw new TypeError('an entry amount must be positive');
    if (DRIVER_ACCOUNTS.has(e.account) && !e.driverId) throw new TypeError(`${e.account} entries need a driverId`);
    debit += d; credit += c;
  }
  if (debit !== credit) throw new TypeError(`entries do not balance: debits ${debit}, credits ${credit}`);
  return { debitMinor: debit, creditMinor: credit };
}

const normalise = (entries) => entries.map((e) => ({ account: e.account, driverId: e.driverId || null, debitMinor: e.debitMinor || 0, creditMinor: e.creditMinor || 0 }));
const fingerprint = (t) => JSON.stringify({ type: t.type, currency: t.currency, tripId: t.tripId || null, driverId: t.driverId || null, entries: normalise(t.entries).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });

async function insert(doc) {
  const wanted = { ...doc, entries: normalise(doc.entries) };
  const existing = await LedgerTxn.findOne({ tenantId: doc.tenantId, eventKey: doc.eventKey }).lean();
  const settle = (row) => {
    if (fingerprint(row) !== fingerprint(wanted)) throw Object.assign(new Error(`event key ${doc.eventKey} was already used for a different transaction`), { code: 'EVENT_KEY_REUSED' });
    return { txnId: row.txnId, duplicate: true };
  };
  if (existing) return settle(existing);
  try {
    const row = await LedgerTxn.create({ ...wanted, txnId: newId(), createdAt: new Date() });
    return { txnId: row.txnId, duplicate: false };
  } catch (e) {
    if (!dup(e)) throw e;
    return settle(await LedgerTxn.findOne({ tenantId: doc.tenantId, eventKey: doc.eventKey }).lean()); // another request posted it first
  }
}

/** Post one balanced transaction. Safe to repeat. -> { txnId, duplicate } */
async function post({ tenantId, eventKey, type, currency, tripId = null, driverId = null, paymentId = null, entries, memo = '', createdBy = 'system', reversalOf = null }) {
  if (!tenantId) throw new TypeError('tenantId is required');
  if (!eventKey || typeof eventKey !== 'string') throw new TypeError('eventKey is required');
  if (!type || !currency) throw new TypeError('type and currency are required');
  validateEntries(entries);
  for (const e of entries) if (e.driverId && driverId && e.driverId !== driverId) throw new TypeError('a transaction concerns one driver');
  const owner = driverId || (entries.find((e) => e.driverId) || {}).driverId || null;
  return insert({ tenantId, eventKey, type, currency, tripId, driverId: owner, paymentId, entries, memo, createdBy, reversalOf });
}

/** Undo a posted transaction by posting its mirror image. Safe to repeat. */
async function reverse({ tenantId, txnId, reason, createdBy }) {
  if (!reason || !String(reason).trim()) throw new TypeError('a reversal needs a reason');
  const orig = await LedgerTxn.findOne({ tenantId, txnId }).lean();
  if (!orig) throw Object.assign(new Error('transaction not found'), { code: 'NOT_FOUND' });
  if (orig.reversalOf) throw Object.assign(new Error('a reversal cannot be reversed; post a new transaction instead'), { code: 'NOT_REVERSIBLE' });
  const swapped = normalise(orig.entries).map((e) => ({ account: e.account, driverId: e.driverId, debitMinor: e.creditMinor, creditMinor: e.debitMinor }));
  return post({
    tenantId, eventKey: `reverse:${txnId}`, type: `REVERSAL_OF_${orig.type}`, currency: orig.currency, tripId: orig.tripId, driverId: orig.driverId,
    paymentId: orig.paymentId, entries: swapped, memo: `Reversal: ${String(reason).trim().slice(0, 200)}`, createdBy: createdBy || 'system', reversalOf: txnId
  });
}

const rowsOf = async (tenantId, filter = {}) => {
  if (!tenantId) throw new TypeError('tenantId is required');
  return (await LedgerTxn.find({ tenantId, ...filter }).lean()) || [];
};

/** { ACCOUNT: debits - credits } across the business (driver accounts summed over all drivers). */
async function balances({ tenantId, driverId = null }) {
  const out = {};
  for (const t of await rowsOf(tenantId, driverId ? { driverId } : {})) {
    for (const e of t.entries) out[e.account] = (out[e.account] || 0) + (e.debitMinor || 0) - (e.creditMinor || 0);
  }
  return out;
}

/** One driver's balance on one account (debits - credits). */
async function driverBalance({ tenantId, driverId, account }) {
  let sum = 0;
  for (const t of await rowsOf(tenantId, { driverId })) for (const e of t.entries) if (e.account === account && e.driverId === driverId) sum += (e.debitMinor || 0) - (e.creditMinor || 0);
  return sum;
}

/** The posted transactions of one business, optionally for one driver and one type. */
async function list({ tenantId, driverId = null, type = null }) {
  return rowsOf(tenantId, { ...(driverId ? { driverId } : {}), ...(type ? { type } : {}) });
}

/** What the business owes this driver now (the credit balance of their payable account). */
async function owedToDriver({ tenantId, driverId }) {
  const balance = await driverBalance({ tenantId, driverId, account: ACCOUNTS.DRIVER_PAYABLE });
  return balance === 0 ? 0 : -balance; // never -0
}

/** What this driver owes the business as unpaid commission on cash fares. */
async function commissionOutstanding({ tenantId, driverId }) {
  return driverBalance({ tenantId, driverId, account: ACCOUNTS.DRIVER_COMMISSION_RECEIVABLE });
}

/** Check every transaction of one business. { transactions, totalDebitMinor, totalCreditMinor, problems: [string] } */
async function verify({ tenantId }) {
  const rows = await rowsOf(tenantId);
  const problems = []; let totalDebitMinor = 0; let totalCreditMinor = 0;
  for (const t of rows) {
    try {
      const s = validateEntries(t.entries);
      totalDebitMinor += s.debitMinor; totalCreditMinor += s.creditMinor;
    } catch (e) { problems.push(`transaction ${t.txnId}: ${e.message}`); }
  }
  return { transactions: rows.length, totalDebitMinor, totalCreditMinor, problems };
}

module.exports = { ACCOUNTS, DRIVER_ACCOUNTS, validateEntries, post, reverse, list, balances, driverBalance, owedToDriver, commissionOutstanding, verify };
