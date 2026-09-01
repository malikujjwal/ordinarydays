import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyPlansStore, mergePlansResponse } from '@od/shared/client';
import type { WallDate } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  needsDateLine,
  pastSectionsFromStore,
  upcomingSectionsFromStore,
} from './plansStages';

const TODAY = '2026-08-06' as WallDate;

const item = (id: string, title: string): AgendaItem =>
  ({
    activityId: `act_01J8SEED${'0'.repeat(16)}${id}`,
    type: 'event',
    title,
    status: 'scheduled',
    isRecurring: false,
    isSnoozed: false,
    hasCheckbox: false,
    capabilities: { complete: true, skip: false, snooze: false },
    participantAvatars: [],
    participantCount: 0,
    isPast: false,
  }) as AgendaItem;

function storeWith(days: { date: string; items: AgendaItem[] }[], past = false) {
  return mergePlansResponse(emptyPlansStore, {
    mode: 'initial',
    needsDate: [],
    upcoming: past ? [] : days,
    upcomingWindow: { from: '2026-08-06', through: '2026-10-06', nextFrom: null },
    past: past ? days : [],
    pastPage: {},
    warnings: [],
  } as never);
}

describe('needsDateLine', () => {
  it('reads No date yet with the suggestion count as content when one exists', () => {
    expect(needsDateLine(0)).toBe('No date yet');
    expect(needsDateLine(1)).toBe('No date yet — 1 suggestion');
    expect(needsDateLine(2)).toBe('No date yet — 2 suggestions');
  });
});

describe('upcomingSectionsFromStore', () => {
  it('groups covered dates ascending with interior gaps, ignoring dates outside the window', () => {
    const store = storeWith([
      { date: '2026-08-19', items: [item('AA', 'First')] },
      { date: '2026-08-25', items: [item('AB', 'Second')] },
    ]);
    const sections = upcomingSectionsFromStore(
      store,
      '2026-08-06' as WallDate,
      '2026-10-06' as WallDate,
    );
    const flat = sections.flatMap((section) => section.data);
    expect(flat.map((entry) => entry.kind)).toEqual(['date', 'gap', 'date']);
    expect(flat[1]).toMatchObject({ from: '2026-08-20', to: '2026-08-24' });

    // A date past the window's end renders nothing and claims no gap beside it.
    const clipped = upcomingSectionsFromStore(
      store,
      '2026-08-06' as WallDate,
      '2026-08-20' as WallDate,
    );
    expect(clipped.flatMap((section) => section.data)).toHaveLength(1);
  });
});

describe('pastSectionsFromStore', () => {
  it('orders strictly-before-today dates descending under month headings', () => {
    const store = storeWith(
      [
        { date: '2026-07-25', items: [item('AC', 'July trip')] },
        { date: '2026-08-01', items: [item('AD', 'August lunch')] },
        // Today itself belongs to Upcoming, never Past.
        { date: '2026-08-06', items: [item('AE', 'Today plan')] },
      ],
      true,
    );
    const sections = pastSectionsFromStore(store, TODAY);
    expect(sections.map((section) => section.title)).toEqual(['August', 'July']);
    expect(sections[0]?.data[0]).toMatchObject({
      date: '2026-08-01',
      label: 'Sat 1 Aug',
    });
    expect(sections.flatMap((section) => section.data.map((day) => day.date))).toEqual([
      '2026-08-01',
      '2026-07-25',
    ]);
  });

  it('carries the year for months outside the current one', () => {
    const store = storeWith(
      [{ date: '2025-12-31', items: [item('AF', 'Old year')] }],
      true,
    );
    expect(pastSectionsFromStore(store, TODAY)[0]?.title).toBe('December 2025');
  });
});

/**
 * The §1.3.2 chrome grep, P2-28's shape: the Plans stage modules contain no badge component
 * and no numeric count bound to a stage length. Source-level because the rule is about what
 * the code cannot express, not what a fixture happens to render — the spec's directory
 * (`src/features/plans/`) became these agenda-slice modules when the screen stayed beside
 * the AgendaRow it renders; the grep covers the same surface.
 */
describe('plans stage chrome', () => {
  const read = (relative: string): string =>
    readFileSync(join(__dirname, '..', relative), 'utf8');

  const surfaces = [
    'components/PlansScreen.tsx',
    'components/NeedsDateCard.tsx',
    'hooks/usePlans.ts',
    'model/plansStages.ts',
    'model/rsvpSummary.ts',
  ];

  it('contains no badge component and no stage-length count binding', () => {
    for (const relative of surfaces) {
      const source = read(relative);
      expect(source, relative).not.toMatch(/Badge/);
      // A `.length` interpolated into a label, heading or segment is a stage count.
      expect(source, relative).not.toMatch(/label\s*[:=][^,\n]*\.length/);
      expect(source, relative).not.toMatch(/count\s*:\s*\w+\.length/);
    }
  });

  it('passes the switcher its three words and no count', () => {
    const source = read('components/PlansScreen.tsx');
    expect(source).toMatch(
      /segments=\{STAGES\.map\(\(\{ label \}\) => \(\{ label \}\)\)\}/,
    );
    // No `count` travels into the switcher's segments — the mapping above is label-only,
    // and no other expression is handed to it.
    expect(source).not.toMatch(/segments=[^>]*count/);
    expect(source).not.toMatch(/STAGES[^;]*count/);
  });
});
