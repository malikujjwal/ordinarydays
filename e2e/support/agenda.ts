import type { Locator, Page } from '@playwright/test';

/**
 * Today renders the next timed item **twice**: once inside the UP NEXT hero card, whose body
 * is the canonical `AgendaRow` (`UpNextCard.tsx` — "its body remains the canonical
 * AgendaRow"), and once in the section it belongs to. A page-wide
 * `[data-testid="agenda-row-body"]` therefore over-counts by one whenever UP NEXT is showing,
 * and a page-wide `[data-testid="agenda-row-<id>"]` resolves to two elements for that one
 * activity, which is a strict-mode violation the moment a spec acts on it.
 *
 * Every count and every row lookup in these specs means the sections, so scope to them.
 * Duplication in UP NEXT is deliberate product behaviour (P2-20), not something a spec should
 * assert away.
 */
function sections(page: Page): Locator {
  return page.locator(
    '[data-testid="today-schedule"], [data-testid="today-anytime"], [data-testid="today-earlier"]',
  );
}

/** Section rows whose title carries this spec's unique prefix, in render order. */
export function agendaRowBodies(page: Page, prefix: string): Locator {
  return sections(page)
    .locator('[data-testid="agenda-row-body"]')
    .filter({ hasText: prefix });
}

/** The one section row for an activity, never the UP NEXT copy of it. */
export function agendaRow(page: Page, activityId: string): Locator {
  return sections(page).locator(`[data-testid="agenda-row-${activityId}"]`);
}
