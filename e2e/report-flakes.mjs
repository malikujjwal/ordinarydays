import { readFile } from 'node:fs/promises';

const report = JSON.parse(await readFile('playwright-results.json', 'utf8'));
const flaky = [];

function visit(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === 'flaky')
          flaky.push(`${spec.file}:${spec.line} ${spec.title}`);
      }
    }
    visit(suite.suites);
  }
}

visit(report.suites);
for (const title of flaky) {
  process.stdout.write(`::warning title=Flaky Playwright test::${title}\n`);
}
if (flaky.length > 0) {
  process.stdout.write(`Playwright passed with ${flaky.length} flaky test(s).\n`);
}
