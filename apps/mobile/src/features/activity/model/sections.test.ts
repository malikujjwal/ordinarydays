import type { Activity } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  detailRowsFor,
  planToTaskBlockedMessage,
  planToTaskBlockers,
  sectionsFor,
  subtitleFor,
  typeDetailChips,
} from './sections';

const activity = (patch: Partial<Activity>): Activity =>
  ({
    activityId: 'act_01J0000000000000000000000A',
    ownerId: 'usr_01J0000000000000000000000B',
    objectKind: 'plan',
    type: 'event',
    status: 'saved',
    title: 'Zahav',
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'event' },
    icsSequence: 0,
    createdAt: '2026-08-08T10:00:00.000Z',
    lastActivityAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
    schemaVersion: 1,
    ...patch,
  }) as Activity;

const task = () =>
  activity({ objectKind: 'task', type: 'task', details: { kind: 'task' } });

describe('a Task renders no placeholder for what it lacks', () => {
  /**
   * `today-and-tasks.md` §5.6 is explicit about this, and it is the assertion that stops
   * Task detail drifting into "Plan detail with things greyed out". Tasks are solo; showing
   * People disabled on one would teach the user a Task is a lesser Plan.
   */
  /** 2026-09-10: no `Related plan · None` row — a Task with no parent shows nothing. */
  it('shows only when/where and notes when it has no parent', () => {
    expect(sectionsFor(task()).map((s) => s.key)).toEqual(['whenWhere', 'notes']);
  });

  it("puts a parented Task's Details group before notes, and settings after", () => {
    expect(
      sectionsFor(
        activity({
          objectKind: 'task',
          type: 'task',
          details: { kind: 'task' },
          parentActivityId: 'act_01J0000000000000000000000P',
          schedule: { date: '2026-08-12', timezone: 'America/New_York' },
        }),
      ).map((s) => s.key),
    ).toEqual(['whenWhere', 'details', 'notes', 'repeat', 'reminders']);
  });

  it('adds the real reminder disclosure only when the Task has a date', () => {
    expect(sectionsFor(task()).map((s) => s.key)).not.toContain('reminders');
    expect(
      sectionsFor(
        activity({
          objectKind: 'task',
          type: 'task',
          details: { kind: 'task' },
          schedule: { date: '2026-08-12', timezone: 'America/New_York' },
        }),
      ).map((s) => s.key),
    ).toContain('reminders');
  });

  it('has no coming-soon section at all', () => {
    expect(sectionsFor(task()).every((s) => !('state' in s))).toBe(true);
  });

  it.each(['people', 'prep', 'lists', 'attachments', 'expenses', 'updates'])(
    'never renders %s',
    (key) => {
      expect(sectionsFor(task()).map((s) => s.key)).not.toContain(key);
    },
  );
});

describe('a Plan renders settings always and sections only once they hold content', () => {
  /** The 2026-08-25 amendment: a bare plan has no empty section headings, only settings. */
  it('renders settings and the two discovery rows on a bare plan', () => {
    // Attachments keeps the §2.2 pre-build discovery row while its P3-41 flow is unbuilt:
    // with no chip to offer, an empty plan must still signal it can hold photos.
    expect(sectionsFor(activity({})).map((s) => s.key)).toEqual([
      'whenWhere',
      'attachments-coming-later',
      'notes',
      'people',
    ]);
  });

  it('adds each content section exactly when its collection is populated', () => {
    const populated = sectionsFor(activity({}), {
      childCount: 2,
      sourceListCount: 1,
      attachmentCount: 4,
      updateCount: 1,
    }).map((s) => s.key);
    // 2026-09-10: content, then notes, then settings, then Updates last.
    expect(populated).toEqual([
      'whenWhere',
      'prep',
      'lists',
      'attachments',
      'notes',
      'people',
      'updates',
    ]);
  });

  /**
   * Founder clarification 2026-08-13, explicitly retained by the 2026-08-25 amendment:
   * `People` teaches the Plan's shape without a disabled Add or a working chevron. It is
   * the one unbuilt capability left with a `Coming later` row.
   */
  it('marks People and empty Attachments as coming later, and nothing else', () => {
    const sections = sectionsFor(activity({}));
    expect(sections).toContainEqual(
      expect.objectContaining({ key: 'people', state: 'coming-later' }),
    );
    expect(sections).toContainEqual(
      expect.objectContaining({ key: 'attachments-coming-later', state: 'coming-later' }),
    );
    expect(sections.filter((s) => s.state === 'coming-later')).toHaveLength(2);
  });

  /** With the picker wired (P3-41) the chip row discovers Attachments; no row, no heading. */
  it('drops the Attachments discovery row once the add flow is wired', () => {
    const keys = sectionsFor(activity({}), {
      childCount: 0,
      sourceListCount: 0,
      attachmentCount: 0,
      attachmentsWired: true,
      updateCount: 0,
    }).map((s) => s.key);
    expect(keys).not.toContain('attachments-coming-later');
    expect(keys).not.toContain('attachments');
  });

  it('replaces the Attachments discovery row with the real section once content exists', () => {
    const populated = sectionsFor(activity({}), {
      childCount: 0,
      sourceListCount: 0,
      attachmentCount: 1,
      updateCount: 0,
    }).map((s) => s.key);
    expect(populated).toContain('attachments');
    expect(populated).not.toContain('attachments-coming-later');
  });

  /** P3-43: the section exists exactly when the Meal has ingredient rows to add. */
  it('renders Ingredients only on a Meal plan that has ingredient rows', () => {
    const withRows = sectionsFor(
      activity({
        type: 'meal',
        details: {
          kind: 'meal',
          ingredients: [
            { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1', name: 'Chicken' },
          ],
        },
      }),
    );
    expect(withRows).toContainEqual({ key: 'ingredients' });
    expect(
      withRows.some((s) => s.key === 'ingredients' && s.state === 'coming-later'),
    ).toBe(false);
    expect(
      sectionsFor(
        activity({ type: 'meal', details: { kind: 'meal', ingredients: [] } }),
      ).map((section) => section.key),
    ).not.toContain('ingredients');
    expect(sectionsFor(activity({})).map((section) => section.key)).not.toContain(
      'ingredients',
    );
  });

  /**
   * `plans-and-lists.md` §2.2 hides Expenses below two participants and zero expenses, and
   * hides Updates on a private plan with no entries — which in Phase 1 is every plan. P1-26's
   * brief lists Expenses among the disabled sections; the product doc outranks an
   * implementation plan (`agent-playbook.md` §2), so they are absent rather than greyed out.
   * Raised in the PR rather than resolved silently.
   */
  it.each(['expenses', 'updates'])('hides %s rather than disabling it', (key) => {
    expect(sectionsFor(activity({})).map((s) => s.key)).not.toContain(key);
  });
});

describe('subtitleFor', () => {
  it('names a Task as a Task, with no sharing state', () => {
    expect(subtitleFor(task(), '')).toBe('Task');
  });

  it('names the Plan kind and the share state', () => {
    expect(subtitleFor(activity({}), 'Event')).toBe('Event · Just you');
  });

  it('puts a meal slot in the middle when it is set', () => {
    expect(
      subtitleFor(
        activity({
          type: 'meal',
          details: { kind: 'meal', mealSlot: 'dinner' },
        }),
        'Meal',
      ),
    ).toBe('Meal · Dinner · Just you');
    expect(
      subtitleFor(activity({ type: 'meal', details: { kind: 'meal' } }), 'Meal'),
    ).toBe('Meal · Just you');
  });

  it('spells S2 E4 only when both watch fields are set, and never for a movie', () => {
    expect(
      subtitleFor(
        activity({
          type: 'watch',
          details: {
            kind: 'watch',
            mediaTitle: 'Severance',
            mediaKind: 'show',
            season: 2,
            episode: 4,
          },
        }),
        'Watch',
      ),
    ).toBe('Watch · S2 E4 · Just you');
    expect(
      subtitleFor(
        activity({
          type: 'watch',
          details: {
            kind: 'watch',
            mediaTitle: 'The Bear',
            mediaKind: 'show',
            season: 3,
          },
        }),
        'Watch',
      ),
    ).toBe('Watch · Show · Just you');
    expect(
      subtitleFor(
        activity({
          type: 'watch',
          details: {
            kind: 'watch',
            mediaTitle: 'Past Lives',
            mediaKind: 'movie',
            season: 2,
            episode: 4,
          },
        }),
        'Watch',
      ),
    ).toBe('Watch · Movie · Just you');
  });

  it('names an event organiser when set and does not fall back to location', () => {
    expect(
      subtitleFor(
        activity({
          location: { label: 'Barbican Centre' },
          details: { kind: 'event', organiser: 'Barbican Presents' },
        }),
        'Event',
      ),
    ).toBe('Event · Barbican Presents · Just you');
    expect(
      subtitleFor(
        activity({ location: { label: 'Noble Rot' }, details: { kind: 'event' } }),
        'Event',
      ),
    ).toBe('Event · Just you');
  });
});

describe('detailRowsFor — the one Details group (2026-09-10)', () => {
  it('puts Details after the header and before Ingredients and Preparation', () => {
    expect(
      sectionsFor(
        activity({
          type: 'meal',
          details: {
            kind: 'meal',
            recipeUrl: 'https://www.bbcgoodfood.com/recipes/chicken-tacos',
            ingredients: [
              { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1', name: 'Chicken' },
            ],
          },
        }),
        { childCount: 1, sourceListCount: 0, attachmentCount: 0, updateCount: 0 },
      ).map((section) => section.key),
    ).toEqual([
      'whenWhere',
      'details',
      'ingredients',
      'prep',
      'attachments-coming-later',
      'notes',
      'people',
    ]);
  });

  it('lists each kind’s rows in order, then Link, Part of and From', () => {
    expect(
      detailRowsFor(
        activity({
          sourceUrl: 'https://www.instagram.com/p/Cx9pQ2v',
          parentActivityId: 'act_01J0000000000000000000000P',
          details: {
            kind: 'event',
            description: 'Tasting menu',
            organiser: 'Noble Rot',
            priceCents: 4500,
            reservation: { name: 'Malik', partySize: 2 },
          },
        }),
        { hasSourceList: true },
      ),
    ).toEqual([
      'booking',
      'tickets',
      'organiser',
      'description',
      'link',
      'partOf',
      'from',
    ]);
    expect(
      detailRowsFor(
        activity({
          type: 'watch',
          details: {
            kind: 'watch',
            mediaTitle: 'Severance',
            mediaKind: 'show',
            season: 2,
            episode: 4,
            service: 'Apple TV+',
          },
        }),
      ),
    ).toEqual(['episode', 'service']);
  });

  it('omits Link when sourceUrl equals recipeUrl or ticketUrl', () => {
    expect(
      detailRowsFor(
        activity({
          type: 'meal',
          sourceUrl: 'https://www.bbcgoodfood.com/recipes/chicken-tacos',
          details: {
            kind: 'meal',
            recipeUrl: 'https://www.bbcgoodfood.com/recipes/chicken-tacos',
          },
        }),
      ),
    ).toEqual(['recipe']);
    expect(
      detailRowsFor(
        activity({
          sourceUrl: 'https://www.ticketmaster.co.uk/event/48213',
          details: {
            kind: 'event',
            ticketUrl: 'https://www.ticketmaster.co.uk/event/48213',
          },
        }),
      ),
    ).toEqual(['tickets']);
  });

  it('keeps Link when sourceUrl is a different destination', () => {
    expect(
      detailRowsFor(
        activity({
          type: 'meal',
          sourceUrl: 'https://www.instagram.com/p/Cx9pQ2v',
          details: {
            kind: 'meal',
            recipeUrl: 'https://www.bbcgoodfood.com/recipes/chicken-tacos',
          },
        }),
      ),
    ).toEqual(['recipe', 'link']);
  });

  it('gives a Task no type rows: only Link, Part of and From', () => {
    expect(detailRowsFor(task())).toEqual([]);
    expect(
      detailRowsFor(
        activity({
          objectKind: 'task',
          type: 'task',
          details: { kind: 'task' },
          sourceUrl: 'https://www.thetrainline.com/book',
          parentActivityId: 'act_01J0000000000000000000000P',
        }),
      ),
    ).toEqual(['link', 'partOf']);
  });

  /** The `Related plan · None` disclosure is gone: no parent, no row. */
  it('has no Part of row without a parent', () => {
    expect(detailRowsFor(task())).not.toContain('partOf');
    expect(sectionsFor(task()).map((s) => s.key)).not.toContain('details');
  });

  it('carries From only when the envelope named the source List', () => {
    expect(detailRowsFor(task(), { hasSourceList: true })).toEqual(['from']);
    expect(
      sectionsFor(task(), {
        childCount: 0,
        sourceListCount: 0,
        attachmentCount: 0,
        updateCount: 0,
        hasSourceList: true,
      }).map((s) => s.key),
    ).toContain('details');
  });

  it('never renders shortcutId on a General plan', () => {
    expect(
      detailRowsFor(
        activity({
          type: 'custom',
          details: {
            kind: 'custom',
            shortcutId: 'sct_01J0000000000000000000000C',
          },
        }),
      ),
    ).toEqual([]);
    expect(
      subtitleFor(activity({ type: 'custom', details: { kind: 'custom' } }), 'General'),
    ).toBe('General · Just you');
  });

  it('omits empty description and empty reservation objects', () => {
    expect(
      detailRowsFor(
        activity({
          details: { kind: 'event', description: '', reservation: {} },
        }),
      ),
    ).toEqual([]);
  });

  it('treats blank free-text type facts as absent', () => {
    expect(
      detailRowsFor(
        activity({
          type: 'watch',
          details: {
            kind: 'watch',
            mediaTitle: 'Past Lives',
            mediaKind: 'movie',
            episodeTitle: '',
            service: '',
          },
        }),
      ),
    ).toEqual([]);
    expect(
      detailRowsFor(
        activity({
          details: { kind: 'event', reservation: { name: '' }, organiser: '' },
        }),
      ),
    ).toEqual([]);
    expect(
      subtitleFor(activity({ details: { kind: 'event', organiser: '' } }), 'Event'),
    ).toBe('Event · Just you');
  });

  it('treats episode-only watch progress as an Episode row without S3 in the header', () => {
    const bear = activity({
      type: 'watch',
      details: { kind: 'watch', mediaTitle: 'The Bear', mediaKind: 'show', episode: 4 },
    });
    expect(detailRowsFor(bear)).toEqual(['episode']);
    expect(subtitleFor(bear, 'Watch')).toBe('Watch · Show · Just you');
  });

  it("never shows a movie's stored season or episode", () => {
    const movie = (patch: Record<string, unknown> = {}) =>
      activity({
        type: 'watch',
        details: {
          kind: 'watch',
          mediaTitle: 'Past Lives',
          mediaKind: 'movie',
          season: 2,
          episode: 4,
          ...patch,
        },
      });
    expect(detailRowsFor(movie())).toEqual([]);
    expect(detailRowsFor(movie({ service: 'Netflix' }))).toEqual(['service']);
  });
});

describe('typeDetailChips — only what Details cannot reach', () => {
  it('offers Ingredients and Details on an empty Meal', () => {
    expect(
      typeDetailChips(activity({ type: 'meal', details: { kind: 'meal' } })),
    ).toEqual([
      { key: 'ingredients', label: 'Ingredients' },
      { key: 'details', label: 'Details' },
    ]);
  });

  it('drops the Details chip once the group exists, and Ingredients once rows exist', () => {
    expect(
      typeDetailChips(
        activity({
          type: 'meal',
          details: {
            kind: 'meal',
            recipeUrl: 'https://www.bbcgoodfood.com/recipes/chicken-tacos',
          },
        }),
      ),
    ).toEqual([{ key: 'ingredients', label: 'Ingredients' }]);
    expect(
      typeDetailChips(
        activity({
          type: 'meal',
          details: {
            kind: 'meal',
            ingredients: [
              { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1', name: 'Chicken' },
            ],
          },
        }),
      ),
    ).toEqual([{ key: 'details', label: 'Details' }]);
  });

  it('offers Details on an empty Watch or Event and nothing once it has a row', () => {
    const watch = activity({
      type: 'watch',
      details: { kind: 'watch', mediaTitle: 'Past Lives', mediaKind: 'movie' },
    });
    expect(typeDetailChips(watch)).toEqual([{ key: 'details', label: 'Details' }]);
    expect(typeDetailChips(activity({}))).toEqual([{ key: 'details', label: 'Details' }]);
    expect(
      typeDetailChips(activity({ details: { kind: 'event', organiser: 'Barbican' } })),
    ).toEqual([]);
    // A From row alone is still a Details group; its Edit reaches every fact.
    expect(typeDetailChips(activity({}), { hasSourceList: true })).toEqual([]);
  });

  it('offers only Link on a Task or General plan with no Details group', () => {
    expect(typeDetailChips(task())).toEqual([{ key: 'link', label: 'Link' }]);
    expect(
      typeDetailChips(activity({ type: 'custom', details: { kind: 'custom' } })),
    ).toEqual([{ key: 'link', label: 'Link' }]);
    expect(
      typeDetailChips(
        activity({
          objectKind: 'task',
          type: 'task',
          details: { kind: 'task' },
          parentActivityId: 'act_01J0000000000000000000000P',
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    'Recipe',
    'Episode',
    'Streaming service',
    'Booking',
    'Tickets',
    'Description',
  ])('never offers a per-fact %s chip', (label) => {
    for (const current of [
      activity({ type: 'meal', details: { kind: 'meal' } }),
      activity({
        type: 'watch',
        details: { kind: 'watch', mediaTitle: 'Severance', mediaKind: 'show' },
      }),
      activity({}),
    ]) {
      expect(typeDetailChips(current).map((chip) => chip.label)).not.toContain(label);
    }
  });
});

describe('Plan to Task blockers', () => {
  it('is unblocked on a solo plan with nothing attached', () => {
    expect(planToTaskBlockers(activity({}))).toEqual([]);
    expect(planToTaskBlockedMessage([])).toBeUndefined();
  });

  /**
   * Phase 1 can only produce zeroes, so this is checked against the counts rather than
   * hard-coded — the rule has to already be right on the first shared plan in Phase 6.
   */
  it('names people, expenses and prep children when they exist', () => {
    expect(
      planToTaskBlockers(
        activity({ participantCount: 2, expenseTotalCents: 4200, childCount: 1 }),
      ),
    ).toEqual(['2 people', '1 expense', '1 prep task']);
  });

  it('uses the singular for one person and one prep task', () => {
    expect(planToTaskBlockers(activity({ participantCount: 1, childCount: 1 }))).toEqual([
      '1 person',
      '1 prep task',
    ]);
  });

  it('builds §6.3 rule 3 copy naming exactly what must be removed', () => {
    expect(planToTaskBlockedMessage(['2 people', '1 expense'])).toBe(
      'Remove 2 people and 1 expense before changing this to a Task.',
    );
    expect(planToTaskBlockedMessage(['2 people'])).toBe(
      'Remove 2 people before changing this to a Task.',
    );
    expect(planToTaskBlockedMessage(['2 people', '1 expense', '3 prep tasks'])).toBe(
      'Remove 2 people, 1 expense and 3 prep tasks before changing this to a Task.',
    );
  });
});
