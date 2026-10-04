const ONGOING = ['ACCEPTED', 'DRIVER_ON_THE_WAY', 'ARRIVED', 'ON_GOING'];
const CANCELLED = ['CANCELLED_BY_USER', 'CANCELLED_BY_USER_AFTER_ACCEPTANCE'];
const UNANSWERED_OR_DECLINED = ['REQUESTED', 'REJECTED', 'REJECTED_WITH_REASON', 'NO_RESPONSE'];

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Start of the current calendar day in India (the first clients are Indian), as a UTC Date. */
function startOfTodayIST(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

/**
 * Rates over a set of requests, from a { STATUS: count } map.
 *  acceptance   = requests a driver accepted / requests that were answered or expired (not still waiting)
 *  cancellation = requests cancelled by the rider / all requests
 * Both are whole percentages, 0 when there is nothing to divide by.
 */
function computeRates(countsByStatus) {
  const get = (s) => countsByStatus[s] || 0;
  const total = Object.values(countsByStatus).reduce((a, b) => a + b, 0);
  const waiting = get('REQUESTED');
  const decided = total - waiting;
  const declined = UNANSWERED_OR_DECLINED.filter((s) => s !== 'REQUESTED').reduce((a, s) => a + get(s), 0);
  const cancelled = CANCELLED.reduce((a, s) => a + get(s), 0);
  const accepted = decided - declined - cancelled;
  // A request cancelled before a driver answered is not an acceptance, but one cancelled after acceptance is.
  const acceptedIncludingLaterCancels = accepted + get('CANCELLED_BY_USER_AFTER_ACCEPTANCE');
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
  return {
    acceptanceRate: pct(acceptedIncludingLaterCancels, decided),
    cancellationRate: pct(cancelled, total)
  };
}

module.exports = { ONGOING, CANCELLED, startOfTodayIST, computeRates };
