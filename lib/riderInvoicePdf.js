/**
 * The rider's invoice as a PDF (pdfkit, no browser). Printed from the stored invoice snapshot only. Standard PDF fonts have
 * no rupee sign, so amounts read "Rs.".
 */
const PDFDocument = require('pdfkit');
const { STATES } = require('./gst');

const money = (minor, currency, digits) => {
  const amount = Number(minor || 0) / 10 ** (digits == null ? 2 : digits);
  const sign = amount < 0 ? '-' : '';
  const body = Math.abs(amount).toLocaleString('en-IN', { minimumFractionDigits: digits == null ? 2 : digits, maximumFractionDigits: digits == null ? 2 : digits });
  return `${sign}${currency === 'INR' || !currency ? 'Rs.' : `${currency} `}${body}`;
};
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '');
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

function renderRiderInvoice(inv, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const biz = inv.business || {};
    const doc = new PDFDocument({ size: 'A4', margin: 48, compress, info: { Title: `Invoice ${inv.invoiceNumber}`, Author: biz.legalName || biz.name || 'Invoice' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 48;
    const right = doc.page.width - 48;
    const width = right - left;
    const cur = inv.currency;
    const dg = inv.currencyDigits;
    const taxed = (inv.taxMinor || 0) > 0;

    // header: the business, and what this document is
    doc.font('Helvetica-Bold').fontSize(18).text(biz.name || biz.legalName || 'Invoice', left, 48, { width: width * 0.62 });
    doc.font('Helvetica').fontSize(9).fillColor('#555');
    if (biz.legalName && biz.legalName !== biz.name) doc.text(biz.legalName, left, doc.y, { width: width * 0.62 });
    if (biz.address) doc.text(biz.address, left, doc.y, { width: width * 0.62 });
    if (biz.gstin) doc.text(`GSTIN: ${biz.gstin}${biz.stateCode && STATES[biz.stateCode] ? `  |  ${STATES[biz.stateCode]} (${biz.stateCode})` : ''}`);
    if (biz.supportPhone || biz.supportEmail) doc.text([biz.supportPhone, biz.supportEmail].filter(Boolean).join('  |  '));
    const leftEnd = doc.y;

    const title = inv.type === 'CANCELLATION' ? 'CANCELLATION INVOICE' : taxed ? 'TAX INVOICE' : 'INVOICE';
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text(title, left + width * 0.62, 48, { width: width * 0.38, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#555');
    const meta = [['Invoice no.', inv.invoiceNumber], ['Invoice date', day(inv.issuedAt)], ['Trip no.', inv.tripId]];
    let my = 72;
    for (const [k, v] of meta) {
      doc.fillColor('#555').text(k, left + width * 0.62, my, { width: width * 0.16, align: 'right' });
      doc.fillColor('#000').font('Helvetica-Bold').text(String(v), left + width * 0.79, my, { width: width * 0.21, align: 'right' }).font('Helvetica');
      my += 14;
    }
    doc.y = Math.max(leftEnd, my) + 12;
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#ccc').stroke().strokeColor('#000');
    doc.moveDown(0.8);

    // billed to, and the ride
    const top = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text('BILLED TO', left, top);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text((inv.rider && inv.rider.name) || 'Rider', left, doc.y);
    doc.font('Helvetica').fontSize(9).fillColor('#444');
    if (inv.rider && inv.rider.phoneMasked) doc.text(inv.rider.phoneMasked);
    const billedEnd = doc.y;

    const colX = left + width / 2 + 8;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text('YOUR RIDE', colX, top);
    doc.font('Helvetica').fontSize(9).fillColor('#000');
    const ride = [];
    if (inv.trip && inv.trip.rideType) ride.push(['Ride type', inv.trip.rideType]);
    if (inv.driver && inv.driver.name) ride.push(['Driver', inv.driver.name]);
    if (inv.driver && (inv.driver.vehicleNumber || inv.driver.vehicleModel)) ride.push(['Vehicle', [inv.driver.vehicleModel, inv.driver.vehicleNumber].filter(Boolean).join('  ')]);
    let ry = top + 12;
    for (const [k, v] of ride) {
      doc.fillColor('#555').text(k, colX, ry, { width: 70 });
      doc.fillColor('#000').text(String(v), colX + 72, ry, { width: width / 2 - 80 });
      ry = doc.y + 2;
    }
    doc.y = Math.max(billedEnd, ry) + 14;

    // the route and times
    const t = inv.trip || {};
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text('TRIP DETAILS', left, doc.y);
    doc.moveDown(0.3);
    const row = (k, v) => {
      if (!v && v !== 0) return;
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#555').text(k, left, y, { width: 90 });
      doc.fillColor('#000').text(String(v), left + 94, y, { width: width - 94 });
    };
    row('Pickup', t.pickup);
    row('Drop', t.drop);
    row(inv.type === 'CANCELLATION' ? 'Requested' : 'Started', when(inv.type === 'CANCELLATION' ? t.requestedAt : t.startedAt));
    row(inv.type === 'CANCELLATION' ? 'Cancelled' : 'Completed', when(t.completedAt));
    if (t.distanceKm != null && inv.type !== 'CANCELLATION') row('Distance', `${Number(t.distanceKm).toFixed(1)} km`);
    if (t.durationMin && inv.type !== 'CANCELLATION') row('Duration', `${t.durationMin} min`);
    doc.moveDown(1);

    // the fare
    doc.rect(left, doc.y, width, 18).fill('#f2f2f2').fillColor('#000');
    const hy = doc.y + 5;
    doc.font('Helvetica-Bold').fontSize(9).text('Description', left + 8, hy).text('Amount', left, hy, { width: width - 8, align: 'right' });
    doc.y += 22;
    doc.font('Helvetica').fontSize(10);
    for (const l of inv.lines || []) {
      const y = doc.y;
      doc.fillColor(l.kind === 'DISCOUNT' ? '#15803D' : '#000').text(l.label, left + 8, y, { width: width * 0.7 }).text(money(l.amountMinor, cur, dg), left, y, { width: width - 8, align: 'right' });
      doc.y = Math.max(doc.y, y + 14) + 3;
    }
    doc.fillColor('#000').moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).strokeColor('#ccc').stroke().strokeColor('#000');
    doc.y += 10;
    if (taxed) {
      const y = doc.y;
      doc.font('Helvetica').fontSize(9).fillColor('#555').text('Amount before tax', left + 8, y).text(money(inv.subtotalMinor, cur, dg), left, y, { width: width - 8, align: 'right' });
      doc.y = y + 14;
    }
    const ty = doc.y;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000').text('Total', left + 8, ty).text(money(inv.totalMinor, cur, dg), left, ty, { width: width - 8, align: 'right' });
    doc.y = ty + 22;

    doc.font('Helvetica').fontSize(9).fillColor('#555').text(`Payment method: ${inv.paymentMode === 'CASH' ? 'Cash, paid to the driver' : inv.paymentMode}`, left, doc.y);
    doc.moveDown(2);
    doc.fontSize(8).fillColor('#888').text('This invoice was generated automatically and does not need a signature.', left, doc.y, { width });
    doc.end();
  });
}

module.exports = { renderRiderInvoice, money };
