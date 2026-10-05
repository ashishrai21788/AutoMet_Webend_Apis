/**
 * Outgoing email, behind one small interface so the provider can be chosen (or changed) without touching the callers.
 *
 *   EMAIL_PROVIDER=resend  RESEND_API_KEY=...  EMAIL_FROM="AutoMet <no-reply@yourdomain>"
 *
 * With no provider configured nothing is sent: `sendMail` returns { sent: false, reason: 'not-configured' } and the
 * caller carries on (a password-reset request still answers the same way, so the response never reveals whether an email
 * is configured or an account exists). Message bodies are never logged. Tests and other providers install a transport
 * with `setTransport({ send({ to, subject, text }) })`.
 */
let transport = null;

function setTransport(next) {
  transport = next;
}

function resendTransport(env) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  return {
    name: 'resend',
    async send({ to, subject, text, attachments }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, ...(attachments && attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) } : {}) })
      });
      if (!res.ok) throw new Error(`Email provider answered ${res.status}`);
    }
  };
}

function activeTransport(env = process.env) {
  if (transport) return transport;
  if (String(env.EMAIL_PROVIDER || '').toLowerCase() === 'resend') return resendTransport(env);
  return null;
}

const isConfigured = (env = process.env) => !!activeTransport(env);

/** Never throws: a failed send is reported to the caller, which decides what to tell the person. */
async function sendMail({ to, subject, text, attachments }) {
  const t = activeTransport();
  if (!t) return { sent: false, reason: 'not-configured' };
  try {
    await t.send({ to, subject, text, attachments });
    return { sent: true };
  } catch (e) {
    console.warn('[mailer] send failed:', e.message);
    return { sent: false, reason: 'failed' };
  }
}

module.exports = { setTransport, isConfigured, sendMail };
