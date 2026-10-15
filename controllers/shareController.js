const { createModel } = require('../models/dynamicModel');
const { TripDetails } = require('../models/tripDetailsModel');
const { tenantById } = require('../lib/appTenant');
const share = require('../lib/tripShare');

/** The address the shared link is built on: PUBLIC_BASE_URL when set, else the host the request came to. */
function baseUrl(req) {
  const fixed = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/\S+$/i.test(fixed)) return fixed;
  return `${req.protocol}://${req.get('host')}`;
}

/**
 * POST /api/v1/rides/share  { trip_id }   (rider sign-in)
 * Returns the link for the rider's own trip; the same trip always gets the same link.
 */
exports.createShare = async (req, res) => {
  try {
    const body = req.body || {};
    const tripId = String(body.trip_id != null ? body.trip_id : body.ride_id != null ? body.ride_id : '').trim();
    if (!tripId) return res.status(400).json({ success: false, message: 'trip_id is required' });

    const trip = await TripDetails.findOne({ trip_id: tripId }).lean();
    if (!trip) return res.status(404).json({ success: false, message: 'Ride not found' });
    const actor = req.authActorId || (body.user_id != null ? String(body.user_id) : null);
    if (actor && trip.user_id !== actor) {
      return res.status(403).json({ success: false, message: 'You can only share your own ride' });
    }
    if (share.ENDED_STATUSES.includes(trip.status)) {
      return res.status(409).json({ success: false, message: 'This ride has ended, so there is nothing to follow' });
    }
    if (trip.status === 'REQUESTED') {
      return res.status(409).json({ success: false, message: 'A driver has not accepted yet. Share once the ride is accepted' });
    }

    let token = trip.share_token;
    if (!share.isToken(token)) {
      token = share.newToken();
      await TripDetails.updateOne({ trip_id: tripId }, { $set: { share_token: token } });
    }
    const url = `${baseUrl(req)}/t/${token}`;
    return res.status(200).json({ success: true, message: 'Share link', data: { trip_id: tripId, url, token } });
  } catch (error) {
    console.error('[rides share]', error);
    return res.status(500).json({ success: false, message: 'Could not create the share link' });
  }
};

/** GET /api/v1/public/track/:token  (no sign-in): the sanitised, live view of one shared ride. */
exports.publicTrack = async (req, res) => {
  try {
    const token = String(req.params.token || '').trim().toLowerCase();
    if (!share.isToken(token)) return res.status(404).json({ success: false, message: 'This link is not valid' });

    const trip = await TripDetails.findOne({ share_token: token }).lean();
    if (!trip) return res.status(404).json({ success: false, message: 'This link is not valid' });

    const driver = trip.driver_id ? await createModel('drivers').findOne({ driverId: trip.driver_id }).lean() : null;
    let brand = null;
    try {
      const tenant = trip.tenant_id ? await tenantById(trip.tenant_id) : null;
      brand = tenant && (tenant.appName || tenant.name) ? String(tenant.appName || tenant.name) : null;
    } catch (_) { /* the brand is optional */ }

    const view = share.publicView(trip, driver, brand);
    if (!view) return res.status(410).json({ success: false, message: 'This ride has ended and the link has expired' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: view });
  } catch (error) {
    console.error('[public track]', error);
    return res.status(500).json({ success: false, message: 'Could not load this ride' });
  }
};
