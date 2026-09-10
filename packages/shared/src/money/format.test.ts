import { describe, expect, it } from 'vitest';
import { formatMinorUnits } from './format.js';

describe('formatMinorUnits', () => {
  it('renders a stored zero as 0.00 rather than Free', () => {
    expect(formatMinorUnits(0, 'GBP')).toBe('0.00 GBP');
  });

  it('appends currency the way formatPrice did, so strings can match', () => {
    expect(formatMinorUnits(4200, 'GBP')).toBe('42.00 GBP');
    expect(formatMinorUnits(3750, 'GBP')).toBe('37.50 GBP');
  });

  it('omits currency when it is not supplied', () => {
    expect(formatMinorUnits(0)).toBe('0.00');
    expect(formatMinorUnits(5)).toBe('0.05');
    expect(formatMinorUnits(100)).toBe('1.00');
  });

  it('honours an explicit minor-unit count instead of assuming 2', () => {
    expect(formatMinorUnits(1234, 'BHD', 3)).toBe('1.234 BHD');
    expect(formatMinorUnits(4200, 'GBP', 2)).toBe('42.00 GBP');
  });
});
