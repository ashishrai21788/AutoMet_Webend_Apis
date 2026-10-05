/**
 * Overdue handling for the platform's own invoices, run on a schedule (see startBillingScheduler) and on demand from
 * Platform Settings ("Run now").
 *
 *  - Reminders: for each unpaid invoice, an email to the business at the offsets in `reminderOffsets` (days relative to the
 *    due date: -3 is three days before, 7 is a week after). Only the latest offset that has been reached is sent, so a
 *    long outage never produces a burst; earlier ones are marked as covered. Nothing is marked sent unless the email was
 *    sent, so reminders start the moment an email provider is configured.
 *  - Lapse: an invoice more than `graceDays` past due is "lapsed" once. `lapseAction` decides what happens to the business:
 *    'none' (default, only flagged and audited), 'cancel' (its subscription is cancelled), or 'suspend' (the business is
 *    suspended: its admins are signed out and its apps stop). The default business is never suspended.
 *  - Every action is written to the platform audit log with the actor "billing-job".
 * It is safe to run more than once: each reminder and each lapse happens at most once per invoice.
 */
const DAY = 86400000;

const bodyFor = ({ invoice, settings, business, daysFromDue }) => {
  const when = daysFromDue < 0 ? `due in ${-daysFromDue} day${daysFromDue === -1 ? '' : 's'}` : daysFromDue === 0 ? 'due today' : `${daysFromDue} day${daysFromDue === 1 ? '' : 's'} overdue`;
  const due = new Date(invoice.dueDate).toISOString().slice(0, 10);
  return {
    subject: daysFromDue > 0 ? `Overdue: invoice ${invoice.number}` : `Reminder: invoice ${invoice.number} is ${when}`,
    text: `Hello,\n\nInvoice ${invoice.number} for ${business.name} (total ${invoice.currency} ${invoice.total ?? invoice.amount}) is ${when}. It was due on ${due}.\n\n${settings.invoiceNotes ? `${settings.invoiceNotes}\n\n` : ''}If you have already paid, please ignore this message and send us the payment reference.\n\n${settings.companyName || settings.legalName || ''}`.trim()
  };
};

async function recipientFor(tenant, AdminUser) {
  const d = tenant.billingDetails;
  if (d && d.email) return d.email;
  const admin = await AdminUser.findOne({ tenantId: tenant.tenantId, role: 'client_admin', active: true }).sort({ createdAt: 1 }).lean();
  return admin ? admin.email : null;
}

/**
 * `deps`: { PlatformInvoice, Tenant, AdminUser, AdminAudit, mailer, settings, now }.
 * Returns counts: { reminded, skipped, lapsed, actions: [...] }.
 */
async function runBillingCycle({ PlatformInvoice, Tenant, AdminUser, AdminAudit, mailer, settings, now = new Date() }) {
  const offsets = [...new Set((settings.reminderOffsets || []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  const grace = Number.isInteger(settings.graceDays) ? settings.graceDays : 15;
  const action = settings.lapseAction || 'none';
  const result = { reminded: 0, skipped: 0, lapsed: 0, actions: [] };

  const audit = (a, targetId, meta) => AdminAudit.create({ tenantId: null, actorId: null, actorEmail: 'billing-job', action: a, targetType: 'invoice', targetId, meta, ip: null }).catch(() => {});

  const open = await PlatformInvoice.find({ status: 'issued' }).lean();
  for (const inv of open) {
    if (!inv.dueDate) continue;
    const tenant = await Tenant.findOne({ tenantId: inv.tenantId });
    if (!tenant) continue;
    const daysFromDue = Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / DAY);

    // reminders
    const sent = inv.remindersSent || [];
    const reached = offsets.filter((o) => o <= daysFromDue && !sent.includes(o));
    if (reached.length && tenant.status !== 'suspended') {
      const to = await recipientFor(tenant, AdminUser);
      const latest = reached[reached.length - 1];
      if (!to) { result.skipped += 1; }
      else {
        const msg = bodyFor({ invoice: inv, settings, business: tenant, daysFromDue });
        const r = await mailer.sendMail({ to, subject: msg.subject, text: msg.text });
        if (r.sent) {
          await PlatformInvoice.findOneAndUpdate({ invoiceId: inv.invoiceId, status: 'issued' }, { $set: { remindersSent: [...new Set([...sent, ...reached])] } });
          await audit('invoice.reminder_sent', inv.invoiceId, { number: inv.number, business: inv.tenantId, offset: latest });
          result.reminded += 1;
        } else result.skipped += 1;
      }
    }

    // lapse
    if (daysFromDue > grace && !inv.lapsedAt) {
      const claimed = await PlatformInvoice.findOneAndUpdate({ invoiceId: inv.invoiceId, status: 'issued', lapsedAt: null }, { $set: { lapsedAt: now } }, { new: true });
      if (!claimed) continue;
      let applied = 'flagged';
      if (action === 'cancel' && tenant.subscription && tenant.subscription.status !== 'cancelled') {
        tenant.subscription = { ...(typeof tenant.subscription.toObject === 'function' ? tenant.subscription.toObject() : tenant.subscription), status: 'cancelled', cancelledAt: now, cancelReason: `Invoice ${inv.number} unpaid ${daysFromDue} days after its due date` };
        await tenant.save();
        applied = 'subscription-cancelled';
      } else if (action === 'suspend' && !tenant.isDefault && tenant.status !== 'suspended') {
        tenant.status = 'suspended';
        await tenant.save();
        await AdminUser.updateMany({ tenantId: tenant.tenantId }, { $inc: { tokenVersion: 1 } });
        applied = 'business-suspended';
      }
      await audit('invoice.lapsed', inv.invoiceId, { number: inv.number, business: inv.tenantId, daysOverdue: daysFromDue, result: applied });
      result.lapsed += 1;
      result.actions.push({ invoice: inv.number, business: inv.tenantId, result: applied });
    }
  }
  return result;
}

/**
 * Runs every `everyMs` (default 6 hours) and shortly after start-up. With more than one server instance the claim on
 * `lastRunAt` in the settings document lets only one of them run each cycle.
 */
function startBillingScheduler({ run, claim, everyMs = 6 * 60 * 60 * 1000, firstDelayMs = 90 * 1000 }) {
  const tick = async () => {
    try {
      if (!(await claim(everyMs - 60 * 1000))) return;
      const r = await run();
      if (r.reminded || r.lapsed) console.log(`[billing] reminders sent: ${r.reminded}, lapsed: ${r.lapsed}`);
    } catch (e) { console.warn('[billing] scheduled run failed:', e.message); }
  };
  const first = setTimeout(tick, firstDelayMs);
  const timer = setInterval(tick, everyMs);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = { runBillingCycle, startBillingScheduler, recipientFor, DAY };
