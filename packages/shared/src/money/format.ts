/**
 * Display formatting for integer minor units (`coding-standards.md` §3.2).
 *
 * Division here is only for a string a person reads — the value is never stored or compared.
 * `toFixed`, `parseFloat`, and `Intl` are all banned; the mock's integer division plus
 * `padStart` is the shape, and currency is appended the way `changeActivityKind`'s local
 * `formatPrice` did so existing strings stay byte-identical (`42.00 GBP`).
 */
export function formatMinorUnits(
  cents: number,
  currency?: string,
  minorUnits = 2,
): string {
  const factor = 10 ** minorUnits;
  const whole = Math.trunc(cents / factor);
  const frac = cents % factor;
  const amount = `${whole}.${String(frac).padStart(minorUnits, '0')}`;
  return currency === undefined ? amount : `${amount} ${currency}`;
}
