'use strict';

// HTTP Basic Auth middleware. Any username is accepted; only the password counts.

const crypto = require('node:crypto');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

function basicAuth(password) {
  const expected = sha256(password);

  return (req, res, next) => {
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      // Compare hashes so the comparison is constant-time and equal-length.
      if (colon !== -1 && crypto.timingSafeEqual(sha256(decoded.slice(colon + 1)), expected)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="CoD Tournament admin", charset="UTF-8"');
    res.status(401).json({ error: 'Authentication required' });
  };
}

module.exports = { basicAuth };
