import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function expectNoSeriousA11yViolations(
  page: Page,
  where: string,
): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter(
    ({ impact }) => impact === 'serious' || impact === 'critical',
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
