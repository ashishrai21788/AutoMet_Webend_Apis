/**
 * The analytics endpoints take events before anyone has signed in (the apps send them from the first screen), so they cannot
 * require a sign-in. Instead they are bounded: a request is limited per address, one request carries a bounded number of events,
 * and an event is a bounded size. Normal apps are nowhere near these limits.
 */
const { createLimiter, clientIp } = require('./rateLimit');

const MAX_EVENTS_PER_REQUEST = 200;
const MAX_BODY_BYTES = 256 * 1024;

function analyticsGuard(name) {
  const perAddress = createLimiter({ name: `${name}-ip`, windowMs: 60 * 1000, max: 240, key: (r) => `analytics:${name}:${clientIp(r)}`, message: 'Too many analytics requests. Please slow down.' });
  return [
    perAddress,
    (req, res, next) => {
      const body = req.body;
      if (body && Array.isArray(body.events)) {
        if (body.events.length > MAX_EVENTS_PER_REQUEST) {
          return res.status(413).json({ success: false, message: `Send at most ${MAX_EVENTS_PER_REQUEST} events at a time`, data: { max: MAX_EVENTS_PER_REQUEST } });
        }
        let size = 0;
        try { size = Buffer.byteLength(JSON.stringify(body)); } catch (_) { size = MAX_BODY_BYTES + 1; }
        if (size > MAX_BODY_BYTES) return res.status(413).json({ success: false, message: 'That analytics batch is too large', data: { maxBytes: MAX_BODY_BYTES } });
      }
      next();
    }
  ];
}

module.exports = { analyticsGuard, MAX_EVENTS_PER_REQUEST, MAX_BODY_BYTES };
