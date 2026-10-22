/**
 * Applies scheduled pricing publishes when their time comes (see controllers/pricingController.js).
 *
 * Runs inside the server every 30 seconds, so a change takes effect within about a minute of its time. Each schedule is claimed
 * with a conditional update, so two servers never apply the same one, and one left half-way by a server that stopped is picked up
 * again after five minutes (applying is made of upserts and removals, so repeating it is safe). Turn it off with PRICING_SCHEDULE_SWEEP=off.
 */
let timer = null;
let running = false;

async function sweepDueSchedules(now = new Date()) {
  const { runDueSchedules } = require('../controllers/pricingController'); // loaded lazily: the controller pulls in a lot
  return runDueSchedules(now);
}

function startPricingScheduleSweeper({ intervalMs } = {}) {
  if (timer || process.env.PRICING_SCHEDULE_SWEEP === 'off') return;
  const every = intervalMs || Math.max(5, Number(process.env.PRICING_SCHEDULE_SWEEP_SECONDS) || 30) * 1000;
  timer = setInterval(() => {
    if (running) return; // a slow run is never overlapped
    running = true;
    sweepDueSchedules()
      .then((n) => { if (n) console.log(`[pricing] ${n} scheduled pricing change(s) applied`); })
      .catch((e) => console.warn('[pricing] schedule sweep failed:', e.message))
      .finally(() => { running = false; });
  }, every);
  if (timer.unref) timer.unref();
}

const stopPricingScheduleSweeper = () => { if (timer) clearInterval(timer); timer = null; running = false; };

module.exports = { sweepDueSchedules, startPricingScheduleSweeper, stopPricingScheduleSweeper };
