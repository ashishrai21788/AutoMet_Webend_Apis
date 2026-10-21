/**
 * Legal documents, the apps' side.
 *
 *   GET  /api/v1/public/legal?audience=rider|driver     the documents in force (titles, versions, links); no sign-in
 *   GET  /api/v1/public/legal/:type                     one document in force with its text; no sign-in
 *   GET  /legal/:appId/:type                            the same as a public web page (the address for the Play Store listing)
 *   GET  /api/v1/legal/pending                          what the signed-in rider or driver still has to agree to
 *   POST /api/v1/legal/accept                           { type, version }: record that they agreed
 *
 * A business that has published nothing for a type gets "no document": the apps then show the text built into them.
 */
const { LegalDocument, LegalAcceptance } = require('../models/legalModel');
const { tenantById } = require('../lib/appTenant');
const legal = require('../lib/legal');

const publishedOf = (tenantId) => LegalDocument.find({ tenantId, status: 'PUBLISHED' }).lean();
const baseUrlOf = (req) => `${req.protocol}://${req.get('host')}`;

exports.list = async (req, res) => {
  try {
    const tenant = req.appTenant;
    if (!tenant) return res.status(404).json({ success: false, message: 'No business is set up yet', data: null });
    const audience = ['rider', 'driver'].includes(String(req.query.audience)) ? String(req.query.audience) : null;
    const docs = [...legal.inForce(await publishedOf(tenant.tenantId)).values()].filter((d) => legal.forAudience(d.type, audience));
    const items = docs.map((d) => legal.publicView(d, { baseUrl: baseUrlOf(req), appId: tenant.tenantId })).sort((a, b) => a.type.localeCompare(b.type));
    res.set('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ success: true, message: 'OK', data: { items } });
  } catch (e) {
    console.error('[legal list]', e.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', data: null });
  }
};

exports.one = async (req, res) => {
  try {
    const tenant = req.appTenant;
    if (!tenant) return res.status(404).json({ success: false, message: 'No business is set up yet', data: null });
    const type = String(req.params.type || '').toUpperCase();
    if (!legal.TYPES[type]) return res.status(404).json({ success: false, message: 'Unknown document', data: null });
    const doc = legal.inForce(await publishedOf(tenant.tenantId)).get(type);
    if (!doc) return res.status(404).json({ success: false, message: 'This business has not published that document yet', data: null });
    const body = legal.publicView(doc, { baseUrl: baseUrlOf(req), appId: tenant.tenantId, full: true });
    const etag = `"${body.fingerprint}"`;
    res.set({ ETag: etag, 'Cache-Control': 'public, max-age=60' });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.status(200).json({ success: true, message: 'OK', data: body });
  } catch (e) {
    console.error('[legal one]', e.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', data: null });
  }
};

/** The web page. Outside /api, so it looks the business up by the id in the address. */
exports.page = async (req, res) => {
  try {
    const type = String(req.params.type || '').toUpperCase();
    const tenant = legal.TYPES[type] ? await tenantById(String(req.params.appId)).catch(() => null) : null;
    const doc = tenant ? legal.inForce(await publishedOf(tenant.tenantId)).get(type) : null;
    res.set({ 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
    if (!doc) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title><body style="font-family:system-ui;padding:32px"><h1>Document not found</h1><p>This document has not been published.</p></body>');
    res.set('Cache-Control', 'public, max-age=300');
    return res.type('html').send(legal.renderPage(tenant.name || tenant.appName || '', doc));
  } catch (e) {
    console.error('[legal page]', e.message);
    return res.status(500).type('text').send('Something went wrong.');
  }
};

/** Which side the signed-in account is on, and the business it belongs to. */
function actorOf(req) {
  const role = req.authRole === 'driver' ? 'driver' : req.authRole === 'user' ? 'rider' : null;
  return role ? { role, accountId: req.authActorId } : null;
}

exports.pending = async (req, res) => {
  try {
    const who = actorOf(req);
    const tenant = req.appTenant;
    if (!who || !tenant) return res.status(403).json({ success: false, message: 'Not allowed', data: null });
    const [docs, accepted] = await Promise.all([
      publishedOf(tenant.tenantId),
      LegalAcceptance.find({ tenantId: tenant.tenantId, role: who.role, accountId: who.accountId }).lean()
    ]);
    const items = legal.pendingConsents(docs, accepted, who.role).map((d) => legal.publicView(d, { baseUrl: baseUrlOf(req), appId: tenant.tenantId }));
    return res.status(200).json({ success: true, message: 'OK', data: { items } });
  } catch (e) {
    console.error('[legal pending]', e.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', data: null });
  }
};

exports.accept = async (req, res) => {
  try {
    const who = actorOf(req);
    const tenant = req.appTenant;
    if (!who || !tenant) return res.status(403).json({ success: false, message: 'Not allowed', data: null });
    const type = String((req.body && req.body.type) || '').toUpperCase();
    const version = Number(req.body && req.body.version);
    if (!legal.TYPES[type] || !legal.forAudience(type, who.role) || !Number.isInteger(version)) return res.status(400).json({ success: false, message: 'Choose a document and its version', data: null });
    const current = legal.inForce(await publishedOf(tenant.tenantId)).get(type);
    // only the version in force can be agreed to: a stale screen cannot record consent to text that has been replaced
    if (!current || current.version !== version) return res.status(409).json({ success: false, message: 'That document has changed. Please read the new version.', data: { current: current ? current.version : null } });
    try {
      await LegalAcceptance.create({ tenantId: tenant.tenantId, role: who.role, accountId: who.accountId, type, version, at: new Date(), ip: req.ip || null });
    } catch (e) { if (!(e && e.code === 11000)) throw e; } // agreeing twice records it once
    return res.status(200).json({ success: true, message: 'Thank you', data: { type, version } });
  } catch (e) {
    console.error('[legal accept]', e.message);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', data: null });
  }
};
