import type { List, ListItemView } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  appendSubItem,
  itemNumber,
  itemSheetFields,
  moveSubItem,
  notePatch,
  placePatch,
  progressPatch,
  subItemsPatch,
  titlePatch,
} from './itemSheet';

const item = (overrides: Partial<ListItemView> = {}): ListItemView => ({
  itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3',
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  rank: 'a0',
  title: 'Book',
  state: 'open',
  ...overrides,
});

const list = (featureConfig: List['featureConfig']) => ({
  itemStateMode: { mode: 'none' } as const,
  featureConfig,
});

describe('item sheet feature registry inputs', () => {
  it('exposes editors only for enabled configuration', () => {
    expect(
      itemSheetFields(
        list({
          progress: { enabled: false, kind: 'text' },
          place: { enabled: true },
          subItems: { enabled: true, sectionLabel: 'Stops', singularLabel: 'Stop' },
        }),
      ),
    ).toEqual({ progress: false, place: true, subItems: true });
  });

  it('writes one typed feature path without replacing retained siblings', () => {
    const subject = item({
      features: {
        progress: { kind: 'text', value: 'Page 143' },
        place: { label: 'Library' },
      },
    });

    expect(placePatch(subject, 'Cafe', '12 Main St')).toEqual({
      features: { place: { label: 'Cafe', address: '12 Main St' } },
    });
    expect(progressPatch(subject, undefined)).toEqual({ features: { progress: null } });
    expect(subject.features?.progress).toEqual({ kind: 'text', value: 'Page 143' });
  });

  it('preserves Place coordinates while editing human text', () => {
    expect(
      placePatch(
        item({
          features: {
            place: {
              label: 'Old',
              address: 'Old address',
              lat: 40.1,
              lng: -73.2,
            },
          },
        }),
        'New',
        '',
      ),
    ).toEqual({
      features: { place: { label: 'New', lat: 40.1, lng: -73.2 } },
    });
  });

  it('keeps title/note clear semantics exact', () => {
    const subject = item({ note: 'Remember' });
    expect(titlePatch(subject, '  New title  ')).toEqual({ title: 'New title' });
    expect(notePatch(subject, '   ')).toEqual({ note: null });
    expect(titlePatch(subject, 'Book')).toBeUndefined();
  });

  it('creates bounded-domain children with stable ids and increasing ranks', () => {
    const first = appendSubItem([], 'sub_1');
    const second = appendSubItem(first, 'sub_2');
    expect(second.map((entry) => entry.id)).toEqual(['sub_1', 'sub_2']);
    expect((second[1]?.rank ?? '') > (second[0]?.rank ?? '')).toBe(true);
    expect(subItemsPatch(item(), second)).toEqual({
      features: { subItems: { entries: second } },
    });
  });

  it('reorders children without changing identity or nesting them as ListItems', () => {
    const entries = appendSubItem(appendSubItem([], 'sub_1'), 'sub_2');
    const moved = moveSubItem(entries, 1, 0);
    expect(moved.map((entry) => entry.id)).toEqual(['sub_2', 'sub_1']);
    expect((moved[1]?.rank ?? '') > (moved[0]?.rank ?? '')).toBe(true);
    expect(entries.map((entry) => entry.id)).toEqual(['sub_1', 'sub_2']);
  });

  it('accepts numeric controls only and never parses human progress text', () => {
    expect(itemNumber(' 12 ')).toBe(12);
    expect(itemNumber('S2 E4')).toBeUndefined();
    expect(itemNumber('2.5')).toBeUndefined();
  });
});
