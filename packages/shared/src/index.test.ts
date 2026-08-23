import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as root from '@od/shared';
import * as activity from '@od/shared/activity';
import * as client from '@od/shared/client';
import * as constants from '@od/shared/constants';
import * as errors from '@od/shared/errors';
import * as notifications from '@od/shared/notifications';
import * as recurrence from '@od/shared/recurrence';
import * as schemas from '@od/shared/schemas';
import * as table from '@od/shared/table';
import * as testFixtures from '@od/shared/test-fixtures';
import * as time from '@od/shared/time';
import * as types from '@od/shared/types';
import { describe, expect, it } from 'vitest';

/**
 * Two things this file is responsible for.
 *
 * 1. Every subpath in the `exports` map actually resolves. An exports entry pointing at a
 *    file that does not exist typechecks fine and fails at import time in Metro, which is
 *    the worst place to find out.
 * 2. Nothing forbidden has entered the package. `dependency-cruiser` enforces this on the
 *    real module graph in P0-27; this test exists as well because it fails with a message
 *    that names the file and the import.
 */

describe('exports map', () => {
  it('resolves every declared subpath', () => {
    expect(root.MAX_PARTICIPANTS).toBe(50);
    expect(schemas.isoDate).toBeDefined();
    expect(schemas.agendaItem).toBeDefined();
    expect(schemas.reminderInputForSchedule).toBeDefined();
    expect(schemas.list).toBeDefined();
    expect(schemas.listItem).toBeDefined();
    expect(schemas.createListInput).toBeDefined();
    expect(schemas.createListItemInput).toBeDefined();
    expect(schemas.listItemDetailsInput).toBeDefined();
    expect(schemas.bulkCreateListItemsInput).toBeDefined();
    expect(schemas.checkDetailsMatchBehaviour).toBeDefined();
    expect(table.TABLE.partitionKey).toBe('pk');
    expect(time.fixedClock).toBeDefined();
    expect(time.toWallTime).toBeDefined();
    expect(client.nullTokenProvider).toBeDefined();
    expect(client.localTokenProvider).toBeDefined();
    expect(client.getAgenda).toBeDefined();
    expect(client.completeActivity).toBeDefined();
    expect(client.uncompleteActivity).toBeDefined();
    expect(client.skipActivity).toBeDefined();
    expect(client.snoozeActivity).toBeDefined();
    expect(client.unsnoozeActivity).toBeDefined();
    expect(schemas.completeActivityInput).toBeDefined();
    expect(schemas.uncompleteActivityInput).toBeDefined();
    expect(schemas.skipActivityInput).toBeDefined();
    expect(schemas.snoozeActivityInput).toBeDefined();
    expect(schemas.unsnoozeActivityInput).toBeDefined();
    expect(client.createReminder).toBeDefined();
    expect(constants.MAX_AGENDA_DAYS).toBe(62);
    expect(constants.TODAY_ANYTIME_SAVED_LIMIT).toBe(20);
    expect(constants.TODAY_EARLIER_COLLAPSED_LIMIT).toBe(10);
    expect(constants.TODAY_OVERDUE_COLLAPSE_THRESHOLD).toBe(5);
    expect(constants.TODAY_OVERDUE_COLLAPSED_LIMIT).toBe(3);
    expect(errors.ERROR_CODES).toContain('validation_failed');
    expect(recurrence.describeRecurrence).toBeDefined();
    expect(recurrence.expandRecurrence).toBeDefined();
    expect(recurrence.addWallDays).toBeDefined();
    expect(recurrence.toUtcInstant).toBeDefined();
    expect(notifications.reminderDelivery).toBeDefined();
    expect(notifications.insideQuietHours).toBeDefined();
    expect(activity.deriveGsi1Bucket).toBeDefined();
    expect(activity.changeActivityKind).toBeDefined();
    expect(testFixtures.workedExampleDayResponse).toBeDefined();
    expect(types.assertNever).toBeDefined();
  });

  it('does not re-export the API client from the root barrel', async () => {
    const root = await import('@od/shared');
    expect(root).not.toHaveProperty('nullTokenProvider');
    expect(root).not.toHaveProperty('localTokenProvider');
  });
});

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      acc.push(full);
  }
  return acc;
}

/**
 * Strip block comments and whole-line `//` comments before scanning.
 *
 * The rule is about what the code does, not what the prose says: these files cite the rules
 * they follow by name, and a doc comment saying "nothing here reads process.env" is
 * evidence of compliance, not a violation. A trailing comment on a line of code is left
 * alone, so the check stays conservative.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('what must never enter shared (tech-stack.md §5.2)', () => {
  const files = sourceFiles(join(import.meta.dirname, '.'));

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  // Without this, weakening `code()` until nothing matches would make every assertion
  // below pass for the wrong reason. A scan that cannot detect anything is worse than no
  // scan, because it reads like evidence.
  it('still detects a violation in real code after comments are stripped', () => {
    const planted = [
      '/** A doc comment mentioning process.env and react is fine. */',
      "// A line comment importing from '@aws-sdk/client-dynamodb' is fine too.",
      "import { DynamoDBClient } from '@aws-sdk/client-dynamodb';",
      'const table = process.env["TABLE_NAME"];',
    ].join('\n');

    expect(/from\s+['"]@aws-sdk\//.test(code(planted))).toBe(true);
    expect(/process\s*\.\s*env/.test(code(planted))).toBe(true);

    const commentsOnly = planted.split('\n').slice(0, 2).join('\n');
    expect(/from\s+['"]@aws-sdk\//.test(code(commentsOnly))).toBe(false);
    expect(/process\s*\.\s*env/.test(code(commentsOnly))).toBe(false);
  });

  it.each([
    ['react', /from\s+['"]react(-native)?(\/|['"])/],
    ['an AWS SDK client', /from\s+['"]@aws-sdk\//],
    ['aws-cdk-lib', /from\s+['"]aws-cdk-lib/],
    ['process.env', /process\s*\.\s*env/],
    ['a DynamoDB key literal', /['"`](ACT|USER|LIST|INVITE|EMAIL|IDEM)#/],
  ])('contains no reference to %s', (_label, pattern) => {
    const offenders = files.filter((f) => pattern.test(code(readFileSync(f, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
