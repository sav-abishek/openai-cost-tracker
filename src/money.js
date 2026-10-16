'use strict';
// Integer picodollars: exact decimal accounting to 12 places, rounded only on display.
const SCALE = 1_000_000_000_000n;
function decimal(value) {
  const s = String(value);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) throw new Error('Invalid monetary value');
  const fraction = m[3] || '';
  const exponent = Number(m[4] || 0) - fraction.length + 12;
  if (Math.abs(exponent) > 100) throw new Error('Monetary exponent out of range');
  let n = BigInt(m[2] + fraction);
  n = exponent >= 0 ? n * 10n ** BigInt(exponent) : (n + 10n ** BigInt(-exponent) / 2n) / 10n ** BigInt(-exponent);
  return m[1] ? -n : n;
}
function format(value, digits = 2) {
  const negative = value < 0n; const n = negative ? -value : value;
  const div = 10n ** BigInt(12 - digits); const rounded = (n + div / 2n) / div;
  const s = rounded.toString().padStart(digits + 1, '0');
  return (negative ? '-' : '') + (digits ? s.slice(0, -digits) + '.' + s.slice(-digits) : s);
}
function convert(usd, rate) { return usd * decimal(rate) / SCALE; }
module.exports = { SCALE, decimal, format, convert };
