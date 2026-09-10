/**
 * Display formatting for integer minor units (`coding-standards.md` §3.2).
 *
 * Division here is only for a string a person reads — the value is never stored or compared.
 * `toFixed`, `parseFloat`, and `Intl` are all banned; the mock's integer division plus
 * `padStart` is the shape, and currency is appended the way `changeActivityKind`'s local
 * `formatPrice` did so existing strings stay byte-identical (`42.00 GBP`).
 *
 * `minorUnits === 0` has no decimal point. A negative amount uses a leading minus and the
 * absolute remainder so `-5` at 2 minor units is `-0.05`, not `0.-5`. Callers that do not
 * pass `minorUnits` keep the default of 2; this helper does not look up ISO currencies.
 */
export function formatMinorUnits(
  cents: number,
  currency?: string,
  minorUnits = 2,
): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const factor = 10 ** minorUnits;
  const whole = Math.trunc(abs / factor);
  const frac = abs % factor;
  const amount =
    minorUnits === 0
      ? `${sign}${whole}`
      : `${sign}${whole}.${String(frac).padStart(minorUnits, '0')}`;
  return currency === undefined ? amount : `${amount} ${currency}`;
}
