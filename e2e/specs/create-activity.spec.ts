import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Choose **Task** in global Add, save it, and see it in the flat activity list (P1-29).
 *
 * ## What only an E2E test proves here
 *
 * Every layer below has this covered in isolation: `activities.int.test.ts` proves the
 * transaction lands in the `#S` bucket, `compose` has component tests for the chooser, and
 * `usePlans` has its own. What none of them can prove is that the *chain* holds — that the
 * object the user tapped is the object the API stored, and that the stored row comes back
 * through a real query into a list the user is looking at. That is one wire per layer and
 * every one of them is somebody's assumption.
 *
 * ## The title never chooses the target
 *
 * `CLAUDE.md` rule 2, asserted twice and from both directions:
 *
 * 1. After the global `+`, **there is no title field on the page at all** — so there is no
 *    text for anything to classify, and the rule holds by construction rather than by a
 *    classifier being told not to run.
 * 2. The title used is `Dinner at Zahav`, which is the docs' own example of a phrase that
 *    reads like an Outing or a Meal. The user taps `Task`, and the detail header says `Task`.
 *
 * ## No sign-in step
 *
 * There is nothing to sign in to (`AUTH_MODE=local` resolves every request as `usr_local_dev`
 * for the whole of Phases 1–3). Phase 4 prepends one; the flow is written so that step goes in
 * front of `goto` without any of the rest moving.
 */

const testId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

/**
 * `definition-of-done.md` §5 item 11: zero `serious` or `critical` violations, on every route
 * the flow reaches.
 *
 * `minor` and `moderate` are reported in the failure message when there is one but do not
 * fail the run, which is exactly what item 11 says. A gate set at "zero violations of any
 * impact" is one somebody disables.
 */
async function expectNoSeriousA11yViolations(page: Page, where: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );

  /**
   * The **selector and the reason**, not just the rule id. `color-contrast (serious)` on a
   * screen with thirty elements on it is a message that sends the reader to open a browser;
   * `color-contrast … [".css-146c3p1"] Element has insufficient colour contrast of 3.2` names
   * the element and the number it missed by.
   */
  expect(
    blocking.flatMap((violation) =>
      violation.nodes.map(
        (node) =>
          `${violation.id} (${violation.impact}) at ${node.target.join(' ')}: ` +
          `${node.failureSummary?.replace(/\s+/g, ' ').trim() ?? violation.help}`,
      ),
    ),
    `axe-core found serious or critical violations on ${where}`,
  ).toEqual([]);
}

test('creates a Task from global Add and shows it in the flat activity list', async ({
  page,
}) => {
  /**
   * Unique per run, so the row this flow asserts on is unambiguously **its own**.
   *
   * `testing.md` §8.2 and P1-29's edge case: the seed exists so the list has other rows in it,
   * and no assertion here reads one. A flow that asserted on seeded content would break every
   * time the seed changed, for a reason that has nothing to do with the flow.
   */
  const title = `Dinner at Zahav ${Date.now()}`;

  await page.goto('/plans');
  await expect(testId(page, 'plans-screen')).toBeVisible();
  // The seeded rows, so the assertion at the end is "found it among others" rather than
  // "the list has exactly one thing in it".
  await expect(testId(page, 'plans-list')).toBeVisible();
  await expectNoSeriousA11yViolations(page, '/plans');

  await testId(page, 'global-add').click();

  // Assertion 1: the chooser is the first thing, and no title field exists yet.
  await expect(testId(page, 'object-chooser')).toBeVisible();
  await expect(testId(page, 'compose-title')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, '/compose (object chooser)');

  await testId(page, 'object-choice-task').click();

  await expect(testId(page, 'compose-form')).toBeVisible();
  await testId(page, 'compose-title').fill(title);

  /**
   * `Tomorrow`, not `Today`. The row has to land in the `#S` bucket **from today forward** for
   * the `upcoming` stage to return it, and the pivot is the caller's own date. `Today` sits
   * exactly on that boundary; a full day of margin means a run that starts at 23:59:59 is not
   * a different test from one that starts at noon.
   */
  await page.getByRole('button', { name: 'Tomorrow' }).click();
  await expectNoSeriousA11yViolations(page, '/compose (task form)');

  await testId(page, 'compose-save').click();

  // Back on Plans, with the new row in it. This is the assertion the whole flow exists for.
  await expect(testId(page, 'plans-screen')).toBeVisible();
  const row = page.getByRole('button', { name: title });
  await expect(row).toBeVisible();

  // Assertion 2: a plan-sounding title, stored as the Task the user actually chose.
  await row.click();
  // `toHaveValue`, not `toContainText`: the detail title is edited in place, so it is an
  // `<input>` whose text content is empty and whose `value` is the title (P1-26).
  await expect(testId(page, 'detail-title')).toHaveValue(title);
  await expect(testId(page, 'detail-subtitle')).toHaveText('Task');
  await expectNoSeriousA11yViolations(page, '/activity/:id');
});
