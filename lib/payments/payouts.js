/**
 * Driver payouts and the ledger, in SHADOW mode.
 *
 * The existing manual flow is unchanged and is still what decides what a driver can withdraw (controllers/driverEarningsController.js,
 * controllers/payoutsController.js, models/driverPayoutModel.js): the driver asks, the business pays outside the app and records the bank
 * reference (or marks it failed), the driver may cancel while it is only requested. This module makes the ledger follow it:
 *
 *   requested (or processing)  DR DRIVER_PAYABLE   CR PAYOUT_RESERVED       payout:<id>:reserve   the amount is set aside
 *   paid                       DR PAYOUT_RESERVED  CR SETTLEMENT_CLEARING   payout:<id>:paid       it left for the driver's bank
 *   failed or cancelled        DR PAYOUT_RESERVED  CR DRIVER_PAYABLE        payout:<id>:release    it is owed to the driver again
 *
 * `syncPayout` posts every posting the payout's CURRENT status implies, in order, each by its own event key, so it is safe to run at any
 * time and any number of times (a payout that skipped a step, or was made before this existed, is brought fully up to date). It records the
 * status it followed in `ledgerSyncedStatus`; `repairUnsynced` finds payouts where that differs from `status`. The hooks call `safeSync`,
 * which never throws: a ledger problem must not fail a payout action that the business or the driver has already done.
 *
 * It also gives a payment provider the same moves (`disburse`, `settleDisbursement`) for a business whose provider can send payouts (only
 * the mock gateway today; the real providers refuse). The provider's answer is applied with the same conditional update the manual flow
 * uses, so a payout can be settled once, whichever way, and the transfer is requested with an idempotency key so it is never sent twice.
 */
const { DriverPayout } = require('../../models/driverPayoutModel');
const { createModel } = require('../../models/dynamicModel');
const ledger = require('../ledger');
const { ACCOUNTS: A } = ledger;
const { tenantPayments } = require('./config');
const { getAdapter } = require('./adapters');
const svc = require('./service');

const { err } = svc;
const lean = (d) => (d && d.toObject ? d.toObject() : d);
const OPEN = ['REQUESTED', 'PROCESSING'];

/** The postings a payout's current status implies, in the order they must happen. */
function postingsFor(p) {
  const base = { tenantId: p.tenantId, driverId: p.driverId, currency: p.currency, createdBy: 'system' };
  const out = [{
    ...base, eventKey: `payout:${p.payoutId}:reserve`, type: 'PAYOUT_RESERVED', memo: 'Withdrawal set aside for the driver',
    entries: [{ account: A.DRIVER_PAYABLE, driverId: p.driverId, debitMinor: p.amountMinor }, { account: A.PAYOUT_RESERVED, driverId: p.driverId, creditMinor: p.amountMinor }]
  }];
  if (p.status === 'PAID') {
    out.push({
      ...base, eventKey: `payout:${p.payoutId}:paid`, type: 'PAYOUT_PAID', memo: `Payout sent${p.reference ? ` (ref ${p.reference})` : ''}`,
      entries: [{ account: A.PAYOUT_RESERVED, driverId: p.driverId, debitMinor: p.amountMinor }, { account: A.SETTLEMENT_CLEARING, creditMinor: p.amountMinor }]
    });
  } else if (p.status === 'FAILED' || p.status === 'CANCELLED') {
    out.push({
      ...base, eventKey: `payout:${p.payoutId}:release`, type: 'PAYOUT_RELEASED', memo: p.status === 'FAILED' ? 'Payout failed: back in the driver\'s balance' : 'Withdrawal cancelled: back in the driver\'s balance',
      entries: [{ account: A.PAYOUT_RESERVED, driverId: p.driverId, debitMinor: p.amountMinor }, { account: A.DRIVER_PAYABLE, driverId: p.driverId, creditMinor: p.amountMinor }]
    });
  }
  return out;
}

/** Make the ledger match this payout's status. Idempotent. Throws if the ledger cannot be written. -> { posted } (new transactions only) */
async function syncPayout(payout) {
  const p = lean(payout);
  if (!p || !p.tenantId || !p.driverId || !Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) throw err('BAD_PAYOUT', 'this payout cannot be posted', 400);
  let posted = 0;
  for (const posting of postingsFor(p)) {
    const r = await ledger.post(posting);
    if (!r.duplicate) posted += 1;
  }
  // only mark it followed if it is still in the status we followed: a later change has its own sync, and the repair covers a missed one
  await DriverPayout.findOneAndUpdate({ tenantId: p.tenantId, payoutId: p.payoutId, status: p.status }, { $set: { ledgerSyncedStatus: p.status } });
  return { posted };
}

/** The hook the payout actions call. Never throws: a ledger failure is logged and left for the repair (the payout is not marked as followed). */
async function safeSync(payout) {
  try { return await syncPayout(payout); } catch (e) {
    console.warn('[payouts] ledger not updated for payout', payout && (payout.payoutId || (payout.toObject && payout.toObject().payoutId)), e.message);
    return null;
  }
}

/** Bring every payout of one business whose ledger is behind up to date. Idempotent. -> { repaired, failed } */
async function repairUnsynced({ tenantId }) {
  const rows = ((await DriverPayout.find({ tenantId }).lean()) || []).filter((p) => p.ledgerSyncedStatus !== p.status);
  let repaired = 0; let failed = 0;
  for (const p of rows) { if (await safeSync(p)) repaired += 1; else failed += 1; }
  return { repaired, failed };
}

// ---------------------------------------------------------------- a payment provider sends the payout

const find = async (tenantId, payoutId) => lean(await DriverPayout.findOne({ tenantId, payoutId }).lean());

/** Apply a provider's answer with the same conditional update the manual flow uses, so a payout is settled once. -> the payout as it now is */
async function applyResult(payout, result, providerName) {
  const now = new Date();
  const by = `provider:${providerName}`;
  const key = { tenantId: payout.tenantId, payoutId: payout.payoutId };
  let moved = null;
  if (result.status === 'processed') {
    moved = await DriverPayout.findOneAndUpdate({ ...key, status: { $in: OPEN } }, { $set: { status: 'PAID', open: false, paidAt: now, reference: result.reference || result.providerPayoutId, providerPayoutId: result.providerPayoutId || payout.providerPayoutId, handledBy: by, updatedAt: now } }, { new: true });
  } else if (result.status === 'failed') {
    moved = await DriverPayout.findOneAndUpdate({ ...key, status: { $in: OPEN } }, { $set: { status: 'FAILED', open: false, failedAt: now, failureReason: String(result.reason || 'The payment provider could not send this payout').slice(0, 140), providerPayoutId: result.providerPayoutId || payout.providerPayoutId, handledBy: by, updatedAt: now } }, { new: true });
  } else {
    // still pending at the provider: it is being processed, and we remember which transfer to ask about
    moved = await DriverPayout.findOneAndUpdate({ ...key, status: 'REQUESTED' }, { $set: { status: 'PROCESSING', processingAt: now, providerPayoutId: result.providerPayoutId, handledBy: by, updatedAt: now } }, { new: true });
    if (!moved && !payout.providerPayoutId && result.providerPayoutId) await DriverPayout.findOneAndUpdate({ ...key, status: 'PROCESSING', providerPayoutId: null }, { $set: { providerPayoutId: result.providerPayoutId } });
  }
  const now1 = await find(payout.tenantId, payout.payoutId);
  if (moved) {
    await safeSync(now1);
    if (now1.status === 'PAID' || now1.status === 'FAILED') {
      try {
        const { sendPushToDriver } = require('../pushNotification');
        const shown = (now1.amountMinor / 100).toFixed(2);
        await sendPushToDriver(now1.driverId, now1.status === 'PAID'
          ? { title: 'Payout sent', body: `${shown} was sent to your bank account. Ref ${now1.reference}`, channelId: 'driver_notifications', data: { type: 'PAYOUT', payout_id: now1.payoutId } }
          : { title: 'Payout could not be sent', body: `${shown} is back in your balance. ${now1.failureReason || ''}`.trim(), channelId: 'driver_notifications', data: { type: 'PAYOUT', payout_id: now1.payoutId } });
      } catch (_) { /* the driver sees the result in the app either way */ }
    }
  }
  return now1;
}

/** Ask this business's payment provider to send a requested payout. Safe to repeat: the transfer is never sent twice. -> the payout */
async function disburse({ tenantId, payoutId, env = process.env }) {
  const payout = await find(tenantId, payoutId);
  if (!payout) throw err('NOT_FOUND', 'payout not found', 404);
  if (!OPEN.includes(payout.status)) throw err('NOT_OPEN', `this payout is already ${payout.status.toLowerCase()}`, 409);
  const cfg = tenantPayments(await svc.loadTenant(tenantId));
  const adapter = cfg.provider ? getAdapter(cfg.provider, env) : null;
  if (!adapter || !adapter.capabilities || !adapter.capabilities.payouts) throw err('PAYOUTS_NOT_SUPPORTED', 'this business\'s payment provider cannot send payouts', 409);
  const driver = (await createModel('drivers').findOne({ driverId: payout.driverId }).lean()) || {};
  const bank = driver.bankAccount || {};
  const result = await adapter.requestPayout({
    payoutId: payout.payoutId, amountMinor: payout.amountMinor, currency: payout.currency, idempotencyKey: `${tenantId}:${payout.payoutId}`,
    account: { holder: bank.accountHolderName || '', accountNumber: bank.accountNumber || '', ifsc: bank.ifscCode || '', bankName: bank.bankName || '' }
  });
  return applyResult(payout, result, adapter.name);
}

/** Ask the provider how a payout it is processing ended, and apply it. Safe to repeat. -> the payout */
async function settleDisbursement({ tenantId, payoutId, env = process.env }) {
  const payout = await find(tenantId, payoutId);
  if (!payout) throw err('NOT_FOUND', 'payout not found', 404);
  if (payout.status !== 'PROCESSING' || !payout.providerPayoutId) return payout;
  const cfg = tenantPayments(await svc.loadTenant(tenantId));
  const adapter = cfg.provider ? getAdapter(cfg.provider, env) : null;
  if (!adapter || !adapter.capabilities || !adapter.capabilities.payouts) return payout;
  const seen = await adapter.fetchPayout(payout.providerPayoutId);
  if (!seen) return payout;
  return applyResult(payout, { ...seen, providerPayoutId: payout.providerPayoutId }, adapter.name);
}

/** Settle every payout of one business that a provider is still processing. -> number settled (no longer processing) */
async function settleAll({ tenantId, env = process.env }) {
  const rows = ((await DriverPayout.find({ tenantId, status: 'PROCESSING' }).lean()) || []).filter((p) => p.providerPayoutId);
  let settled = 0;
  for (const p of rows) { const after = await settleDisbursement({ tenantId, payoutId: p.payoutId, env }); if (after.status !== 'PROCESSING') settled += 1; }
  return settled;
}

module.exports = { postingsFor, syncPayout, safeSync, repairUnsynced, disburse, settleDisbursement, settleAll };
