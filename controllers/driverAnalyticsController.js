const mongoose = require('mongoose');
const UserDriverMapView = require('../models/userDriverMapViewModel');

function getTotal(facetResult) {
  return facetResult && facetResult[0] && typeof facetResult[0].total === 'number' ? facetResult[0].total : 0;
}

/**
 * GET /api/drivers/:driverId/analytics
 * Aggregate driver analytics from user_app_analytics + todayTotalViewed + currentlyViewing from user_driver_map_views
 */
exports.getDriverAnalytics = async (req, res) => {
  try {
    const driverId = req.params.driverId;
    const period = req.query.period || 'week';
    const fromQuery = req.query.from;
    const toQuery = req.query.to;

    if (!driverId || String(driverId).trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'driverId is required'
      });
    }

    const now = new Date();
    let from = new Date(now);
    let to = new Date(now);

    if (fromQuery && toQuery) {
      from = new Date(fromQuery);
      to = new Date(toQuery);
    } else {
      from.setHours(0, 0, 0, 0);
      if (period === 'day') {
        from.setDate(from.getDate() - 1);
      } else if (period === 'week') {
        from.setDate(from.getDate() - 7);
      } else if (period === 'month') {
        from.setMonth(from.getMonth() - 1);
      }
    }

    const periodLabel = fromQuery && toQuery ? 'custom' : period;

    // Match when this driver is in params: single id (driver_id/driverId) or in array (driver_ids)
    const driverIdMatch = {
      $or: [
        { 'events.params.driver_id': driverId },
        { 'events.params.driverId': driverId },
        { 'events.params.driver_ids': driverId } // array contains driverId
      ]
    };

    // Normalize event name for case/hyphen-insensitive matching (client may send Driver_Marker_Tapped or driver-marker-tapped)
    const eventNames = [
      'map_drivers_loaded',
      'map_visible_drivers',
      'map_viewport',
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
          'events.clientTimestamp': { $gte: from, $lte: to },
          eventNameNorm: { $in: eventNames }
        }
      },
      {
        $facet: {
          mapAppearances: [
            {
              $match: {
                eventNameNorm: { $in: ['map_drivers_loaded', 'map_visible_drivers', 'map_viewport'] },
                $or: [
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
          'events.clientTimestamp': { $gte: todayStart, $lte: now },
          eventNameNorm: { $in: ['map_drivers_loaded', 'map_visible_drivers', 'map_viewport'] },
          $or: [
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

    let currentlyViewing = 0;
    try {
      currentlyViewing = await UserDriverMapView.countDocuments({ driverId });
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
        currentlyViewing
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
