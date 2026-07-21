/**
 * Marks legacy ride endpoints. Clients should migrate to /api/v1/trips/* and /api/v1/rides/* (non ride-actions).
 */
function deprecateLegacyRideApi(successorPath, label) {
  return (req, res, next) => {
    res.set('Deprecation', 'true');
    res.set('Sunset', '2026-12-31');
    if (successorPath) {
      res.set('Link', `<${successorPath}>; rel="successor-version"`);
    }
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[deprecated]', label || req.originalUrl, '→', successorPath || 'see AUTOMET_RIDE_HARDENING_PLAN.md');
    }
    next();
  };
}

module.exports = { deprecateLegacyRideApi };
