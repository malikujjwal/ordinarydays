import { describe, expect, it } from 'vitest';
import { NEW_LIST_ROUTE_OPTIONS } from './listRoutes';

describe('the new-list route presentation', () => {
  it('keeps the Lists screen visible behind the sheet scrim', () => {
    expect(NEW_LIST_ROUTE_OPTIONS).toMatchObject({
      presentation: 'transparentModal',
      contentStyle: { backgroundColor: 'transparent' },
    });
  });
});
