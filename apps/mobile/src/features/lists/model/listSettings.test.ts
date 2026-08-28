import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  mergedFeatureConfig,
  settlePendingSettings,
  stageMode,
  withoutPendingSettings,
  withPendingSettings,
} from './listSettings';

const LIST: List = {
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'blank',
  title: 'Ideas',
  icon: 'list',
  emptyStateCopy: 'Add an item.',
  itemStateMode: { mode: 'none' },
  featureConfig: {
    progress: { enabled: false, kind: 'text' },
    subItems: {
      enabled: false,
      sectionLabel: 'Materials',
      singularLabel: 'Material',
      secondaryLabel: 'Quantity',
    },
  },
  slot: null,
  itemCount: 0,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-28T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-28T09:00:00.000Z'),
};

describe('canonical List settings overlay', () => {
  it('defaults manually enabled stages to Saved / In progress / Done', () => {
    expect(stageMode()).toEqual({
      mode: 'stages',
      labels: { open: 'Saved', active: 'In progress', done: 'Done' },
      groupByState: false,
    });
  });

  it('retains an existing staged vocabulary when reselecting Stages', () => {
    const current = {
      mode: 'stages',
      labels: { open: 'Queued', active: 'Building', done: 'Shipped' },
      groupByState: true,
    } as const;
    expect(stageMode(current)).toEqual(current);
  });

  it('merges keyed configuration without erasing disabled siblings', () => {
    const merged = mergedFeatureConfig(LIST, { place: { enabled: true } });
    expect(merged.progress).toEqual(LIST.featureConfig.progress);
    expect(merged.subItems).toEqual(LIST.featureConfig.subItems);
    expect(merged.place).toEqual({ enabled: true });
  });

  it('draws optimistic settings without touching item aggregates or provenance', () => {
    const view = withPendingSettings(LIST, {
      itemStateMode: { mode: 'checkbox' },
      featureConfig: { ...LIST.featureConfig, progress: { enabled: true, kind: 'text' } },
      slot: 'watch',
    });
    expect(view.itemStateMode).toEqual({ mode: 'checkbox' });
    expect(view.doneCount).toBe(LIST.doneCount);
    expect(view.templateKey).toBe('blank');
  });

  it('settles only fields the committed row has acknowledged', () => {
    const pending = { title: 'New', itemStateMode: { mode: 'checkbox' } as const };
    expect(settlePendingSettings(pending, { ...LIST, title: 'New' })).toEqual({
      itemStateMode: { mode: 'checkbox' },
    });
    expect(withoutPendingSettings(pending, { title: 'New' })).toEqual({
      itemStateMode: { mode: 'checkbox' },
    });
  });
});
