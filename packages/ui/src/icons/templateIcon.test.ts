import { describe, expect, it } from 'vitest';
import { templateIcons } from './index';
import { templateIcon } from './templateIcon';

describe('the template icon resolver', () => {
  it('returns a named catalogue glyph', () => {
    expect(templateIcon('bag')).toBe(templateIcons.bag);
  });

  it('returns the generic List glyph for an unknown stored name', () => {
    expect(templateIcon('future-catalogue-icon')).toBe(templateIcons.list);
  });
});
