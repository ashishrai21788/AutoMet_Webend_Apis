/**
 * CSV for the dashboard's exports. Two things matter beyond quoting:
 *  - a cell that starts with = + - @ (or a tab or carriage return) would be run as a formula by Excel or Sheets, so it is
 *    prefixed with an apostrophe (spreadsheet injection);
 *  - a leading byte-order mark makes Excel read the file as UTF-8, so names in any language show correctly.
 * Numbers and dates keep their plain form; a missing value is an empty cell.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // a negative number is a number, not a formula
  if (FORMULA_START.test(s) && !(typeof value === 'number' && Number.isFinite(value))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns: [{ header, value: (row) => any }] */
function toCsv(rows, columns) {
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(c.value(row))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Sends a CSV as a download. */
function sendCsv(res, filename, csv) {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`, 'Cache-Control': 'no-store' });
  return res.status(200).send(csv);
}

module.exports = { cell, toCsv, sendCsv };
