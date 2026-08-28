import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type {
  ItemStateMode,
  List,
  ListFeatureConfig,
  ListItem,
  ListItemFeatures,
  ListItemState,
  ListSubItem,
  ProgressValue,
} from '../types/list.js';
import {
  itemStateMode,
  type list,
  type listFeatureConfig,
  type listItem,
  listItemFeatures,
  type listItemState,
  listSubItem,
  patchListInput,
  patchListItemInput,
  progressValue,
} from './list.js';

describe('P3-33 canonical List schemas', () => {
  it('pins every public type in both directions', () => {
    expectTypeOf<z.infer<typeof listItemState>>().toEqualTypeOf<ListItemState>();
    expectTypeOf<z.infer<typeof itemStateMode>>().toEqualTypeOf<ItemStateMode>();
    expectTypeOf<z.infer<typeof progressValue>>().toEqualTypeOf<ProgressValue>();
    expectTypeOf<z.infer<typeof listSubItem>>().toEqualTypeOf<ListSubItem>();
    expectTypeOf<z.infer<typeof listItemFeatures>>().toEqualTypeOf<ListItemFeatures>();
    expectTypeOf<z.infer<typeof listFeatureConfig>>().toEqualTypeOf<ListFeatureConfig>();
    expectTypeOf<z.infer<typeof list>>().toEqualTypeOf<List>();
    expectTypeOf<z.infer<typeof listItem>>().toEqualTypeOf<ListItem>();
  });

  it('keeps groupByState inside the stages arm', () => {
    expect(itemStateMode.safeParse({ mode: 'none', groupByState: true }).success).toBe(
      false,
    );
    expect(itemStateMode.safeParse({ mode: 'checkbox', labels: {} }).success).toBe(false);
    expect(
      itemStateMode.safeParse({
        mode: 'stages',
        labels: { open: 'Saved', active: 'In progress', done: 'Done' },
        groupByState: false,
      }).success,
    ).toBe(true);
  });

  it('accepts typed features and rejects generic value/rows blobs and recursive sub-items', () => {
    expect(progressValue.safeParse({ kind: 'text', value: 'Page 143' }).success).toBe(
      true,
    );
    expect(
      progressValue.safeParse({ kind: 'episode', season: 2, episode: 4 }).success,
    ).toBe(true);
    expect(
      progressValue.safeParse({ kind: 'text', value: 'Page 143', season: 2 }).success,
    ).toBe(false);
    expect(listItemFeatures.safeParse({ value: 'Page 143' }).success).toBe(false);
    expect(listItemFeatures.safeParse({ rows: [] }).success).toBe(false);
    expect(
      listSubItem.safeParse({ id: 'sub_a', title: 'Paint', rank: 'V', state: 'open' })
        .success,
    ).toBe(false);
  });

  it('allows independent immediate settings patches and item feature/state writes', () => {
    expect(patchListInput.safeParse({ itemStateMode: { mode: 'none' } }).success).toBe(
      true,
    );
    expect(
      patchListInput.safeParse({
        featureConfig: { progress: { enabled: false, kind: 'text' } },
      }).success,
    ).toBe(true);
    expect(patchListInput.safeParse({ behaviour: 'watch' }).success).toBe(false);
    expect(patchListItemInput.safeParse({ state: 'active' }).success).toBe(true);
    expect(
      patchListItemInput.safeParse({
        features: { progress: { kind: 'text', value: 'Page 143' } },
      }).success,
    ).toBe(true);
    expect(patchListItemInput.safeParse({ checked: true }).success).toBe(false);
  });
});
