const crypto = require('crypto');
const UserAppAnalytics = require('../models/userAppAnalyticsModel');

function generateEventId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Save user app analytics events to MongoDB (collection: user_app_analytics)
 * Accepts app format: events[].event, events[].properties, events[].timestamp (or eventName, params, clientTimestamp).
 * Top-level: deviceId (required), events (required). sessionId, appId, source defaulted if missing. platform from os or platform.
 */
exports.saveAnalytics = async (req, res) => {
  try {
    const body = req.body || {};
    const events = body.events;
    const deviceId = body.deviceId ?? body.device_id;
    const sessionId = body.sessionId ?? body.session_id ?? deviceId;
    const appId = body.appId ?? body.app_id ?? 'in.automet.user';
    const appVersion = body.appVersion ?? body.app_version;
    const platform = body.platform ?? body.os;
    const source = body.source ?? 'user_app';

    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request body is empty or invalid. Send JSON with Content-Type: application/json',
        data: { hint: 'Required: { events: [...], deviceId }. Optional: sessionId, appId, source, platform, os.' }
      });
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'events must be a non-empty array',
        data: { missingFields: { events: true }, hint: 'Required: { events: [...], deviceId }.' }
      });
    }

    const hasDeviceId = deviceId != null && String(deviceId).trim() !== '';
    if (!hasDeviceId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: deviceId',
        data: { missingFields: { deviceId: true }, hint: 'Required: { events: [...], deviceId }.' }
      });
    }

    const sessionIdStr = String(sessionId ?? deviceId).trim();
    const appIdStr = String(appId).trim();
    const sourceStr = String(source).trim();
    const platformStr = platform != null ? String(platform).trim() : null;

    // Store deviceId, sessionId, appId, source, platform, appVersion only at document level (no duplication in each event)
    const normalizedEvents = events.map((evt) => {
      const raw = { ...evt };
      const event = {};
      event.eventName = raw.eventName ?? raw.event ?? 'unknown';
      event.params = raw.params ?? raw.properties ?? {};
      event.clientTimestamp = (raw.clientTimestamp || raw.timestamp) ? new Date(raw.clientTimestamp || raw.timestamp) : null;
      event.eventId = (raw.eventId && String(raw.eventId).trim()) ? String(raw.eventId).trim() : generateEventId();
      event.eventCategory = (raw.eventCategory && String(raw.eventCategory).trim()) ? String(raw.eventCategory).trim() : 'user';
      event.actorId = raw.actorId ?? raw.actor_id ?? null;
      event.actorType = raw.actorType ?? raw.actor_type ?? 'user';
      event.pageIdentifier = raw.pageIdentifier ?? raw.page_identifier ?? null;
      event.metadata = raw.metadata ?? {};
      // Do not duplicate: appId, deviceId, sessionId, source, platform, appVersion stay at document level only
      return event;
    });

    const doc = new UserAppAnalytics({
      events: normalizedEvents,
      deviceId: String(deviceId).trim(),
      sessionId: sessionIdStr,
      appId: appIdStr,
      appVersion: appVersion != null ? String(appVersion).trim() : null,
      platform: platformStr,
      source: sourceStr
    });

    const saved = await doc.save();
    if (process.env.NODE_ENV === 'development') {
      console.log('[user-app-analytics] Saved', saved._id, 'events:', saved.events.length);
    }

    return res.status(201).json({
      success: true,
      message: 'Analytics events saved successfully',
      data: {
        id: saved._id,
        eventsCount: saved.events.length,
        deviceId: saved.deviceId,
        sessionId: saved.sessionId,
        appId: saved.appId,
        createdAt: saved.createdAt
      }
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[user-app-analytics] Save error:', error.message, error.name);
    }
    if (error.name === 'ValidationError') {
      const validationErrors = {};
      if (error.errors) {
        Object.keys(error.errors).forEach((key) => {
          validationErrors[key] = error.errors[key].message;
        });
      }
      return res.status(400).json({
        success: false,
        message: error.message,
        data: { validationErrors }
      });
    }
    throw error;
  }
};
