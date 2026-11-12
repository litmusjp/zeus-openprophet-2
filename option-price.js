// One decimal-safe normalizer for options limit prices, used by every options tool path (order, assessment,
// trade assessment) so the assessed price, the receipt identity and the broker submission are identical.
// Alpaca accepts whole cents only ("limit price must be limited to 2 decimal places", HTTP 422).
//
// A buy rounds DOWN to the cent (never above the agent's price). A sell rounds UP to the cent (never accepts less
// than the agent's price). A price that is already a whole-cent value is returned unchanged.

export function normalizeOptionLimitPrice(value, side) {
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be "buy" or "sell" to normalize a limit price');
  const number = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (value === null || value === undefined || value === '' || typeof value === 'boolean' || !Number.isFinite(number) || number <= 0) {
    throw new Error('limit_price must be a positive number');
  }
  // toFixed(8) absorbs binary floating point noise (9.364999999999999 reads as 9.36500000), then integer cents.
  const fixed = number.toFixed(8);
  const [whole, fraction] = fixed.split('.');
  let cents = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2));
  const leftover = /[1-9]/.test(fraction.slice(2));
  if (side === 'sell' && leftover) cents += 1n;
  if (cents <= 0n) throw new Error('limit_price is below one cent after rounding to the cent');
  return Number(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`);
}
