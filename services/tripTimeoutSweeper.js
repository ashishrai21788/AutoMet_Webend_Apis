/**
 * Expires ride requests the driver never answered. Without this a request whose 60-second window has passed stays
 * REQUESTED for ever (the check-timeouts endpoint only runs when an outside scheduler calls it), which keeps the rider
 * "in a ride" and unable to book again, and leaves the dashboard counting it as searching.
 *
 * Runs inside the server every few seconds. The work is a conditional update per trip (see expireTimedOutRequests), so it
 * is safe next to the endpoint and across several server instances. Turn it off with TRIP_TIMEOUT_SWEEP=off.
 */
let timer = null;
let running = false;

async function sweepTimedOutRequests() {
  const { expireTimedOutRequests } = require('../controllers/tripsController'); // loaded lazily: the controller is heavy
  return expireTimedOutRequests(new Date());
}

function startTripTimeoutSweeper({ intervalMs } = {}) {
  if (timer || process.env.TRIP_TIMEOUT_SWEEP === 'off') return;
  const every = intervalMs || Math.max(5, Number(process.env.TRIP_TIMEOUT_SWEEP_SECONDS) || 15) * 1000;
  timer = setInterval(() => {
    if (running) return; // a slow run is never overlapped
    running = true;
    sweepTimedOutRequests()
      .then((n) => { if (n) console.log(`[trips] ${n} ride request(s) expired: no driver response`); })
      .catch((e) => console.warn('[trips] timeout sweep failed:', e.message))
      .finally(() => { running = false; });
  }, every);
  if (timer.unref) timer.unref();
}

const stopTripTimeoutSweeper = () => { if (timer) clearInterval(timer); timer = null; running = false; };

module.exports = { sweepTimedOutRequests, startTripTimeoutSweeper, stopTripTimeoutSweeper };
