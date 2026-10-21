/**
 * Legal documents: which types exist and who they are for, turning the plain text a business writes into safe HTML, picking the
 * document in force, working out what an account still has to agree to, and the public page.
 */
const crypto = require('crypto');

/** The document types. `audience` says which app shows it; `suggestConsent` is only a default for the editor. */
const TYPES = {
  PRIVACY_POLICY: { label: 'Privacy Policy', audience: ['rider', 'driver'], suggestConsent: true },
  TERMS_RIDER: { label: 'Rider Terms and Conditions', audience: ['rider'], suggestConsent: true },
  TERMS_DRIVER: { label: 'Driver Terms and Conditions', audience: ['driver'], suggestConsent: true },
  LOCATION_DISCLOSURE: { label: 'Location Data Disclosure', audience: ['rider', 'driver'], suggestConsent: false },
  ACCOUNT_DELETION: { label: 'Account Deletion Policy', audience: ['rider', 'driver'], suggestConsent: false },
  CANCELLATION_REFUND: { label: 'Cancellation and Refund Policy', audience: ['rider'], suggestConsent: false }
};
const TYPE_KEYS = Object.keys(TYPES);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Plain text to HTML: everything is escaped first, so nothing a business types can run as markup. A blank line starts a new
 * paragraph, "# " makes a heading, "- " or "* " lines make a bullet list, and single line breaks inside a paragraph stay.
 */
function textToHtml(text) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split('\n');
    if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0])) return `<b>${esc(lines[0].replace(/^#{1,3}\s+/, ''))}</b>`;
    if (lines.every((l) => /^[-*]\s+/.test(l))) return lines.map((l) => `&bull; ${esc(l.replace(/^[-*]\s+/, ''))}`).join('<br>');
    return lines.map((l) => (/^#{1,3}\s+/.test(l) ? `<b>${esc(l.replace(/^#{1,3}\s+/, ''))}</b>` : esc(l))).join('<br>');
  }).join('<br><br>');
}

/** The published version in force at `now` for each type: the latest effective date that has started. */
function inForce(docs, now = new Date()) {
  const best = new Map();
  for (const d of docs) {
    if (d.status !== 'PUBLISHED' || !d.effectiveAt || new Date(d.effectiveAt) > now) continue;
    const cur = best.get(d.type);
    if (!cur || new Date(d.effectiveAt) > new Date(cur.effectiveAt) || (new Date(d.effectiveAt).getTime() === new Date(cur.effectiveAt).getTime() && d.version > cur.version)) best.set(d.type, d);
  }
  return best;
}

const forAudience = (type, audience) => !!TYPES[type] && (!audience || TYPES[type].audience.includes(audience));

/** A short fingerprint of what the app shows, so an app can tell its copy is current. */
const fingerprint = (d) => crypto.createHash('sha1').update(`${d.type}|${d.version}|${d.title}|${d.content}`).digest('hex').slice(0, 12);

/** What the apps receive for a document (the list leaves the text out; the single document includes it). */
function publicView(d, { baseUrl = '', appId = '', full = false } = {}) {
  const out = {
    type: d.type, title: d.title, version: d.version, effectiveAt: d.effectiveAt, consentRequired: !!d.consentRequired,
    url: baseUrl && appId ? `${baseUrl}/legal/${encodeURIComponent(appId)}/${d.type}` : null, fingerprint: fingerprint(d)
  };
  if (full) { out.content = d.content; out.html = textToHtml(d.content); }
  return out;
}

/** The documents an account still has to agree to: required, in force, for its audience, and not yet accepted at that version. */
function pendingConsents(docs, accepted, audience, now = new Date()) {
  const done = new Set(accepted.map((a) => `${a.type}|${a.version}`));
  return [...inForce(docs, now).values()].filter((d) => d.consentRequired && forAudience(d.type, audience) && !done.has(`${d.type}|${d.version}`));
}

/** The public page for one document: plain HTML, no scripts, readable on a phone. */
function renderPage(business, d) {
  const when = d.effectiveAt ? new Date(d.effectiveAt).toISOString().slice(0, 10) : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.title)} | ${esc(business)}</title>
<style>:root{--ink:#0F172A;--mut:#475569;--bg:#F6F8F7;--card:#fff;--line:#E5E7EB}@media(prefers-color-scheme:dark){:root{--ink:#F1F5F9;--mut:#A8B3C5;--bg:#0B1220;--card:#111A2C;--line:#273244}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:760px;margin:0 auto;padding:24px 16px 56px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px}h1{font-size:24px;margin:0 0 4px}small{color:var(--mut)}</style></head>
<body><main><h1>${esc(d.title)}</h1><small>${esc(business)} &middot; Version ${d.version}${when ? ` &middot; In force from ${when}` : ''}</small>
<div class="card" style="margin-top:16px">${textToHtml(d.content)}</div></main></body></html>`;
}

module.exports = { TYPES, TYPE_KEYS, textToHtml, inForce, forAudience, publicView, pendingConsents, renderPage, fingerprint };
