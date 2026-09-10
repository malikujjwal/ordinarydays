/**
 * Parse a typed money string into integer minor units (`coding-standards.md` §3.2).
 *
 * Digits and at most one `.` separator. No `parseFloat`, no `Number('1.50')`, no rounding.
 * Extra fractional digits are refused rather than truncated — silently dropping a typed
 * digit is the class of bug the money rules exist to prevent. A leading sign is refused:
 * Event price is non-negative, and stripping `-` would invent a positive amount.
 *
 * Callers that omit `minorUnits` keep the default of 2. This helper does not look up ISO
 * currencies; zero-decimal callers pass `0` explicitly.
 */
export function parseMinorUnits(text: string, minorUnits = 2): number | undefined {
  const raw = text.trim();
  if (raw === '') return undefined;
  if (raw.startsWith('-') || raw.startsWith('+')) return undefined;

  let seenSeparator = false;
  let wholeCount = 0;
  let fractionCount = 0;
  const digits: number[] = [];

  for (const ch of raw) {
    if (ch === '.') {
      if (minorUnits === 0 || seenSeparator || wholeCount === 0) return undefined;
      seenSeparator = true;
      continue;
    }
    const digit = ch.charCodeAt(0) - 48;
    if (digit < 0 || digit > 9) return undefined;
    if (seenSeparator) {
      fractionCount += 1;
      if (fractionCount > minorUnits) return undefined;
    } else {
      wholeCount += 1;
    }
    digits.push(digit);
  }

  const pad = seenSeparator ? minorUnits - fractionCount : minorUnits;
  for (let i = 0; i < pad; i += 1) digits.push(0);

  let value = 0;
  for (const digit of digits) {
    value = value * 10 + digit;
    if (!Number.isSafeInteger(value)) return undefined;
  }
  return value;
}
