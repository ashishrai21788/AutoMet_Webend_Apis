// GST maths, GSTIN rules, amount in words, and the PDF. Pure functions: no database. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const gst = require('../lib/gst');
const { renderInvoice, renderCreditNote } = require('../lib/invoicePdf');

test('GSTIN: format, state prefix and rejects', () => {
  assert.equal(gst.isGstin('27AAPFU0939F1ZV'), true);
  assert.equal(gst.isGstin(' 27aapfu0939f1zv '), true, 'case and spaces are tolerated');
  assert.equal(gst.stateOfGstin('27AAPFU0939F1ZV'), '27');
  for (const bad of ['', '27AAPFU0939F1Z', '27AAPFU0939F1ZVV', '99AAPFU0939F1ZV', 'ABAAPFU0939F1ZV', '27AAPFU0939F1AV', null, undefined]) assert.equal(gst.isGstin(bad), false, String(bad));
  assert.equal(gst.isStateCode('27'), true);
  assert.equal(gst.isStateCode('25'), false);
});

test('tax: within the seller\'s state it is CGST + SGST, elsewhere IGST, and the parts always add up', () => {
  const intra = gst.computeTax({ taxable: 1000, rate: 18, sellerGstin: '27AAPFU0939F1ZV', buyerStateCode: '27' });
  assert.deepEqual(intra, { rate: 18, supply: 'intra', taxable: 1000, cgst: 90, sgst: 90, igst: 0, taxAmount: 180, total: 1180 });
  const inter = gst.computeTax({ taxable: 1000, rate: 18, sellerGstin: '27AAPFU0939F1ZV', buyerStateCode: '29' });
  assert.deepEqual(inter, { rate: 18, supply: 'inter', taxable: 1000, cgst: 0, sgst: 0, igst: 180, taxAmount: 180, total: 1180 });
  // an odd paisa goes to SGST so cgst + sgst === tax
  const odd = gst.computeTax({ taxable: 0.05, rate: 18, sellerGstin: '27AAPFU0939F1ZV', buyerStateCode: '27' });
  assert.equal(odd.taxAmount, 0.01);
  assert.equal(odd.cgst + odd.sgst, odd.taxAmount);
  const messy = gst.computeTax({ taxable: 1234.57, rate: 18, sellerGstin: '27AAPFU0939F1ZV', buyerStateCode: '27' });
  assert.equal(messy.taxAmount, 222.22);
  assert.equal(Math.round((messy.cgst + messy.sgst) * 100) / 100, messy.taxAmount);
  assert.equal(messy.total, 1456.79);
});

test('no GSTIN of its own, or a 0% rate: no tax', () => {
  assert.deepEqual(gst.computeTax({ taxable: 500, rate: 18, sellerGstin: '', buyerStateCode: '27' }), { rate: 0, supply: 'none', taxable: 500, cgst: 0, sgst: 0, igst: 0, taxAmount: 0, total: 500 });
  assert.equal(gst.computeTax({ taxable: 500, rate: 0, sellerGstin: '27AAPFU0939F1ZV', buyerStateCode: '27' }).total, 500);
});

test('amount in words, with Indian grouping', () => {
  assert.equal(gst.amountInWords(1180), 'Rupees One Thousand One Hundred Eighty Only');
  assert.equal(gst.amountInWords(0), 'Rupees Zero Only');
  assert.equal(gst.amountInWords(125000.5), 'Rupees One Lakh Twenty Five Thousand and Fifty Paise Only');
  assert.equal(gst.amountInWords(10000000), 'Rupees One Crore Only');
  assert.equal(gst.amountInWords(19.01), 'Rupees Nineteen and One Paise Only');
});

// pdfkit writes text as hex strings inside the page stream; this reads them back into plain text
const pdfText = (buf) => [...buf.toString('latin1').matchAll(/<([0-9a-fA-F]{2,})>/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');

test('PDF: a real PDF carrying the seller, buyer, tax lines and totals; a no-GST invoice says INVOICE, not TAX INVOICE', async () => {
  const base = {
    number: 'INV-000007', description: 'Platform subscription', periodStart: '2026-10-01', periodEnd: '2026-10-31', issuedAt: '2026-10-02', dueDate: '2026-10-16',
    currency: 'INR', status: 'issued', amount: 1000, refundedAmount: 0, sac: '998314',
    seller: { legalName: 'AutoMet Technologies Pvt Ltd', gstin: '27AAPFU0939F1ZV', address: '1 Main Road, Mumbai', stateCode: '27' },
    buyer: { legalName: 'Alpha Cabs LLP', gstin: '27BBBBB1111B1Z5', address: '9 Lake Street, Pune', stateCode: '27' },
    taxRate: 18, taxAmount: 180, cgst: 90, sgst: 90, igst: 0, total: 1180, notes: 'Pay by bank transfer to account 1234.'
  };
  const buf = await renderInvoice(base, { compress: false });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const text = pdfText(buf);
  for (const needle of ['TAX INVOICE', 'INV-000007', 'AutoMet Technologies Pvt Ltd', '27AAPFU0939F1ZV', 'Alpha Cabs LLP', 'CGST @ 9%', 'SGST @ 9%', '1,180.00', 'Rupees One Thousand One Hundred Eighty Only', 'Pay by bank transfer']) assert.ok(text.includes(needle), needle);
  assert.ok(!text.includes('IGST'), 'no IGST line on an intra-state invoice');
  const plain = pdfText(await renderInvoice({ ...base, taxRate: 0, taxAmount: 0, cgst: 0, sgst: 0, total: 1000, seller: { legalName: 'AutoMet' } }, { compress: false }));
  assert.ok(plain.includes('INVOICE') && !plain.includes('TAX INVOICE'));
  const inter = pdfText(await renderInvoice({ ...base, cgst: 0, sgst: 0, igst: 180 }, { compress: false }));
  assert.ok(inter.includes('IGST @ 18%') && !inter.includes('CGST'));
});

test('credit note PDF: names the invoice it corrects and carries the refund own tax split', async () => {
  const inv = { number: 'INV-000007', issuedAt: '2026-10-02', currency: 'INR', taxRate: 18, seller: { legalName: 'AutoMet Technologies Pvt Ltd', gstin: '27AAPFU0939F1ZV', stateCode: '27' }, buyer: { legalName: 'Bengaluru Rides Pvt Ltd', gstin: '29ABCDE1234F1Z5', stateCode: '29' } };
  const text = pdfText(await renderCreditNote(inv, { number: 'CN-000003', at: '2026-10-09', amount: 118, exTax: 100, tax: 18, cgst: 0, sgst: 0, igst: 18, reason: 'Service outage credit' }, { compress: false }));
  for (const needle of ['CREDIT NOTE', 'CN-000003', 'INV-000007', 'Bengaluru Rides Pvt Ltd', 'Service outage credit', 'Taxable value credited', 'IGST @ 18%', '118.00', 'Rupees One Hundred Eighteen Only']) assert.ok(text.includes(needle), needle);
  assert.ok(!text.includes('CGST'));
  const plain = pdfText(await renderCreditNote({ ...inv, taxRate: 0 }, { number: 'CN-000004', at: '2026-10-09', amount: 50, exTax: 50, tax: 0, reason: 'No tax charged' }, { compress: false }));
  assert.ok(plain.includes('REFUND NOTE') && !plain.includes('CREDIT NOTE'));
});
