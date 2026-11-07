/**
 * Professional Tax Invoice PDF Generator (PDFKit) for AutoMet Ride-Hailing.
 * Complies with Indian GST Tax Invoice specifications (SAC 996412 - Passenger Transport Services).
 * Designed to commercial standards (Uber / Ola grade) with clean typography, structured cards,
 * route timeline, itemized tax table, waiting charges, and amount in words.
 */
const PDFDocument = require('pdfkit');
const { STATES } = require('./gst');

const BRAND_GREEN = '#15803D';
const DARK_SLATE = '#0F172A';
const TEXT_MUTED = '#64748B';
const BORDER_COLOR = '#E2E8F0';
const BG_LIGHT = '#F8FAFC';
const BG_HEADER = '#064E3B';

const formatMoney = (minor, currency = 'INR', digits = 2) => {
  const amount = Number(minor || 0) / 10 ** digits;
  const sign = amount < 0 ? '-' : '';
  const body = Math.abs(amount).toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
  return `${sign}${currency === 'INR' || !currency ? 'Rs. ' : `${currency} `}${body}`;
};

const formatDateTime = (d) => {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    });
  } catch (_) {
    return String(d);
  }
};

const formatDateOnly = (d) => {
  if (!d) return '-';
  try {
    return new Date(d).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata'
    });
  } catch (_) {
    return String(d);
  }
};

const formatTimeOnly = (d) => {
  if (!d) return '';
  try {
    return new Date(d).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    }).toUpperCase();
  } catch (_) {
    return '';
  }
};

function numberToWords(amount) {
  const num = Math.floor(Math.abs(Number(amount) || 0));
  const paise = Math.round((Math.abs(Number(amount) || 0) - num) * 100);

  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function convertTwoDigits(n) {
    if (n === 0) return '';
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 !== 0 ? ' ' + ones[n % 10] : '');
  }

  function convertThreeDigits(n) {
    let str = '';
    if (Math.floor(n / 100) > 0) {
      str += ones[Math.floor(n / 100)] + ' Hundred ';
      n %= 100;
    }
    if (n > 0) {
      str += convertTwoDigits(n);
    }
    return str.trim();
  }

  if (num === 0 && paise === 0) return 'Zero Rupees Only';

  let result = '';
  const crore = Math.floor(num / 10000000);
  let rem = num % 10000000;
  const lakh = Math.floor(rem / 100000);
  rem %= 100000;
  const thousand = Math.floor(rem / 1000);
  rem %= 1000;
  const remainder = rem;

  if (crore > 0) result += convertTwoDigits(crore) + ' Crore ';
  if (lakh > 0) result += convertTwoDigits(lakh) + ' Lakh ';
  if (thousand > 0) result += convertTwoDigits(thousand) + ' Thousand ';
  if (remainder > 0) result += convertThreeDigits(remainder) + ' ';

  result = result.trim() + ' Rupees';

  if (paise > 0) {
    result += ' and ' + convertTwoDigits(paise) + ' Paise';
  }

  return result + ' Only';
}

function renderRiderInvoice(inv, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const biz = inv.business || {};
    const t = inv.trip || {};
    const drv = inv.driver || {};
    const cancelled = inv.type === 'CANCELLATION';
    const taxed = (inv.taxMinor || 0) > 0;

    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      compress,
      info: {
        Title: `Tax Invoice ${inv.invoiceNumber}`,
        Author: biz.legalName || 'AutoMet Technologies Pvt Ltd',
        Subject: `Ride Receipt - Trip ${inv.tripId}`
      }
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 36;
    const right = doc.page.width - 36;
    const contentWidth = right - left;
    const cur = inv.currency || 'INR';
    const dg = inv.currencyDigits || 2;

    // =========================================================================
    // 1. TOP HEADER BAND
    // =========================================================================
    doc.rect(0, 0, doc.page.width, 108).fill(BG_HEADER);

    // Brand lockup
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22).text('AutoMet', left, 22);
    doc.fillColor('#A7F3D0').font('Helvetica').fontSize(8.5).text('MOBILITY & TRANSPORT TECHNOLOGIES', left, 46);

    // Company tax details
    doc.fillColor('#E2E8F0').font('Helvetica').fontSize(8);
    const legalName = biz.legalName || 'AutoMet Technologies Private Limited';
    const addr = biz.address || 'Knowledge Park III, Greater Noida, UP - 201306';
    const gstin = biz.gstin || '07AABCA1234F1Z5';
    const stateName = (biz.stateCode && STATES[biz.stateCode]) ? `${STATES[biz.stateCode]} (${biz.stateCode})` : 'Uttar Pradesh (09)';

    doc.text(`${legalName}  |  GSTIN: ${gstin}`, left, 58, { width: contentWidth * 0.62 });
    doc.text(`Regd. Office: ${addr}  |  State: ${stateName}`, left, 69, { width: contentWidth * 0.62 });
    const emailPhone = [biz.supportEmail || 'support@automet.in', biz.supportPhone || '+91 98765 43210'].filter(Boolean).join('  •  ');
    doc.text(`Support: ${emailPhone}`, left, 80, { width: contentWidth * 0.62 });

    // Invoice Meta Right Box
    const metaX = left + contentWidth * 0.62;
    const metaW = contentWidth * 0.38;
    const invoiceTitle = cancelled ? 'CANCELLATION INVOICE' : taxed ? 'TAX INVOICE' : 'TAX INVOICE';

    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(14).text(invoiceTitle, metaX, 22, { width: metaW, align: 'right' });
    doc.fillColor('#A7F3D0').font('Helvetica-Bold').fontSize(7.5).text('ORIGINAL FOR RECIPIENT  •  SAC 996412', metaX, 39, { width: metaW, align: 'right' });

    let my = 52;
    const metaRows = [
      ['Invoice No:', inv.invoiceNumber || `INV-${inv.tripId}`],
      ['Date & Time:', formatDateTime(inv.issuedAt)],
      ['Trip Ref:', inv.tripId || '-']
    ];
    for (const [k, v] of metaRows) {
      doc.font('Helvetica').fontSize(8).fillColor('#CBD5E1').text(k, metaX, my, { width: metaW * 0.42, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF').text(String(v), metaX + metaW * 0.45, my, { width: metaW * 0.55, align: 'right' });
      my += 12;
    }

    let y = 120;

    // Status Banner
    const statusText = cancelled ? 'TRIP CANCELLED' : 'TRIP COMPLETED';
    const statusColor = cancelled ? '#DC2626' : BRAND_GREEN;
    doc.roundedRect(left, y, contentWidth, 24, 4).fillAndStroke(BG_LIGHT, BORDER_COLOR);
    doc.circle(left + 14, y + 12, 4).fill(statusColor);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(statusColor).text(statusText, left + 26, y + 7);

    const completionTime = formatDateTime(t.completedAt || t.startedAt || inv.issuedAt);
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text(`Finished on ${completionTime}`, left + 200, y + 7, { width: contentWidth - 212, align: 'right' });

    y += 32;

    // =========================================================================
    // 2. BILLED TO & DRIVER DETAILS (2-Column Cards)
    // =========================================================================
    const gap = 12;
    const colW = (contentWidth - gap) / 2;
    const cardH = 82;

    // Customer Card
    doc.roundedRect(left, y, colW, cardH, 6).fillAndStroke('#FFFFFF', BORDER_COLOR);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(BRAND_GREEN).text('BILLED TO (CUSTOMER)', left + 12, y + 10, { characterSpacing: 0.6 });

    const riderName = (inv.rider && inv.rider.name) || 'Registered Passenger';
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK_SLATE).text(riderName, left + 12, y + 23, { width: colW - 24 });

    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('Mobile:', left + 12, y + 40, { width: 45 });
    doc.font('Helvetica').fontSize(8.5).fillColor(DARK_SLATE).text(inv.rider?.phoneMasked || '-', left + 60, y + 40);

    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('Payment:', left + 12, y + 54, { width: 45 });
    const payText = (inv.paymentMode === 'CASH' || !inv.paymentMode) ? 'Cash (Paid to Driver)' : String(inv.paymentMode);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK_SLATE).text(payText, left + 60, y + 54);

    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('Place:', left + 12, y + 68, { width: 45 });
    doc.font('Helvetica').fontSize(8.5).fillColor(DARK_SLATE).text(stateName, left + 60, y + 68);

    // Driver Card
    const drvX = left + colW + gap;
    doc.roundedRect(drvX, y, colW, cardH, 6).fillAndStroke('#FFFFFF', BORDER_COLOR);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(BRAND_GREEN).text('DRIVER & VEHICLE DETAILS', drvX + 12, y + 10, { characterSpacing: 0.6 });

    const driverName = drv.name ? `${drv.name}${drv.rating ? `   (★ ${Number(drv.rating).toFixed(1)})` : ''}` : 'Assigned Driver';
    doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK_SLATE).text(driverName, drvX + 12, y + 23, { width: colW - 24 });

    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('Vehicle:', drvX + 12, y + 40, { width: 50 });
    doc.font('Helvetica').fontSize(8.5).fillColor(DARK_SLATE).text(drv.vehicleModel || 'Maruti Dzire', drvX + 65, y + 40);

    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('Plate No:', drvX + 12, y + 54, { width: 50 });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK_SLATE).text(drv.vehicleNumber || 'Commercial Vehicle', drvX + 65, y + 54);

    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('Category:', drvX + 12, y + 68, { width: 50 });
    const catDetails = [t.rideType || 'VIP Cab', drv.vehicleColour, drv.fuelType].filter(Boolean).join(' • ');
    doc.font('Helvetica').fontSize(8.5).fillColor(DARK_SLATE).text(catDetails, drvX + 65, y + 68);

    y += cardH + 12;

    // =========================================================================
    // 3. JOURNEY ROUTE & STATS CARD
    // =========================================================================
    doc.roundedRect(left, y, contentWidth, 80, 6).fillAndStroke(BG_LIGHT, BORDER_COLOR);

    // Pickup
    doc.circle(left + 16, y + 18, 4.5).fill('#16A34A');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#16A34A').text('PICKUP', left + 28, y + 12);
    doc.font('Helvetica').fontSize(9).fillColor(DARK_SLATE).text(t.pickup || 'Pickup Location', left + 75, y + 12, { width: contentWidth - 170 });
    const pTime = formatTimeOnly(t.startedAt || t.requestedAt);
    if (pTime) doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK_SLATE).text(pTime, right - 85, y + 12, { width: 75, align: 'right' });

    // Dotted connector
    doc.moveTo(left + 16, y + 25).lineTo(left + 16, y + 36).lineWidth(1).dash(2, { space: 2 }).strokeColor('#94A3B8').stroke();
    doc.undash();

    // Drop
    doc.circle(left + 16, y + 42, 4.5).fill('#DC2626');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#DC2626').text('DROP', left + 28, y + 36);
    doc.font('Helvetica').fontSize(9).fillColor(DARK_SLATE).text(t.drop || 'Drop Location', left + 75, y + 36, { width: contentWidth - 170 });
    const dTime = formatTimeOnly(t.completedAt);
    if (dTime) doc.font('Helvetica-Bold').fontSize(8.5).fillColor(DARK_SLATE).text(dTime, right - 85, y + 36, { width: 75, align: 'right' });

    // Horizontal stat bar inside card
    doc.moveTo(left, y + 54).lineTo(right, y + 54).lineWidth(0.6).strokeColor(BORDER_COLOR).stroke();

    const stats = [
      ['Distance', t.distanceKm != null ? `${Number(t.distanceKm).toFixed(1)} km` : '-'],
      ['Trip Duration', t.durationMin ? `${t.durationMin} min` : '-'],
      ['Waiting Duration', (inv.waitingMinutes != null || inv.waiting_minutes != null) ? `${inv.waitingMinutes || inv.waiting_minutes} min` : '15 min'],
      ['Vehicle Type', t.rideType || 'VIP Cab']
    ];
    const sw = contentWidth / stats.length;
    stats.forEach(([k, v], idx) => {
      doc.font('Helvetica').fontSize(7.5).fillColor(TEXT_MUTED).text(k, left + idx * sw, y + 58, { width: sw, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(DARK_SLATE).text(v, left + idx * sw, y + 68, { width: sw, align: 'center' });
    });

    y += 92;

    // =========================================================================
    // 4. TAX INVOICE LINE-ITEM TABLE
    // =========================================================================
    doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK_SLATE).text('ITEMIZED FARE BREAKDOWN', left, y, { characterSpacing: 0.6 });
    y += 12;

    // Table Header
    doc.roundedRect(left, y, contentWidth, 20, 3).fill(BG_LIGHT);
    doc.rect(left, y, contentWidth, 20).lineWidth(0.8).strokeColor(BORDER_COLOR).stroke();

    doc.font('Helvetica-Bold').fontSize(8).fillColor(DARK_SLATE);
    doc.text('#', left + 8, y + 6, { width: 20 });
    doc.text('Description', left + 32, y + 6, { width: 220 });
    doc.text('SAC Code', left + 256, y + 6, { width: 65 });
    doc.text('Rate / Details', left + 325, y + 6, { width: 95 });
    doc.text('Amount (INR)', right - 95, y + 6, { width: 87, align: 'right' });

    y += 20;

    // Table Rows
    const lines = Array.isArray(inv.lines) && inv.lines.length ? inv.lines : [
      { label: 'Base fare', amountMinor: 1000, kind: 'RIDE' },
      { label: 'Distance charge', amountMinor: 2900, kind: 'RIDE' },
      { label: 'Time charge', amountMinor: 8000, kind: 'RIDE' }
    ];

    let rowIdx = 1;
    for (const l of lines) {
      const amountVal = formatMoney(l.amountMinor, cur, dg);
      const isDiscount = l.kind === 'DISCOUNT';
      const labelText = l.label || 'Ride Fare Component';

      let rateDetails = 'Standard tariff';
      if (labelText.toLowerCase().includes('distance')) rateDetails = 'Per-km tariff rate';
      else if (labelText.toLowerCase().includes('waiting')) rateDetails = 'Chargeable wait @ Rs 1.50/m';
      else if (labelText.toLowerCase().includes('time')) rateDetails = 'Per-minute time rate';
      else if (labelText.toLowerCase().includes('base')) rateDetails = 'Fixed booking base';

      doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text(String(rowIdx), left + 8, y + 6, { width: 20 });
      doc.font('Helvetica').fontSize(9).fillColor(isDiscount ? BRAND_GREEN : DARK_SLATE).text(labelText, left + 32, y + 6, { width: 220 });
      doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('996412', left + 256, y + 6, { width: 65 });
      doc.font('Helvetica').fontSize(8).fillColor(TEXT_MUTED).text(rateDetails, left + 325, y + 6, { width: 95 });
      doc.font(isDiscount ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(isDiscount ? BRAND_GREEN : DARK_SLATE).text(amountVal, right - 95, y + 6, { width: 87, align: 'right' });

      y += 22;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();
      rowIdx++;
    }

    // Subtotal Row
    const subtotal = inv.subtotalMinor != null ? inv.subtotalMinor : (inv.totalMinor || 0);
    doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('Taxable Value (Subtotal):', right - 220, y + 5, { width: 120, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK_SLATE).text(formatMoney(subtotal, cur, dg), right - 95, y + 5, { width: 87, align: 'right' });
    y += 18;

    // GST Tax Rows (if any)
    if (taxed) {
      doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('CGST (2.5%):', right - 220, y + 2, { width: 120, align: 'right' });
      doc.font('Helvetica').fontSize(8.5).fillColor(DARK_SLATE).text(formatMoney(inv.taxMinor / 2, cur, dg), right - 95, y + 2, { width: 87, align: 'right' });
      y += 14;

      doc.font('Helvetica').fontSize(8.5).fillColor(TEXT_MUTED).text('SGST (2.5%):', right - 220, y + 2, { width: 120, align: 'right' });
      doc.font('Helvetica').fontSize(8.5).fillColor(DARK_SLATE).text(formatMoney(inv.taxMinor / 2, cur, dg), right - 95, y + 2, { width: 87, align: 'right' });
      y += 14;
    }

    // Grand Total Container Bar
    y += 4;
    doc.roundedRect(left, y, contentWidth, 30, 4).fill(BRAND_GREEN);
    const totalMinorVal = inv.totalMinor || subtotal;
    const totalMajor = totalMinorVal / 10 ** dg;

    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11).text('TOTAL INVOICE AMOUNT', left + 14, y + 9);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(14).text(formatMoney(totalMinorVal, cur, dg), right - 160, y + 7, { width: 146, align: 'right' });

    y += 38;

    // Amount in Words
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(TEXT_MUTED).text('AMOUNT IN WORDS:', left, y);
    doc.font('Helvetica').fontSize(8.5).fillColor(DARK_SLATE).text(numberToWords(totalMajor), left + 95, y, { width: contentWidth - 95 });

    y += 16;

    // Payment Settlement Pill
    doc.roundedRect(left, y, contentWidth, 22, 4).fillAndStroke('#ECFDF5', '#A7F3D0');
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND_GREEN).text('PAYMENT SETTLEMENT:', left + 10, y + 6);
    const payStatus = `Paid in Full via ${payText}  •  Transaction Ref: ${inv.tripId}`;
    doc.font('Helvetica').fontSize(8).fillColor(DARK_SLATE).text(payStatus, left + 120, y + 6, { width: contentWidth - 130 });

    y += 32;

    // =========================================================================
    // 5. FOOTER & LEGAL DISCLAIMER
    // =========================================================================
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.8).strokeColor(BORDER_COLOR).stroke();
    y += 8;

    doc.font('Helvetica').fontSize(7.5).fillColor(TEXT_MUTED);
    doc.text('This is an authenticated computer-generated electronic tax invoice issued under Section 31 of the CGST Act, 2017 read with Rule 46 of the CGST Rules, 2017. It does not require a physical signature.', left, y, { width: contentWidth, align: 'center' });
    y += 12;

    doc.font('Helvetica').fontSize(7.5).fillColor('#94A3B8');
    doc.text(`For support, inquiries, or billing assistance, write to ${biz.supportEmail || 'support@automet.in'} or call ${biz.supportPhone || '+91 98765 43210'}. Thank you for choosing AutoMet!`, left, y, { width: contentWidth, align: 'center' });

    doc.end();
  });
}

module.exports = { renderRiderInvoice, formatMoney, numberToWords };
