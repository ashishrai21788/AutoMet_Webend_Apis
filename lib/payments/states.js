/**
 * Payment states and the only moves between them. A payment's `status` is what the money did; refunds are tracked separately in
 * `refundStatus` so a refunded payment still says it succeeded. A success is final: it is undone only by a refund, never by a later
 * "failed" message (an older or stale event cannot flip a paid payment).
 *
 * A success may arrive after the payment was marked FAILED, EXPIRED or CANCELLED locally (the customer paid just as the window closed):
 * that is real money, so it is accepted (and flagged for review), not dropped.
 */
const STATUS = Object.freeze({ CREATED: 'CREATED', PENDING: 'PENDING', SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED' });
const LIVE = Object.freeze([STATUS.CREATED, STATUS.PENDING, STATUS.SUCCEEDED]);
const MOVES = Object.freeze({
  CREATED: ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PENDING: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  FAILED: ['SUCCEEDED'],
  EXPIRED: ['SUCCEEDED'],
  CANCELLED: ['SUCCEEDED'],
  SUCCEEDED: []
});
const canMove = (from, to) => (MOVES[from] || []).includes(to);
/** The statuses a payment may be in for a move to `to` (used as the filter of the conditional update). */
const sourcesFor = (to) => Object.keys(MOVES).filter((from) => canMove(from, to));
const isLive = (status) => LIVE.includes(status);

const REFUND = Object.freeze({ NONE: 'NONE', PENDING: 'REFUND_PENDING', PARTIAL: 'PARTIALLY_REFUNDED', FULL: 'REFUNDED' });
const CASH = Object.freeze({ PENDING: 'PENDING', CONFIRMED: 'CONFIRMED', DISPUTED: 'DISPUTED', ADJUSTED: 'ADJUSTED' });

module.exports = { STATUS, LIVE, MOVES, REFUND, CASH, canMove, sourcesFor, isLive };
