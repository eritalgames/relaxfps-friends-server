'use strict';
const crypto = require('crypto');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    out += alphabet[parseInt(chunk, 2)];
  }
  return out;
}
const secret = base32(crypto.randomBytes(20));
const issuer = encodeURIComponent('RELAXFPS Admin Studio');
const account = encodeURIComponent(process.argv[2] || 'admin');
console.log(`RELAXFPS_ADMIN_TOTP_SECRET=${secret}`);
console.log(`otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`);
