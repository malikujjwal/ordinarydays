import { describe, expect, it } from 'vitest';
import * as onlineProjection from './useDeleteListItem';
import * as nativeProjection from './useDeleteListItem.native';

describe('delete item platform boundary', () => {
  it('keeps both platform forks on the same public export surface', () => {
    expect(Object.keys(nativeProjection).sort()).toEqual(
      Object.keys(onlineProjection).sort(),
    );
  });
});
