const mongoose = require('mongoose');
const UserDriverMapView = require('../models/userDriverMapViewModel');

const MAX_RANGE_DAYS = 365;

function getTotal(facetResult) {
  return facetResult && facetResult[0] && typeof facetResult[0].total === 'number' ? facetResult[0].total : 0;
}

/**
 * GET /api/drivers/:driverId/analytics
 *
 * Product definitions (see MAP_ANALYTICS_DESIGN.md):
 * - Map appearances: Counted only from map_screen_opened (once per screen session). NOT from refresh events, so no
 *   overcounting when driver list refreshes every few seconds. One event per session per driver in initial visible set.
 * - Currently viewing (active search live): TTL collection updated when visible_driver_snapshot (or legacy events) is
 *   received. Client should send visible_driver_snapshot only when the visible set changes.
 * - todayTotalViewed: Count of map_screen_opened + visible_driver_snapshot where this driver was in the set (no
 *   overcount from frequent refreshes).
 */
exports.getDriverAnalytics = async (req, res) => {
  try {
    // Normalize driverId to string so DB matches are consistent (URL may send number or string)
    const driverId = req.params.driverId != null ? String(req.params.driverId).trim() : '';
    const period = (req.query.period || 'week').toLowerCase();
    const fromQuery = req.query.from;
    const toQuery = req.query.to;

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'driverId is required',
        data: { hint: 'Provide a valid driver id in the path, e.g. GET /api/drivers/1017299105/analytics' }
      });
    }

    const now = new Date();
    let from = new Date(now);
    let to = new Date(now);

    if (fromQuery != null && toQuery != null) {
      from = new Date(fromQuery);
      to = new Date(toQuery);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date range',
          data: { hint: 'Use ISO 8601 dates for from and to query params' }
        });
      }
      if (from > to) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date range: from must be before or equal to to'
        });
      }
      const rangeDays = (to - from) / (24 * 60 * 60 * 1000);
      if (rangeDays > MAX_RANGE_DAYS) {
        return res.status(400).json({
          success: false,
          message: `Date range cannot exceed ${MAX_RANGE_DAYS} days`
        });
      }
    } else {
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      if (period === 'today') {
        // Today: from start of today 00:00 to now (for "Today" dashboard)
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        to = new Date(now);
      } else if (period === 'day') {
        from.setDate(from.getDate() - 1);
      } else if (period === 'week') {
        from.setDate(from.getDate() - 7);
      } else if (period === 'month') {
        from.setMonth(from.getMonth() - 1);
      }
    }

    const periodLabel = fromQuery != null && toQuery != null ? 'custom' : period;

    // Match when this driver is in params: single id (driver_id/driverId) or in array (driver_ids / initial_visible_driver_ids)
    const driverIdMatch = {
      $or: [
        { 'events.params.driver_id': driverId },
        { 'events.params.driverId': driverId },
        { 'events.params.driver_ids': driverId },
        { 'events.params.initial_visible_driver_ids': driverId }
      ]
    };

    // Map appearances: only map_screen_opened (once per session — no overcounting on refresh). See MAP_ANALYTICS_DESIGN.md.
    const mapAppearanceEventNames = ['map_screen_opened'];

    // All event names for interaction metrics + map_screen_opened and visible_driver_snapshot for todayTotalViewed
    const eventNames = [
      'map_screen_opened',
      'visible_driver_snapshot',
      'driver_marker_tapped',
      'driver_call_tapped',
      'driver_book_tapped_from_map',
      'driver_info_card_viewed',
      'driver_profile_opened_from_map',
      'driver_message_tapped',
      'driver_directions_tapped'
    ];

    const pipeline = [
      { $unwind: '$events' },
      {
        $addFields: {
          eventNameNorm: {
            $toLower: { $replaceAll: { input: { $ifNull: ['$events.eventName', ''] }, find: '-', replacement: '_' } }
          }
        }
      },
      {
        $match: {
          'events.clientTimestamp': { $gte: from, $lte: to, $ne: null },
          eventNameNorm: { $in: eventNames }
        }
      },
      {
        $facet: {
          mapAppearances: [
            {
              $match: {
                eventNameNorm: { $in: mapAppearanceEventNames },
                $or: [
                  { 'events.params.initial_visible_driver_ids': driverId },
                  { 'events.params.driver_ids': driverId },
                  { 'events.params.driver_id': driverId },
                  { 'events.params.driverId': driverId }
                ]
              }
            },
            { $count: 'total' }
          ],
          markerTaps: [
            { $match: { eventNameNorm: 'driver_marker_tapped', ...driverIdMatch } },
            { $count: 'total' }
          ],
          calls: [
            { $match: { eventNameNorm: 'driver_call_tapped', ...driverIdMatch } },
            { $count: 'total' }
          ],
          pickupRequests: [
            { $match: { eventNameNorm: 'driver_book_tapped_from_map', ...driverIdMatch } },
            { $count: 'total' }
          ],
          infoCardViews: [
            { $match: { eventNameNorm: 'driver_info_card_viewed', ...driverIdMatch } },
            { $count: 'total' }
          ],
          profileOpenedFromMap: [
            { $match: { eventNameNorm: 'driver_profile_opened_from_map', ...driverIdMatch } },
            { $count: 'total' }
          ],
          messageTaps: [
            { $match: { eventNameNorm: 'driver_message_tapped', ...driverIdMatch } },
            { $count: 'total' }
          ],
          directionsTapped: [
            { $match: { eventNameNorm: 'driver_directions_tapped', ...driverIdMatch } },
            { $count: 'total' }
          ]
        }
      }
    ];

    const collection = mongoose.connection.collection('user_app_analytics');
    const aggResults = await collection.aggregate(pipeline).toArray();
    const aggResult = aggResults[0] || {};

    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    // todayTotalViewed: only map_screen_opened + visible_driver_snapshot (no overcount from frequent refreshes)
    const todayViewEventNames = ['map_screen_opened', 'visible_driver_snapshot'];
    const todayPipeline = [
      { $unwind: '$events' },
      {
        $addFields: {
          eventNameNorm: {
            $toLower: { $replaceAll: { input: { $ifNull: ['$events.eventName', ''] }, find: '-', replacement: '_' } }
          }
        }
      },
      {
        $match: {
          'events.clientTimestamp': { $gte: todayStart, $lte: now, $ne: null },
          eventNameNorm: { $in: todayViewEventNames },
          $or: [
            { 'events.params.initial_visible_driver_ids': driverId },
            { 'events.params.driver_ids': driverId },
            { 'events.params.driver_id': driverId },
            { 'events.params.driverId': driverId }
          ]
        }
      },
      { $count: 'total' }
    ];
    const todayResult = await collection.aggregate(todayPipeline).toArray();
    const todayTotalViewed = getTotal(todayResult);

    // Total visibility duration: from user_app_analytics, per (sessionId) first→last visibility for this driver in period (approximate)
    const visibilityEventNames = ['map_screen_opened', 'visible_driver_snapshot', 'map_visible_drivers', 'map_viewport'];
    const durationPipeline = [
      { $unwind: '$events' },
      {
        $addFields: {
          eventNameNorm: {
            $toLower: { $replaceAll: { input: { $ifNull: ['$events.eventName', ''] }, find: '-', replacement: '_' } }
          }
        }
      },
      {
        $match: {
          'events.clientTimestamp': { $gte: from, $lte: to, $ne: null },
          eventNameNorm: { $in: visibilityEventNames },
          $or: [
            { 'events.params.initial_visible_driver_ids': driverId },
            { 'events.params.driver_ids': driverId },
            { 'events.params.driver_id': driverId },
            { 'events.params.driverId': driverId }
          ]
        }
      },
      {
        $group: {
          _id: '$sessionId',
          firstVisibleAt: { $min: '$events.clientTimestamp' },
          lastVisibleAt: { $max: '$events.clientTimestamp' }
        }
      },
      {
        $project: {
          durationMs: { $subtract: ['$lastVisibleAt', '$firstVisibleAt'] }
        }
      },
      {
        $group: {
          _id: null,
          totalMs: { $sum: '$durationMs' }
        }
      }
    ];
    const durationResult = await collection.aggregate(durationPipeline).toArray();
    const totalVisibilityDurationMs = durationResult[0] && typeof durationResult[0].totalMs === 'number' ? durationResult[0].totalMs : 0;
    const totalVisibilityDurationMinutes = Math.round(totalVisibilityDurationMs / (60 * 1000) * 10) / 10;
    const totalVisibilityDurationHours = Math.round((totalVisibilityDurationMs / (60 * 60 * 1000)) * 100) / 100;

    // Currently viewing: only count records updated in the last 30 seconds (ignore stale user_driver_map_views)
    const CURRENTLY_VIEWING_WINDOW_SECONDS = 30;
    const viewingCutoff = new Date(now.getTime() - CURRENTLY_VIEWING_WINDOW_SECONDS * 1000);
    let currentlyViewing = 0;
    try {
      currentlyViewing = await UserDriverMapView.countDocuments({
        driverId,
        lastSeen: { $gte: viewingCutoff }
      });
    } catch (e) {
      // TTL collection might not exist yet
    }

    res.status(200).json({
      success: true,
      data: {
        driverId,
        period: periodLabel,
        from: from.toISOString(),
        to: to.toISOString(),
        mapAppearances: getTotal(aggResult.mapAppearances),
        markerTaps: getTotal(aggResult.markerTaps),
        calls: getTotal(aggResult.calls),
        pickupRequests: getTotal(aggResult.pickupRequests),
        infoCardViews: getTotal(aggResult.infoCardViews),
        profileOpenedFromMap: getTotal(aggResult.profileOpenedFromMap),
        messageTaps: getTotal(aggResult.messageTaps),
        directionsTapped: getTotal(aggResult.directionsTapped),
        todayTotalViewed,
        currentlyViewing,
        totalVisibilityDurationMs,
        totalVisibilityDurationMinutes,
        totalVisibilityDurationHours
      },
      meta: {
        description: 'mapAppearances = map_screen_opened only (once per session, no overcounting). todayTotalViewed = map_screen_opened + visible_driver_snapshot. currentlyViewing = active search live (TTL). totalVisibilityDuration* = how many ms/min/hours this driver was visible on users\' maps in the period (approximate, from first→last event per session). See MAP_ANALYTICS_DESIGN.md.'
      }
    });
  } catch (error) {
    console.error('[driver-analytics] Error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get driver analytics'
    });
  }
};
