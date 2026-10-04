/**
 * Takes drivers offline when their phone has gone quiet. Without this a driver who closes the app or loses signal
 * would stay "online" for ever and keep being offered rides. Only drivers that have sent heartbeats before are touched;
 * drivers on an app version without heartbeats are left alone (see lib/driverLocation.js).
 */
const { createModel } = require('../models/dynamicModel');
const { EntityHistory } = require('../models/fleetModels');
const { defaultTenant } = require('../lib/appTenant');
const { config } = require('../lib/driverLocation');

const BATCH = 500;

async function sweepStaleDrivers({ now = new Date(), cfg = config() } = {}) {
  const Driver = createModel('drivers');
  const cutoff = new Date(now.getTime() - cfg.staleOfflineSeconds * 1000);
  const stale = await Driver.find({ isOnline: true, locationUpdatedAt: { $ne: null, $lt: cutoff } }).select('driverId tenantId locationUpdatedAt').limit(BATCH).lean();
  if (stale.length === 0) return { wentOffline: 0 };

  await Driver.updateMany({ driverId: { $in: stale.map((d) => d.driverId) }, isOnline: true }, { $set: { isOnline: false, wentOfflineAt: now, wentOfflineReason: 'NO_LOCATION_SIGNAL' } });

  const def = await defaultTenant().catch(() => null);
  const minutes = Math.round((cfg.staleOfflineSeconds / 60) * 10) / 10;
  for (const d of stale) {
    const tenantId = d.tenantId || (def && def.tenantId);
    if (!tenantId) continue;
    try {
      await EntityHistory.create({
        tenantId, subjectType: 'driver', subjectId: d.driverId, kind: 'PRESENCE', action: 'WENT_OFFLINE_NO_SIGNAL', from: 'ONLINE', to: 'OFFLINE',
        reason: `No location update for more than ${minutes} minutes`, at: now
      });
    } catch (e) {
      console.warn('[presence] history write failed:', e.message);
    }
  }
  return { wentOffline: stale.length };
}

let timer = null;
function startDriverPresenceSweeper({ intervalMs = 30 * 1000 } = {}) {
  if (timer || process.env.DRIVER_STALE_SWEEP === 'off') return;
  timer = setInterval(() => {
    sweepStaleDrivers()
      .then((r) => { if (r.wentOffline) console.log(`[presence] ${r.wentOffline} driver(s) taken offline: no location signal`); })
      .catch((e) => console.warn('[presence] sweep failed:', e.message));
  }, intervalMs);
  if (timer.unref) timer.unref();
}
const stopDriverPresenceSweeper = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = { sweepStaleDrivers, startDriverPresenceSweeper, stopDriverPresenceSweeper };
