/**
 * Professional Driver Earnings & Settlement Receipt PDF Generator (PDFKit) for AutoMet.
 * Matches AutoMet's commercial-grade visual identity and typography standards.
 * Clearly itemizes passenger fare (including waiting charges), platform commission, and driver net earnings.
 */
const PDFDocument = require('pdfkit');

const BRAND_GREEN = '#15803D';
const DARK_SLATE = '#0F172A';
const TEXT_MUTED = '#64748B';
const BORDER_COLOR = '#E2E8F0';
const BG_LIGHT = '#F8FAFC';
const BG_HEADER = '#064E3B';
const AMBER_BADGE = '#D97706';

const formatMoney = (amount, currency = 'INR') => {
  const n = Number(amount) || 0;
  const sign = n < 0 ? '-' : '';
  const body = Math.abs(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
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
  let crore = Math.floor(num / 10000000);
  let remainder = num % 10000000;
  let lakh = Math.floor(remainder / 100000);
  remainder = remainder % 100000;
  let thousand = Math.floor(remainder / 1000);
  remainder = remainder % 1000;

  if (crore > 0) result += convertThreeDigits(crore) + ' Crore ';
  if (lakh > 0) result += convertThreeDigits(lakh) + ' Lakh ';
  if (thousand > 0) result += convertThreeDigits(thousand) + ' Thousand ';
  if (remainder > 0) result += convertThreeDigits(remainder) + ' ';

  result = result.trim() + ' Rupees';

  if (paise > 0) {
    result += ' and ' + convertTwoDigits(paise) + ' Paise';
  }

  result += ' Only';
  return result;
}

function renderDriverReceipt({ business = {}, trip = {}, earnings = {}, cancelled = false, driverName = '', riderName = '' }, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      compress,
      info: {
        Title: `Driver Earnings Receipt ${trip.trip_id || ''}`,
        Author: business.name || 'AutoMet Technologies',
        Subject: 'Driver Trip Earnings & Settlement'
      }
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 36;
    const right = doc.page.width - 36;
    const width = right - left;
    const cur = earnings.currency || 'INR';

    // Business fallbacks
    const bizName = business.name || 'AutoMet';
    const bizLegal = business.legalName || 'AutoMet Technologies Private Limited';
    const bizGstin = business.gstin || '07AABCA1234F1Z5';
    const bizPhone = business.supportPhone || '+91 1800 890 1234';
    const bizEmail = business.supportEmail || 'support@automet.in';
    const receiptNo = `RCP-${String(trip.trip_id || '0000').toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
    const tripDate = trip.completed_at || trip.cancelled_at || trip.requested_at || new Date();

    // 1. Header Banner
    const headerHeight = 76;
    doc.rect(0, 0, doc.page.width, headerHeight).fill(BG_HEADER);

    // Brand Title
    doc.fillColor('#FFFFFF')
      .font('Helvetica-Bold')
      .fontSize(22)
      .text(bizName.toUpperCase(), left, 18, { characterSpacing: 1.2 });

    doc.font('Helvetica')
      .fontSize(8.5)
      .fillColor('#A7F3D0')
      .text('DRIVER PARTNER EARNINGS & SETTLEMENT', left, 44);

    // Document Title on Top-Right
    doc.font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#FFFFFF')
      .text('EARNINGS RECEIPT', left + width * 0.45, 18, { width: width * 0.55, align: 'right' });

    doc.font('Helvetica')
      .fontSize(8.5)
      .fillColor('#D1D5DB')
      .text(`Receipt No: ${receiptNo}`, left + width * 0.45, 36, { width: width * 0.55, align: 'right' });

    doc.font('Helvetica')
      .fontSize(8.5)
      .fillColor('#D1D5DB')
      .text(`Date: ${formatDateOnly(tripDate)} | SAC: 996412`, left + width * 0.45, 48, { width: width * 0.55, align: 'right' });

    let y = headerHeight + 14;

    // 2. Status Badge & Trip Overview Bar
    const badgeBg = cancelled ? '#FEF3C7' : '#DCFCE7';
    const badgeText = cancelled ? AMBER_BADGE : BRAND_GREEN;
    const statusLabel = cancelled ? 'TRIP CANCELLED' : 'TRIP COMPLETED';

    doc.roundedRect(left, y, 120, 20, 10).fill(badgeBg);
    doc.fillColor(badgeText)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(statusLabel, left, y + 5.5, { width: 120, align: 'center', characterSpacing: 0.6 });

    doc.font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor(DARK_SLATE)
      .text(`Trip ID: ${trip.trip_id || '-'}`, left + 130, y + 4.5);

    doc.font('Helvetica')
      .fontSize(8.5)
      .fillColor(TEXT_MUTED)
      .text(formatDateTime(tripDate), left + width * 0.6, y + 5, { width: width * 0.4, align: 'right' });

    y += 30;

    // 3. Two-Column Cards: Driver Details vs Platform Details
    const cardWidth = (width - 12) / 2;
    const cardHeight = 82;

    // Left Card: Driver Information
    doc.roundedRect(left, y, cardWidth, cardHeight, 6).fillAndStroke(BG_LIGHT, BORDER_COLOR);
    doc.font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(DARK_SLATE)
      .text('DRIVER PARTNER DETAILS', left + 12, y + 10, { characterSpacing: 0.5 });

    doc.moveTo(left + 12, y + 22).lineTo(left + cardWidth - 12, y + 22).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();

    doc.font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor(DARK_SLATE)
      .text(driverName || 'Driver Partner', left + 12, y + 28);

    doc.font('Helvetica')
      .fontSize(8.5)
      .fillColor(TEXT_MUTED)
      .text(`Driver ID: ${trip.driver_id || '-'}`, left + 12, y + 42)
      .text(`Vehicle: ${trip.vehicle_details || trip.category_name || 'Commercial Auto'}`, left + 12, y + 54)
      .text(`Passenger: ${riderName || 'Customer'}`, left + 12, y + 66);

    // Right Card: Business / Settlement Details
    const cardRightX = left + cardWidth + 12;
    doc.roundedRect(cardRightX, y, cardWidth, cardHeight, 6).fillAndStroke(BG_LIGHT, BORDER_COLOR);
    doc.font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(DARK_SLATE)
      .text('PLATFORM & OPERATOR DETAILS', cardRightX + 12, y + 10, { characterSpacing: 0.5 });

    doc.moveTo(cardRightX + 12, y + 22).lineTo(cardRightX + cardWidth - 12, y + 22).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();

    doc.font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(DARK_SLATE)
      .text(bizLegal, cardRightX + 12, y + 28, { width: cardWidth - 24 });

    doc.font('Helvetica')
      .fontSize(8.5)
      .fillColor(TEXT_MUTED)
      .text(`GSTIN: ${bizGstin}`, cardRightX + 12, y + 42)
      .text(`Helpline: ${bizPhone}`, cardRightX + 12, y + 54)
      .text(`Email: ${bizEmail}`, cardRightX + 12, y + 66);

    y += cardHeight + 14;

    // 4. Trip Route & Metrics Bar
    const routeBoxHeight = 84;
    doc.roundedRect(left, y, width, routeBoxHeight, 6).fillAndStroke('#FFFFFF', BORDER_COLOR);

    // Route visual
    const iconX = left + 14;
    doc.circle(iconX, y + 18, 4.5).fill(BRAND_GREEN);
    doc.circle(iconX, y + 46, 4.5).fill('#DC2626');
    doc.moveTo(iconX, y + 24).lineTo(iconX, y + 40).lineWidth(1).strokeColor('#CBD5E1').stroke();

    const textX = left + 26;
    const addrWidth = width - 40;

    doc.font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(DARK_SLATE)
      .text('PICKUP: ', textX, y + 13, { continued: true })
      .font('Helvetica')
      .fillColor(TEXT_MUTED)
      .text((trip.pickup && trip.pickup.address) || 'Pickup Location', { width: addrWidth });

    doc.font('Helvetica-Bold')
      .fontSize(8.5)
      .fillColor(DARK_SLATE)
      .text('DROP: ', textX, y + 41, { continued: true })
      .font('Helvetica')
      .fillColor(TEXT_MUTED)
      .text((trip.drop && trip.drop.address) || 'Drop Location', { width: addrWidth });

    // Divider for metrics
    doc.moveTo(left, y + 62).lineTo(right, y + 62).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();
    doc.rect(left, y + 62.5, width, 21.5).fill(BG_LIGHT);

    const colW = width / 4;
    const metric = (label, val, colIdx) => {
      const cx = left + colIdx * colW;
      doc.font('Helvetica')
        .fontSize(7.5)
        .fillColor(TEXT_MUTED)
        .text(label, cx + 8, y + 65)
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(DARK_SLATE)
        .text(val, cx + 8, y + 74);
    };

    const distStr = trip.distance_km != null ? `${Number(trip.distance_km).toFixed(1)} km` : '-';
    const payModeStr = trip.payment_mode === 'CASH' || !trip.payment_mode ? 'Cash' : trip.payment_mode;
    const waitMin = trip.chargeable_waiting_minutes != null ? `${trip.chargeable_waiting_minutes} min` : (trip.waiting_minutes ? `${trip.waiting_minutes} min` : '0 min');

    metric('DISTANCE', distStr, 0);
    metric('WAITING TIME', waitMin, 1);
    metric('PAYMENT MODE', payModeStr, 2);
    metric('CATEGORY', trip.category_name || 'Standard', 3);

    y += routeBoxHeight + 16;

    // 5. Earnings Breakdown Table
    doc.font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(DARK_SLATE)
      .text('EARNINGS & SETTLEMENT BREAKDOWN', left, y, { characterSpacing: 0.5 });

    y += 14;

    // Table Header
    const thHeight = 22;
    doc.rect(left, y, width, thHeight).fill(BG_LIGHT);
    doc.rect(left, y, width, thHeight).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();

    doc.font('Helvetica-Bold')
      .fontSize(8)
      .fillColor(DARK_SLATE);

    doc.text('#', left + 10, y + 6, { width: 25 });
    doc.text('Description', left + 35, y + 6, { width: width * 0.45 });
    doc.text('SAC / Type', left + width * 0.55, y + 6, { width: width * 0.2 });
    doc.text('Amount (INR)', left + width * 0.75, y + 6, { width: width * 0.25 - 10, align: 'right' });

    y += thHeight;

    if (!cancelled) {
      const lines = Array.isArray(earnings.lines) && earnings.lines.length > 0
        ? earnings.lines
        : [{ label: 'Trip Fare', amount: earnings.passenger_fare || 0 }];

      lines.forEach((item, index) => {
        const isOdd = index % 2 === 1;
        if (isOdd) {
          doc.rect(left, y, width, 22).fill('#FAFAFA');
        }

        doc.font('Helvetica')
          .fontSize(8.5)
          .fillColor(DARK_SLATE);

        doc.text(String(index + 1), left + 10, y + 6, { width: 25 });
        doc.text(item.label || 'Fare Component', left + 35, y + 6, { width: width * 0.45 });
        doc.fillColor(TEXT_MUTED).text('SAC 996412', left + width * 0.55, y + 6, { width: width * 0.2 });
        doc.fillColor(DARK_SLATE).text(formatMoney(item.amount, cur), left + width * 0.75, y + 6, { width: width * 0.25 - 10, align: 'right' });

        y += 22;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();
      });

      // Total Passenger Fare Row
      doc.rect(left, y, width, 22).fill(BG_LIGHT);
      doc.font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(DARK_SLATE)
        .text('Total Fare Paid by Passenger', left + 35, y + 6, { width: width * 0.5 })
        .text(formatMoney(earnings.passenger_fare, cur), left + width * 0.75, y + 6, { width: width * 0.25 - 10, align: 'right' });

      y += 22;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();

      // Platform commission deduction (if any)
      if (Number(earnings.platform_fee) > 0) {
        doc.font('Helvetica')
          .fontSize(8.5)
          .fillColor(TEXT_MUTED)
          .text(`Less: Platform Service Fee (${earnings.platform_fee_percent || 0}%)`, left + 35, y + 6, { width: width * 0.5 })
          .fillColor('#DC2626')
          .text(`-${formatMoney(earnings.platform_fee, cur)}`, left + width * 0.75, y + 6, { width: width * 0.25 - 10, align: 'right' });

        y += 22;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();
      }

      // Coupon funded by business (if any)
      if (Number(earnings.coupon_discount_funded) > 0) {
        doc.font('Helvetica')
          .fontSize(8.5)
          .fillColor(TEXT_MUTED)
          .text('Add: Promo Discount Funded by AutoMet', left + 35, y + 6, { width: width * 0.5 })
          .fillColor(BRAND_GREEN)
          .text(`+${formatMoney(earnings.coupon_discount_funded, cur)}`, left + width * 0.75, y + 6, { width: width * 0.25 - 10, align: 'right' });

        y += 22;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();
      }

      // 6. Final Net Driver Earnings Highlighted Bar
      y += 8;
      doc.roundedRect(left, y, width, 36, 4).fill(BG_HEADER);

      doc.font('Helvetica-Bold')
        .fontSize(12)
        .fillColor('#FFFFFF')
        .text('NET DRIVER EARNINGS', left + 16, y + 11)
        .fontSize(14)
        .text(formatMoney(earnings.earnings, cur), left + width * 0.5, y + 10, { width: width * 0.5 - 16, align: 'right' });

      y += 36 + 10;

      // Amount in Words
      doc.font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(DARK_SLATE)
        .text('Amount in Words: ', left, y, { continued: true })
        .font('Helvetica')
        .fillColor(TEXT_MUTED)
        .text(numberToWords(earnings.earnings));

      y += 18;

      // Settlement note card
      const isCash = trip.payment_mode === 'CASH' || !trip.payment_mode;
      const settlementText = isCash
        ? `Payment Settlement: Passenger paid ${formatMoney(earnings.rider_paid, cur)} in cash directly to you. Platform fee (if any) is debited from your driver digital ledger.`
        : `Payment Settlement: Passenger paid digitally via online payment. Net earnings of ${formatMoney(earnings.earnings, cur)} will be credited to your linked bank account / digital wallet.`;

      doc.roundedRect(left, y, width, 30, 4).fillAndStroke('#F0FDF4', '#BBF7D0');
      doc.font('Helvetica')
        .fontSize(8)
        .fillColor(BRAND_GREEN)
        .text(settlementText, left + 10, y + 8, { width: width - 20 });

      y += 40;
    } else {
      // Cancelled Ride Notice
      doc.rect(left, y, width, 40).fill(BG_LIGHT);
      doc.font('Helvetica')
        .fontSize(9)
        .fillColor(TEXT_MUTED)
        .text(trip.cancellation_reason ? `Cancellation Reason: ${trip.cancellation_reason}` : 'This ride was cancelled. No fare or commission was charged.', left + 16, y + 14, { width: width - 32 });

      y += 50;
    }

    // 7. Footer
    doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(BORDER_COLOR).stroke();
    y += 10;

    doc.font('Helvetica')
      .fontSize(8)
      .fillColor(TEXT_MUTED)
      .text(`For partner support or payout queries: ${bizPhone}  |  ${bizEmail}  |  www.automet.in`, left, y, { width, align: 'center' });

    y += 14;

    doc.font('Helvetica')
      .fontSize(7.5)
      .fillColor('#94A3B8')
      .text('This is an electronically generated earnings receipt issued under the Information Technology Act, 2000. No signature required.', left, y, { width, align: 'center' });

    doc.end();
  });
}

module.exports = { renderDriverReceipt };
