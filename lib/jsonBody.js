const express = require('express');

/**
 * The server's JSON body parser. Kept here (not inline in index.js) so the tests run the very same settings.
 *
 * A request with a JSON content type and no body at all (for example a button that only POSTs "do this", like
 * confirming setup) is valid and yields an empty `req.body`. Only a body that is present but malformed is rejected.
 */
function jsonBodyParser() {
  return express.json({
    limit: '10mb',
    strict: true,
    verify: (req, res, buf) => {
      if (!buf || buf.length === 0 || buf.toString('utf8').trim() === '') return;
      try {
        JSON.parse(buf.toString('utf8'));
      } catch (e) {
        console.error('JSON parse error:', e.message);
        console.error('Invalid JSON at position:', e.message.match(/position (\d+)/)?.[1] || 'unknown');
        // a client error, not a server fault: a SyntaxError carrying status 400 is what the error handlers in index.js answer as 400
        const err = new SyntaxError(`Invalid JSON: ${e.message}`);
        err.status = 400;
        err.statusCode = 400;
        err.body = buf.toString('utf8');
        throw err;
      }
    }
  });
}

module.exports = { jsonBodyParser };
