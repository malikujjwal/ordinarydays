import { describe, expect, it } from 'vitest';
import {
  featureEnabled,
  LIST_ITEM_FEATURE_REGISTRY,
  visitEnabledFeatureEditors,
} from './featureRegistry';

describe('the configuration-driven List feature registry', () => {
  it('owns the enable gate for every supported feature key', () => {
    expect(
      featureEnabled('progress', { progress: { enabled: true, kind: 'episode' } }),
    ).toBe(true);
    expect(featureEnabled('place', { place: { enabled: false } })).toBe(false);
    expect(
      featureEnabled('subItems', {
        subItems: { enabled: true, sectionLabel: 'Stops', singularLabel: 'Stop' },
      }),
    ).toBe(true);
  });

  it('owns editor dispatch in the same ordered registry as row summaries', () => {
    const rendered = visitEnabledFeatureEditors(
      {
        progress: { enabled: true, kind: 'text' },
        place: { enabled: false },
        subItems: {
          enabled: true,
          sectionLabel: 'Stops',
          singularLabel: 'Stop',
        },
      },
      {},
      {
        progress: () => 'progress editor',
        place: () => 'place editor',
        subItems: () => 'sub-items editor',
      },
    );

    expect(rendered).toEqual(['progress editor', 'sub-items editor']);
  });

  it('summarizes only Progress values matching the configured kind', () => {
    const progress = LIST_ITEM_FEATURE_REGISTRY.progress;
    const episode = { enabled: true, kind: 'episode' } as const;

    expect(
      progress.summary(episode, {
        kind: 'episode',
        mediaKind: 'show',
        season: 2,
        episode: 4,
      }),
    ).toBe('S2 E4');
    expect(progress.spoken(episode, { kind: 'episode', season: 2, episode: 4 })).toBe(
      'season 2 episode 4',
    );
    expect(
      progress.summary(episode, { kind: 'text', value: 'Page 143' }),
    ).toBeUndefined();
  });

  it('uses one Place projection for visible and spoken summaries', () => {
    const place = LIST_ITEM_FEATURE_REGISTRY.place;
    const config = { enabled: true } as const;
    const value = { label: 'Library', address: '10 Main St' };

    expect(place.summary(config, value)).toBe('10 Main St');
    expect(place.spoken(config, { label: 'Library' })).toBe('Library');
  });

  it('uses configured Sub-item vocabulary for singular and plural counts', () => {
    const subItems = LIST_ITEM_FEATURE_REGISTRY.subItems;
    const config = {
      enabled: true,
      sectionLabel: 'Stops',
      singularLabel: 'Stop',
    } as const;

    expect(
      subItems.summary(config, {
        entries: [{ id: 'sub_1', title: 'Museum', rank: 'a' }],
      }),
    ).toBe('1 Stop');
    expect(
      subItems.spoken(config, {
        entries: [
          { id: 'sub_1', title: 'Museum', rank: 'a' },
          { id: 'sub_2', title: 'Cafe', rank: 'b' },
        ],
      }),
    ).toBe('2 Stops');
  });
});
