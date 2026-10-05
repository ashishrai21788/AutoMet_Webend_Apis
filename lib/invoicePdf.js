/**
 * Renders an invoice as a PDF (pdfkit, no browser needed). Everything printed comes from the invoice record itself (the
 * seller and buyer details and tax lines are a snapshot taken when it was issued), so an old invoice never changes when
 * company or business details are edited later. Standard PDF fonts have no rupee sign, so amounts read "Rs.".
 */
const PDFDocument = require('pdfkit');
const { STATES, amountInWords } = require('./gst');

const money = (n, currency) => `${currency === 'INR' || !currency ? 'Rs.' : `${currency} `}${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const stateLine = (code) => (code && STATES[code] ? `${STATES[code]} (${code})` : '');

function renderInvoice(inv, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, compress, info: { Title: `Invoice ${inv.number}`, Author: (inv.seller && inv.seller.legalName) || 'Invoice' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const seller = inv.seller || {};
    const buyer = inv.buyer || {};
    const taxed = (inv.taxAmount || 0) > 0 || (inv.taxRate || 0) > 0;
    const left = 48;
    const right = doc.page.width - 48;
    const width = right - left;
    const total = inv.total != null ? inv.total : inv.amount;

    doc.font('Helvetica-Bold').fontSize(18).text(taxed ? 'TAX INVOICE' : 'INVOICE', left, 48);
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(inv.status === 'paid' ? 'PAID' : inv.status === 'void' ? 'VOID' : 'ORIGINAL FOR RECIPIENT', left, 52, { width, align: 'right' }).fillColor('#000');

    doc.moveDown(1.2);
    const topY = doc.y;
    doc.font('Helvetica-Bold').fontSize(11).text(seller.legalName || 'Seller', left, topY, { width: width / 2 - 8 });
    doc.font('Helvetica').fontSize(9);
    if (seller.address) doc.text(seller.address, { width: width / 2 - 8 });
    if (seller.gstin) doc.text(`GSTIN: ${seller.gstin}`);
    if (seller.stateCode) doc.text(`State: ${stateLine(seller.stateCode)}`);
    const sellerEnd = doc.y;

    doc.font('Helvetica').fontSize(9);
    const meta = [['Invoice no.', inv.number], ['Invoice date', day(inv.issuedAt)], ['Due date', day(inv.dueDate)]];
    let y = topY;
    for (const [k, v] of meta) { doc.fillColor('#555').text(k, left + width / 2 + 8, y, { width: 80 }).fillColor('#000').font('Helvetica-Bold').text(String(v), left + width / 2 + 92, y, { width: width / 2 - 92 }).font('Helvetica'); y += 14; }

    doc.y = Math.max(sellerEnd, y) + 14;
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#ccc').stroke().strokeColor('#000');
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555').text('BILL TO', left).fillColor('#000');
    doc.font('Helvetica-Bold').fontSize(11).text(buyer.legalName || inv.businessName || 'Customer');
    doc.font('Helvetica').fontSize(9);
    if (buyer.address) doc.text(buyer.address, { width: width / 2 });
    if (buyer.gstin) doc.text(`GSTIN: ${buyer.gstin}`);
    if (buyer.stateCode) doc.text(`Place of supply: ${stateLine(buyer.stateCode)}`);

    doc.moveDown(1);
    const colX = [left, left + 270, left + 330, left + 400];
    const header = ['Description', 'SAC', 'Qty', 'Taxable value'];
    doc.rect(left, doc.y, width, 18).fill('#f2f2f2').fillColor('#000');
    const hy = doc.y + 5;
    doc.font('Helvetica-Bold').fontSize(9);
    header.forEach((h, i) => doc.text(h, colX[i] + 4, hy, { width: i === 3 ? right - colX[i] - 8 : colX[i + 1] - colX[i] - 8, align: i === 3 ? 'right' : 'left' }));
    doc.y = hy + 18;
    doc.font('Helvetica').fontSize(9);
    const period = inv.periodStart && inv.periodEnd ? `\n${day(inv.periodStart)} to ${day(inv.periodEnd)}` : '';
    const rowY = doc.y;
    doc.text(`${inv.description || 'Platform subscription'}${period}`, colX[0] + 4, rowY, { width: 262 });
    const rowEnd = doc.y;
    doc.text(inv.sac || '', colX[1] + 4, rowY, { width: 56 }).text('1', colX[2] + 4, rowY, { width: 60 }).text(money(inv.amount, inv.currency), colX[3] + 4, rowY, { width: right - colX[3] - 8, align: 'right' });
    doc.y = Math.max(rowEnd, rowY + 12) + 8;
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#ccc').stroke().strokeColor('#000');
    doc.moveDown(0.5);

    const line = (label, value, bold = false) => {
      const ly = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).text(label, left + 250, ly, { width: 150 }).text(value, left + 400, ly, { width: right - left - 400, align: 'right' });
      doc.y = ly + (bold ? 18 : 14);
    };
    line('Taxable value', money(inv.amount, inv.currency));
    if (inv.cgst) line(`CGST @ ${inv.taxRate / 2}%`, money(inv.cgst, inv.currency));
    if (inv.sgst) line(`SGST @ ${inv.taxRate / 2}%`, money(inv.sgst, inv.currency));
    if (inv.igst) line(`IGST @ ${inv.taxRate}%`, money(inv.igst, inv.currency));
    line('Total', money(total, inv.currency), true);
    if ((inv.refundedAmount || 0) > 0) line('Refunded', `- ${money(inv.refundedAmount, inv.currency)}`);

    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Amount in words: ${amountInWords(total)}`, left, doc.y, { width }).fillColor('#000');
    if (inv.status === 'paid') doc.moveDown(0.4).text(`Paid on ${day(inv.paidAt)}${inv.reference ? ` (ref. ${inv.reference})` : ''}.`);
    if (inv.notes) { doc.moveDown(1).font('Helvetica-Bold').text('Payment details and notes').font('Helvetica').text(inv.notes, { width }); }
    doc.fontSize(8).fillColor('#777').text('This is a computer-generated invoice.', left, doc.page.height - 70, { width, align: 'center' });
    doc.end();
  });
}

/**
 * The credit note for one refund. It names the original invoice, and shows the refund's taxable value and tax lines (the
 * same split as the invoice), so the figures an accountant files against the invoice reconcile.
 */
function renderCreditNote(inv, refund, { compress = true } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, compress, info: { Title: `Credit note ${refund.number}`, Author: (inv.seller && inv.seller.legalName) || 'Credit note' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const seller = inv.seller || {};
    const buyer = inv.buyer || {};
    const taxed = (refund.tax || 0) > 0;
    const left = 48;
    const right = doc.page.width - 48;
    const width = right - left;
    const rate = inv.taxRate || 0;

    doc.font('Helvetica-Bold').fontSize(18).text(taxed ? 'CREDIT NOTE' : 'REFUND NOTE', left, 48);
    doc.moveDown(1.2);
    const topY = doc.y;
    doc.font('Helvetica-Bold').fontSize(11).text(seller.legalName || 'Seller', left, topY, { width: width / 2 - 8 });
    doc.font('Helvetica').fontSize(9);
    if (seller.address) doc.text(seller.address, { width: width / 2 - 8 });
    if (seller.gstin) doc.text(`GSTIN: ${seller.gstin}`);
    if (seller.stateCode) doc.text(`State: ${stateLine(seller.stateCode)}`);
    const sellerEnd = doc.y;
    let y = topY;
    for (const [k, v] of [['Credit note no.', refund.number], ['Date', day(refund.at)], ['Against invoice', inv.number], ['Invoice date', day(inv.issuedAt)]]) {
      doc.fillColor('#555').text(k, left + width / 2 + 8, y, { width: 90 }).fillColor('#000').font('Helvetica-Bold').text(String(v), left + width / 2 + 102, y, { width: width / 2 - 102 }).font('Helvetica');
      y += 14;
    }
    doc.y = Math.max(sellerEnd, y) + 14;
    doc.moveTo(left, doc.y).lineTo(right, doc.y).strokeColor('#ccc').stroke().strokeColor('#000');
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#555').text('CREDITED TO', left).fillColor('#000');
    doc.font('Helvetica-Bold').fontSize(11).text(buyer.legalName || inv.businessName || 'Customer');
    doc.font('Helvetica').fontSize(9);
    if (buyer.address) doc.text(buyer.address, { width: width / 2 });
    if (buyer.gstin) doc.text(`GSTIN: ${buyer.gstin}`);
    if (buyer.stateCode) doc.text(`Place of supply: ${stateLine(buyer.stateCode)}`);
    doc.moveDown(1);
    doc.font('Helvetica-Bold').text('Reason');
    doc.font('Helvetica').text(refund.reason || '', { width });
    doc.moveDown(1);

    const line = (label, value, bold = false) => {
      const ly = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).text(label, left + 250, ly, { width: 150 }).text(value, left + 400, ly, { width: right - left - 400, align: 'right' });
      doc.y = ly + (bold ? 18 : 14);
    };
    line('Taxable value credited', money(refund.exTax != null ? refund.exTax : refund.amount, inv.currency));
    if (refund.cgst) line(`CGST @ ${rate / 2}%`, money(refund.cgst, inv.currency));
    if (refund.sgst) line(`SGST @ ${rate / 2}%`, money(refund.sgst, inv.currency));
    if (refund.igst) line(`IGST @ ${rate}%`, money(refund.igst, inv.currency));
    line('Total credited', money(refund.amount, inv.currency), true);
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9).fillColor('#333').text(`Amount in words: ${amountInWords(refund.amount)}`, left, doc.y, { width }).fillColor('#000');
    doc.fontSize(8).fillColor('#777').text('This is a computer-generated credit note.', left, doc.page.height - 70, { width, align: 'center' });
    doc.end();
  });
}

module.exports = { renderInvoice, renderCreditNote };
