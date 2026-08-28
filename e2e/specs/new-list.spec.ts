import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API, e2eHeaders } from '../support/api';

/**
 * Make a list by tapping a style, then naming it (P3-26, `plans-and-lists.md` §5.4).
 *
 * ## What only an E2E test proves here
 *
 * Every layer below has its own coverage: `templateChoices.test.ts` pins the projection,
 * `NewListSheet.test.tsx` pins the two steps and their announcements, and
 * `listsCrud.int.test.ts` pins what the server copies. What none of them can prove is that the
 * **style the user tapped is the style that got stored** — that is one wire per layer, and
 * every one of them is somebody's assumption.
 *
 * The title is the founder's own trap: `Costco run` is a phrase a matcher would have to guess
 * about, and this flow asserts the stored `templateKey` is still `groceries` afterwards. The
 * other direction is asserted too: `Blank` is an explicit tap that stores `blank` with the
 * visible title `Untitled list`, not a fallback something landed on.
 *
 * ## The absence, watched rather than assumed
 *
 * A request log runs for the whole spec. Acceptance criterion 6 is about things that must not
 * exist, and the way they come back is quietly: a debounce added "just to prefill better", a
 * template fetch added to a startup path. So the log asserts the sheet never requests
 * `/v1/list-templates` — it renders the bundled projection, which is what makes creating a
 * list work on a first launch offline — and that editing the title reaches nothing at all.
 */

const testId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

async function expectNoSeriousA11yViolations(page: Page, where: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );

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

/** The stored row, read back through the API rather than off the card the client drew. */
async function storedList(
  request: APIRequestContext,
  title: string,
): Promise<{
  templateKey: string;
  title: string;
  itemStateMode: { mode: string };
  slot: string | null;
}> {
  const response = await request.get(`${API}/v1/lists`, { headers: e2eHeaders() });
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as {
    data: {
      title: string;
      templateKey: string;
      itemStateMode: { mode: string };
      slot: string | null;
    }[];
  };
  const match = body.data.find((list) => list.title === title);
  expect(match, `no stored list titled "${title}"`).toBeDefined();
  if (match === undefined) throw new Error(`No stored list titled "${title}".`);
  return match;
}

test('creates a list from an explicit style, and the typed title never changes it', async ({
  page,
  request,
}) => {
  /**
   * Unique per run so the row this flow asserts on is unambiguously its own — the seed
   * writes no lists, but a re-run against a table that was not reset would otherwise find
   * yesterday's.
   */
  const stamp = Date.now();
  const groceriesTitle = `Costco run ${stamp}`;
  const blankTitle = `Simple list ${stamp}`;

  /** Every request the page makes, for the absence assertions below. */
  const requests: { method: string; url: string }[] = [];
  page.on('request', (request) =>
    requests.push({ method: request.method(), url: request.url() }),
  );
  const templateOrModelRequests = () =>
    requests.filter(({ url }) => /list-templates|suggest|capture/.test(url));

  await page.goto('/lists');
  await expect(testId(page, 'lists-screen')).toBeVisible();

  await testId(page, 'lists-new').click();

  // Assertion 1: the catalogue is the first thing, nothing is selected, and there is no
  // title field yet — so there is no text on the screen for anything to classify.
  await expect(testId(page, 'list-style-chooser')).toBeVisible();
  await expect(testId(page, 'new-list-title')).toHaveCount(0);
  await expect(testId(page, 'new-list-create')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Blank. Start without a category or item details',
    }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, '/lists/new (style chooser)');

  await testId(page, 'list-style-groceries').click();

  // The record's own editable default title, prefilled after the tap and not before it.
  const title = testId(page, 'new-list-title');
  await expect(title).toHaveValue('Groceries');
  await expectNoSeriousA11yViolations(page, '/lists/new (title step)');

  /**
   * Assertion 2: **typing reaches nothing.** The count is taken before the edits and compared
   * after, so this fails if a debounce, a matcher or a model call is ever added behind the
   * field. Writes are checked separately: nothing may be created before `Create list`.
   */
  const beforeTyping = requests.length;
  await title.fill('C');
  await title.fill('Costco');
  await title.fill(groceriesTitle);
  const duringTyping = requests.slice(beforeTyping);
  expect(templateOrModelRequests()).toEqual([]);
  expect(duringTyping.filter(({ method }) => method !== 'GET')).toEqual([]);

  await testId(page, 'new-list-create').click();

  // Back on the index, with the list in it.
  await expect(testId(page, 'lists-screen')).toBeVisible();
  await expect(page.getByText(groceriesTitle)).toBeVisible();

  // Assertion 3: the tap chose the style, and `Costco run` did not change it.
  const groceries = await storedList(request, groceriesTitle);
  expect(groceries.templateKey).toBe('groceries');
  expect(groceries.itemStateMode).toEqual({ mode: 'checkbox' });
  expect(groceries.slot).toBe('groceries');

  /**
   * Assertion 4: the other direction. `Blank` is an explicit tap that stores `blank` with
   * the visible title prefilled as `Untitled list` — there is no no-selection fallback,
   * so a list is `blank` because somebody chose it.
   */
  await testId(page, 'lists-new').click();
  await expect(testId(page, 'list-style-chooser')).toBeVisible();
  await testId(page, 'list-style-blank').click();
  await expect(testId(page, 'new-list-title')).toHaveValue('Untitled list');
  await testId(page, 'new-list-title').fill(blankTitle);
  await testId(page, 'new-list-create').click();

  await expect(testId(page, 'lists-screen')).toBeVisible();
  const blank = await storedList(request, blankTitle);
  expect(blank.templateKey).toBe('blank');

  // Assertion 5: across the whole flow, the sheet never fetched the templates route.
  expect(templateOrModelRequests()).toEqual([]);
});
