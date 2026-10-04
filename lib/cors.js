/**
 * CORS for browsers. The mobile apps and server-to-server callers send no Origin header and are not affected; only
 * web pages are limited to the origins listed here. Set CORS_ALLOWED_ORIGINS (comma separated) to add the dashboards.
 */
const DEFAULT_ORIGINS = [
  'https://auto-met-admin.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

function allowedOrigins(env = process.env) {
  const extra = String(env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function corsMiddleware(env = process.env) {
  const allowed = allowedOrigins(env);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.vary('Origin');
      if (allowed.has(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
      }
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    // a browser page can only read these response headers when they are listed (the dashboard's CSV downloads use them)
    res.header('Access-Control-Expose-Headers', 'Content-Disposition, X-Row-Count, X-Truncated, Retry-After');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Pragma, X-App-Id');
    // a preflight from a page that is not allowed gets no Allow-Origin header, so the browser refuses the real request
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

module.exports = { corsMiddleware, allowedOrigins, DEFAULT_ORIGINS };
