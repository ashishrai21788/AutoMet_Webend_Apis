/**
 * The driver's earnings receipt for one ride (pdfkit, no browser): what the passenger paid, line by line, the business's
 * share if it keeps one, and what the driver earned. Standard PDF fonts have no rupee sign, so amounts read "Rs.".
 */
const PDFDocument = require('pdfkit');

const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const BAND = '#F3F4F6';
const ACCENT = '#1F2937';
const GREEN = '#15803D';

const money = (amount, currency) => {
  const n = Number(amount) || 0;
  const body = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${!currency || currency === 'INR' ? 'Rs.' : `${currency} `}${body}`;
};
const when = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '');
const title = (s) => String(s || '').toLowerCase().replace(/(^|[\s_-])\w/g, (m) => m.toUpperCase()).replace(/_/g, ' ');

function renderDriverReceipt({ business, trip, earnings, cancelled, driverName, riderName }, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, compress, info: { Title: `Earnings receipt ${trip.trip_id}`, Author: business.name || 'Receipt' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = 40;
    const right = doc.page.width - 40;
    const width = right - left;
    const cur = earnings.currency;

    doc.rect(0, 0, doc.page.width, 90).fill(ACCENT);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(20).text(business.name || 'Earnings receipt', left, 28, { width: width * 0.6 });
    doc.font('Helvetica-Bold').fontSize(13).text('EARNINGS RECEIPT', left + width * 0.5, 28, { width: width * 0.5, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor('#D1D5DB').text(`Trip ${trip.trip_id}`, left + width * 0.5, 50, { width: width * 0.5, align: 'right' });

    let y = 108;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(cancelled ? '#B45309' : GREEN).text(cancelled ? 'Ride cancelled' : 'Ride completed', left, y, { width: width * 0.6 });
    const at = trip.completed_at || trip.cancelled_at || trip.requested_at;
    if (at) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(when(at), left + width * 0.6, y + 3, { width: width * 0.4, align: 'right' });
    y = doc.y + 14;

    const row = (k, v) => {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(k, left, y, { width: 90 });
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(v || '-', left + 100, y, { width: width - 100 });
      y = Math.max(doc.y, y + 14) + 4;
    };
    row('Driver', driverName);
    row('Passenger', riderName);
    row('Pickup', trip.pickup && trip.pickup.address);
    row('Drop', trip.drop && trip.drop.address);
    if (trip.distance_km != null) row('Distance', `${Number(trip.distance_km).toFixed(1)} km`);
    row('Payment', trip.payment_mode === 'CASH' || !trip.payment_mode ? 'Cash, collected by the driver' : title(trip.payment_mode));
    y += 10;

    if (!cancelled) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('FARE BREAKUP (PASSENGER PAID)', left, y, { characterSpacing: 0.8 });
      y += 14;
      doc.rect(left, y, width, 20).fill(BAND);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text('Description', left + 10, y + 6).text('Amount', left, y + 6, { width: width - 10, align: 'right' });
      y += 20;
      for (const l of earnings.lines) {
        doc.font('Helvetica').fontSize(10).fillColor(INK).text(l.label, left + 10, y + 7, { width: width * 0.7 });
        doc.text(money(l.amount, cur), left, y + 7, { width: width - 10, align: 'right' });
        y += 26;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
      }
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Total passenger fare', left + 10, y + 8).text(money(earnings.passenger_fare, cur), left, y + 8, { width: width - 10, align: 'right' });
      y += 26;
      if (earnings.coupon_discount_funded > 0) {
        doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`The passenger paid ${money(earnings.rider_paid, cur)}. The ${money(earnings.coupon_discount_funded, cur)} coupon is paid to you by the business.`, left + 10, y + 2, { width: width - 20 });
        y += 26;
      }
      if (earnings.platform_fee > 0) {
        doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(`Platform fee (${earnings.platform_fee_percent}%)`, left + 10, y + 2).text(`-${money(earnings.platform_fee, cur)}`, left, y + 2, { width: width - 10, align: 'right' });
        y += 22;
      }
      y += 6;
      doc.rect(left, y, width, 32).fill(GREEN);
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF').text('Your earnings', left + 10, y + 10).text(money(earnings.earnings, cur), left, y + 9, { width: width - 10, align: 'right' });
      y += 32 + 16;
    } else {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(trip.cancellation_reason ? `Reason: ${trip.cancellation_reason}` : 'This ride was cancelled, so there are no earnings for it.', left, y, { width });
      y = doc.y + 16;
    }

    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(LINE).stroke();
    y += 8;
    const contact = [business.supportPhone, business.supportEmail].filter(Boolean).join('  |  ');
    if (contact) { doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(`Questions about this ride? ${contact}`, left, y, { width, align: 'center' }); y = doc.y + 4; }
    doc.font('Helvetica').fontSize(8).fillColor('#9CA3AF').text('This is a computer-generated receipt and needs no signature.', left, y, { width, align: 'center' });
    doc.end();
  });
}

module.exports = { renderDriverReceipt };
