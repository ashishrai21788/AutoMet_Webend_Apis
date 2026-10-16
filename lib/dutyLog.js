/**
 * Online hours for the driver app. Sessions are opened and closed by the go-online / go-offline call; a session that was
 * never closed (a crash, a dead phone, the presence sweeper) is read as ending when the driver was last seen, and never
 * longer than MAX_SESSION_MS, so a forgotten session cannot add up to a full day of "online time".
 */
const MAX_SESSION_MS = 16 * 60 * 60 * 1000;

const model = (deps) => (deps && deps.DriverDutySession) || require('../models/driverDutySessionModel').DriverDutySession;

/** Where an open session is read to end. `driver` is the driver's current record. */
function openEnd(session, driver, now) {
  const cap = new Date(new Date(session.startedAt).getTime() + MAX_SESSION_MS);
  let end = now;
  if (!driver || !driver.isOnline) {
    const seen = driver && (driver.wentOfflineAt || driver.lastActive);
    end = seen ? new Date(seen) : new Date(session.startedAt);
  }
  if (end < new Date(session.startedAt)) end = new Date(session.startedAt);
  return end > cap ? cap : end;
}

/**
 * The driver went online. `before` is the driver as they were just before this call: a driver who was already online keeps
 * their open session; sessions left open from earlier are closed at the time the driver was last seen.
 */
async function markOnline(driver, before, now = new Date(), deps) {
  const M = model(deps);
  const open = await M.find({ driverId: driver.driverId, endedAt: null }).lean();
  if (before && before.isOnline && open.length) return open[0];
  if (open.length) {
    const seen = before && (before.wentOfflineAt || before.lastActive);
    await M.updateMany({ driverId: driver.driverId, endedAt: null }, { $set: { endedAt: seen ? new Date(seen) : now } });
  }
  return M.create({ driverId: driver.driverId, tenantId: driver.tenantId || null, startedAt: now, endedAt: null });
}

async function markOffline(driverId, now = new Date(), deps) {
  const M = model(deps);
  await M.updateMany({ driverId, endedAt: null }, { $set: { endedAt: now } });
}

/** Seconds of online time inside [from, to) from sessions (open ones read by `openEnd`). */
function onlineSeconds(sessions, driver, from, to, now = new Date()) {
  let ms = 0;
  for (const s of sessions || []) {
    const start = new Date(s.startedAt);
    let end = s.endedAt ? new Date(s.endedAt) : openEnd(s, driver, now);
    if (end - start > MAX_SESSION_MS) end = new Date(start.getTime() + MAX_SESSION_MS);
    const a = start > from ? start : from;
    const b = end < to ? end : to;
    if (b > a) ms += b - a;
  }
  return Math.round(ms / 1000);
}

module.exports = { markOnline, markOffline, onlineSeconds, openEnd, MAX_SESSION_MS };
