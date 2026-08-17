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

/**
 * Opens EARLIER TODAY if it is shut.
 *
 * The section is **collapsed by default** (founder, 2026-08-17, `today-and-tasks.md` §2.4), so a
 * spec that looks for a passed, completed or skipped row has to open it first — otherwise the
 * row is not in the DOM at all and the failure reads as "element not found" rather than as
 * "the section is closed".
 *
 * Idempotent and safe on a day with nothing behind it: the toggle only exists when the section
 * does, and it is left open once opened.
 */
export async function openEarlierToday(page: Page): Promise<void> {
  /**
   * Wait for the agenda before looking. Called straight after `goto`, the toggle does not exist
   * yet, and a bare `count() === 0` then reads as "there is nothing behind you today" and
   * silently returns — which is how this helper failed to open anything at all on its first
   * outing.
   */
  await page.locator('[data-testid="today-agenda"]').waitFor({ state: 'visible' });
  const toggle = page.getByTestId('today-earlier-toggle');
  await toggle.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  if ((await toggle.count()) === 0) return;
  const label = await toggle.getAttribute('aria-label');
  if (label?.startsWith('Show') === true) await toggle.click();
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
