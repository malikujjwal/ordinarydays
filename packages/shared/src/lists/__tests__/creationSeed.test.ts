import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ListTemplate } from '../../types/list.js';
import { type ListTemplateSeed, listTemplateSeed } from '../creationSeed.js';
import { LIST_TEMPLATES } from '../templates.js';

describe('listTemplateSeed', () => {
  it('copies only stored configuration and presentation fields', () => {
    expectTypeOf<ListTemplateSeed>().toEqualTypeOf<
      Pick<
        ListTemplate,
        'itemStateMode' | 'featureConfig' | 'slot' | 'icon' | 'emptyStateCopy'
      >
    >();
    const seed = listTemplateSeed('watch-later');
    expect(seed).toEqual({
      itemStateMode: LIST_TEMPLATES[3].itemStateMode,
      featureConfig: LIST_TEMPLATES[3].featureConfig,
      slot: 'watch',
      icon: 'play-rect',
      emptyStateCopy: 'Add a movie or show.',
    });
  });

  it('does not fall back for an unknown or legacy provenance key', () => {
    expect(listTemplateSeed('simple-list')).toBeUndefined();
    expect(listTemplateSeed('watchlist')).toBeUndefined();
    expect(listTemplateSeed('unknown')).toBeUndefined();
  });
});
