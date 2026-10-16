/**
 * The rider's invoice as a PDF (pdfkit, no browser). Printed from the stored invoice snapshot only, and laid out like the
 * app's ride details screen: business, invoice, rider, driver and vehicle, route with times, trip size, the fare line by
 * line, the total and how it was paid. Standard PDF fonts have no rupee sign, so amounts read "Rs.".
 */
const PDFDocument = require('pdfkit');
const { STATES } = require('./gst');

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const BAND = '#F3F4F6';
const ACCENT = '#1F2937';
const GREEN = '#15803D';

const money = (minor, currency, digits) => {
  const amount = Number(minor || 0) / 10 ** (digits == null ? 2 : digits);
  const sign = amount < 0 ? '-' : '';
  const body = Math.abs(amount).toLocaleString('en-IN', { minimumFractionDigits: digits == null ? 2 : digits, maximumFractionDigits: digits == null ? 2 : digits });
  return `${sign}${currency === 'INR' || !currency ? 'Rs.' : `${currency} `}${body}`;
};
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '');
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
const clock = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toUpperCase() : '');
const title = (s) => String(s || '').toLowerCase().replace(/(^|[\s_-])\w/g, (m) => m.toUpperCase()).replace(/_/g, ' ');
const payment = (m) => (m === 'CASH' ? 'Cash, paid to the driver' : title(m));

function renderRiderInvoice(inv, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const biz = inv.business || {};
    const t = inv.trip || {};
    const drv = inv.driver || {};
    const cancelled = inv.type === 'CANCELLATION';
    const taxed = (inv.taxMinor || 0) > 0;
    const doc = new PDFDocument({ size: 'A4', margin: 40, compress, info: { Title: `Invoice ${inv.invoiceNumber}`, Author: biz.legalName || biz.name || 'Invoice' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 40;
    const right = doc.page.width - 40;
    const width = right - left;
    const cur = inv.currency;
    const dg = inv.currencyDigits;
    const text = (s, x, y, o = {}) => doc.text(String(s), x, y, o);

    // ---- header band: the business on the left, the document on the right
    doc.rect(0, 0, doc.page.width, 104).fill(ACCENT);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(20).text(biz.name || biz.legalName || 'Invoice', left, 28, { width: width * 0.6 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#D1D5DB');
    const bizLines = [];
    if (biz.legalName && biz.legalName !== biz.name) bizLines.push(biz.legalName);
    if (biz.address) bizLines.push(biz.address);
    if (biz.gstin) bizLines.push(`GSTIN ${biz.gstin}${biz.stateCode && STATES[biz.stateCode] ? `  |  ${STATES[biz.stateCode]} (${biz.stateCode})` : ''}`);
    doc.text(bizLines.join('\n'), left, doc.y + 2, { width: width * 0.6 });
    const heading = cancelled ? 'CANCELLATION INVOICE' : taxed ? 'TAX INVOICE' : 'INVOICE';
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#FFFFFF').text(heading, left + width * 0.55, 28, { width: width * 0.45, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#D1D5DB');
    let my = 52;
    for (const [k, v] of [['Invoice no.', inv.invoiceNumber], ['Invoice date', day(inv.issuedAt)], ['Trip no.', inv.tripId]]) {
      doc.fillColor('#D1D5DB').font('Helvetica').text(k, left + width * 0.5, my, { width: width * 0.2, align: 'right' });
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').text(String(v), left + width * 0.72, my, { width: width * 0.28, align: 'right' });
      my += 14;
    }

    // ---- status line, like the ride details header
    let y = 122;
    const statusText = cancelled ? `Ride cancelled${t.cancelledBy ? ` by ${title(t.cancelledBy)}` : ''}` : 'Ride completed';
    const when1 = when(t.completedAt);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(cancelled ? '#B45309' : GREEN).text(statusText, left, y, { width: width * 0.6, continued: false });
    if (when1) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(when1, left + width * 0.6, y + 3, { width: width * 0.4, align: 'right' });
    y = doc.y + 12;

    // ---- two cards: billed to / driver & vehicle
    const gap = 14;
    const cw = (width - gap) / 2;
    const card = (x, label, rows) => {
      const h = 22 + rows.reduce((s, r) => s + (r.big ? 18 : 15), 0) + 8;
      doc.roundedRect(x, y, cw, h, 6).lineWidth(0.8).strokeColor(LINE).stroke();
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(label, x + 12, y + 10, { characterSpacing: 0.8 });
      let ry = y + 24;
      for (const r of rows) {
        if (r.big) doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(r.v, x + 12, ry, { width: cw - 24 });
        else {
          doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(r.k, x + 12, ry, { width: 56 });
          doc.font('Helvetica').fontSize(9).fillColor(INK).text(r.v, x + 70, ry, { width: cw - 82 });
        }
        ry += r.big ? 18 : 15;
      }
      return h;
    };
    const billed = [{ big: true, v: (inv.rider && inv.rider.name) || 'Rider' }];
    if (inv.rider && inv.rider.phoneMasked) billed.push({ k: 'Phone', v: inv.rider.phoneMasked });
    if (t.rideType) billed.push({ k: 'Ride type', v: title(t.rideType) });
    billed.push({ k: 'Payment', v: payment(inv.paymentMode) });
    const dr = [];
    if (drv.name) dr.push({ big: true, v: drv.name + (drv.rating ? `   (${Number(drv.rating).toFixed(1)} / 5)` : '') });
    if (drv.vehicleModel) dr.push({ k: 'Vehicle', v: drv.vehicleModel });
    if (drv.vehicleNumber) dr.push({ k: 'Plate', v: drv.vehicleNumber });
    const extra = [drv.vehicleColour, drv.seats ? `${drv.seats} seater` : '', drv.fuelType].filter(Boolean).join('  |  ');
    if (extra) dr.push({ k: 'Details', v: extra });
    if (!dr.length) dr.push({ k: 'Driver', v: 'Not assigned' });
    const h1 = card(left, 'BILLED TO', billed);
    const h2 = card(left + cw + gap, 'DRIVER & VEHICLE', dr);
    y += Math.max(h1, h2) + 14;

    // ---- route with times
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('ROUTE', left, y, { characterSpacing: 0.8 });
    y += 14;
    const stop = (dot, label, addr, time) => {
      doc.circle(left + 5, y + 6, 4).fill(dot);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(label, left + 18, y, { width: 50 });
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(addr || '-', left + 70, y, { width: width - 150 });
      if (time) doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(time, right - 70, y, { width: 70, align: 'right' });
      y = Math.max(doc.y, y + 14) + 6;
    };
    const pickupTime = cancelled ? clock(t.requestedAt) : clock(t.startedAt);
    const dropTime = cancelled ? '' : clock(t.completedAt);
    stop('#16A34A', 'PICKUP', t.pickup, pickupTime);
    doc.moveTo(left + 5, y - 14).lineTo(left + 5, y - 5).lineWidth(1).strokeColor(LINE).stroke();
    stop('#DC2626', 'DROP', t.drop, dropTime);
    y += 4;

    // ---- trip size (distance, duration, type) like the stats row
    if (!cancelled) {
      const stats = [['Distance', t.distanceKm != null ? `${Number(t.distanceKm).toFixed(1)} km` : '-'], ['Duration', t.durationMin ? `${t.durationMin} min` : '-'], ['Ride type', title(t.rideType) || '-']];
      doc.rect(left, y, width, 38).fill(BAND);
      const sw = width / stats.length;
      stats.forEach(([k, v], i) => {
        doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(k, left + i * sw, y + 8, { width: sw, align: 'center' });
        doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(v, left + i * sw, y + 20, { width: sw, align: 'center' });
      });
      y += 38 + 16;
    } else {
      y += 6;
    }

    // ---- fare table
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('FARE BREAKUP', left, y, { characterSpacing: 0.8 });
    y += 14;
    doc.rect(left, y, width, 20).fill(BAND);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text('Description', left + 10, y + 6).text('Amount', left, y + 6, { width: width - 10, align: 'right' });
    y += 20;
    (inv.lines || []).forEach((l) => {
      doc.font('Helvetica').fontSize(10).fillColor(l.kind === 'DISCOUNT' ? GREEN : INK).text(l.label, left + 10, y + 7, { width: width * 0.7 });
      doc.text(money(l.amountMinor, cur, dg), left, y + 7, { width: width - 10, align: 'right' });
      y += 26;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
    });
    if (taxed) {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Amount before tax', left + 10, y + 8).text(money(inv.subtotalMinor, cur, dg), left, y + 8, { width: width - 10, align: 'right' });
      y += 24;
    }
    y += 6;
    doc.rect(left, y, width, 32).fill(ACCENT);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF').text(cancelled ? 'Total charged' : 'Total paid', left + 10, y + 10).text(money(inv.totalMinor, cur, dg), left, y + 9, { width: width - 10, align: 'right' });
    y += 32 + 8;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`Paid via ${payment(inv.paymentMode)}`, left, y, { width, align: 'right' });
    y = doc.y + 24;

    // ---- footer
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
    y += 8;
    const contact = [biz.supportPhone, biz.supportEmail].filter(Boolean).join('  |  ');
    if (contact) { doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(`Questions about this invoice? ${contact}`, left, y, { width, align: 'center' }); y = doc.y + 4; }
    doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF').text(`Thank you for riding with ${biz.name || 'us'}. This is a computer-generated invoice and needs no signature.`, left, y, { width, align: 'center' });
    doc.end();
  });
}

module.exports = { renderRiderInvoice, money };
