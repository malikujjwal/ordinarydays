import { describe, expect, it } from 'vitest';
import * as keys from './keys.js';

/**
 * Every builder, against the **literal strings in `data-model.md` §3**.
 *
 * The assertions spell the keys out rather than rebuilding them from the same template the
 * implementation uses — a test that computed `` `ACT#${id}` `` would pass whatever the
 * implementation did, which is the one thing this file must not do. If a key format
 * genuinely changes, this file is where that change is stated and reviewed.
 */

const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const USR = 'usr_local_dev';
const LST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const PSN = 'psn_01J8XKQ2M4N5P6R7S8T9V0W1X2';

describe('§3.1 the activity partition', () => {
  it.each([
    ['activityMeta', keys.activityMeta(ACT), { pk: `ACT#${ACT}`, sk: 'META' }],
    ['participant', keys.participant(ACT, PSN), { pk: `ACT#${ACT}`, sk: `PART#${PSN}` }],
    ['expense', keys.expense(ACT, 'exp_1'), { pk: `ACT#${ACT}`, sk: 'EXP#exp_1' }],
    [
      'activityUpdate',
      keys.activityUpdate(ACT, '2026-08-08T10:00:00.000Z', 'upd_1'),
      { pk: `ACT#${ACT}`, sk: 'UPD#2026-08-08T10:00:00.000Z#upd_1' },
    ],
    [
      'occurrence',
      keys.occurrence(ACT, '2026-08-08'),
      { pk: `ACT#${ACT}`, sk: 'OCC#2026-08-08' },
    ],
    [
      'occurrenceMoveMarker',
      keys.occurrenceMoveMarker(ACT, '2026-08-09'),
      { pk: `ACT#${ACT}`, sk: 'MOVE#2026-08-09' },
    ],
    ['attachment', keys.attachment(ACT, 'att_1'), { pk: `ACT#${ACT}`, sk: 'ATT#att_1' }],
    [
      'childPointer',
      keys.childPointer(ACT, 'act_child'),
      { pk: `ACT#${ACT}`, sk: 'SUB#act_child' },
    ],
    [
      'dateSuggestion',
      keys.dateSuggestion(ACT, '2026-08-08T10:00:00.000Z', 'sug_1'),
      { pk: `ACT#${ACT}`, sk: 'SUGG#2026-08-08T10:00:00.000Z#sug_1' },
    ],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  /**
   * The ordering the whole per-user reminder design depends on: `userId` before
   * `reminderId`, so the detail projection filters to the caller with `begins_with` and the
   * scheduler reads every row from the same query (patterns 4 and 4b).
   */
  it('keys a reminder by user first, then reminder', () => {
    expect(keys.reminder(ACT, USR, 'rem_1')).toEqual({
      pk: `ACT#${ACT}`,
      sk: `REM#${USR}#rem_1`,
    });
  });

  it('prefixes one user’s reminders so the other user’s cannot match', () => {
    const mine = keys.reminderPrefix(ACT, 'usr_a');
    expect(mine).toEqual({ pk: `ACT#${ACT}`, skPrefix: 'REM#usr_a#' });
    expect(keys.reminder(ACT, 'usr_b', 'rem_1').sk.startsWith(mine.skPrefix)).toBe(false);
  });

  it('reads the whole partition with no sort key, for plan detail', () => {
    expect(keys.activityPartition(ACT)).toEqual({ pk: `ACT#${ACT}` });
  });

  it('ranges occurrences by nominal date', () => {
    expect(keys.occurrenceRange(ACT, '2026-08-01', '2026-08-31')).toEqual({
      pk: `ACT#${ACT}`,
      fromSk: 'OCC#2026-08-01',
      toSk: 'OCC#2026-08-31',
    });
  });
});

describe('§3.2 the user partition', () => {
  it.each([
    // `PROFILE`, per `data-model.md` §3.2 and access pattern 6 — not `META`. Corrected in
    // P1-07; this assertion previously pinned the value the code produced rather than the
    // one the key table specifies, which is why the mismatch survived P1-05.
    ['userProfile', keys.userProfile(USR), { pk: `USER#${USR}`, sk: 'PROFILE' }],
    [
      'activityIndex',
      keys.activityIndex(USR, ACT),
      { pk: `USER#${USR}`, sk: `IDX#${ACT}` },
    ],
    ['listPointer', keys.listPointer(USR, LST), { pk: `USER#${USR}`, sk: `LIST#${LST}` }],
    ['person', keys.person(USR, PSN), { pk: `USER#${USR}`, sk: `PERSON#${PSN}` }],
    [
      'personLink',
      keys.personLink(USR, PSN, '2026-08-08T10:00:00.000Z', ACT),
      { pk: `USER#${USR}`, sk: `PLINK#${PSN}#2026-08-08T10:00:00.000Z#${ACT}` },
    ],
    [
      'personListLink',
      keys.personListLink(USR, PSN, '2026-08-08T10:00:00.000Z', LST),
      { pk: `USER#${USR}`, sk: `LLINK#${PSN}#2026-08-08T10:00:00.000Z#${LST}` },
    ],
    [
      'balance',
      keys.balance(USR, PSN, 'USD'),
      { pk: `USER#${USR}`, sk: `BAL#${PSN}#USD` },
    ],
    [
      'settlement',
      keys.settlement(USR, PSN, '2026-08-08T10:00:00.000Z', 'stl_1'),
      { pk: `USER#${USR}`, sk: `SETTLE#${PSN}#2026-08-08T10:00:00.000Z#stl_1` },
    ],
    ['device', keys.device(USR, 'dev_1'), { pk: `USER#${USR}`, sk: 'DEVICE#dev_1' }],
    [
      'shortcut',
      keys.shortcut(USR, 'sct_1'),
      { pk: `USER#${USR}`, sk: 'SHORTCUT#sct_1' },
    ],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  /**
   * A balance is keyed by person **and currency**: expenses are never converted, so someone
   * who owes €20 and is owed $30 has two rows and the UI shows two figures.
   */
  it('gives one balance row per person per currency', () => {
    expect(keys.balance(USR, PSN, 'USD').sk).not.toBe(keys.balance(USR, PSN, 'EUR').sk);
  });
});

describe('§3.3 the list partition', () => {
  it.each([
    ['listMeta', keys.listMeta(LST), { pk: `LIST#${LST}`, sk: 'META' }],
    ['listMember', keys.listMember(LST, PSN), { pk: `LIST#${LST}`, sk: `MEMBER#${PSN}` }],
    [
      'listItem',
      keys.listItem(LST, '0|hzzzzz', 'itm_1'),
      { pk: `LIST#${LST}`, sk: 'ITEM#0|hzzzzz#itm_1' },
    ],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  /**
   * **Viewer first.** A shared item can lead to Alice's private Plan and to Ben's; there is
   * no global link on the item, and removal has to delete exactly one viewer's pointers.
   */
  it('keys an item→activity link by viewer before item', () => {
    expect(keys.listItemActivityLink(LST, 'usr_a', 'itm_1')).toEqual({
      pk: `LIST#${LST}`,
      sk: 'LNK#usr_a#itm_1',
    });
  });

  it('scopes the link prefix to one viewer, so another’s rows cannot match', () => {
    const alice = keys.listItemActivityLinkPrefix(LST, 'usr_a');
    expect(alice.skPrefix).toBe('LNK#usr_a#');
    expect(
      keys.listItemActivityLink(LST, 'usr_b', 'itm_1').sk.startsWith(alice.skPrefix),
    ).toBe(false);
  });

  /** Items sort by `(rank, itemId)` — the tie-break is not optional. */
  it('breaks a rank tie by item id', () => {
    const a = keys.listItem(LST, '0|hzzzzz', 'itm_a').sk;
    const b = keys.listItem(LST, '0|hzzzzz', 'itm_b').sk;
    expect(a < b).toBe(true);
  });
});

describe('§3.4 the lookup partitions', () => {
  it.each([
    ['inviteToken', keys.inviteToken('tok_abc'), { pk: 'INVITE#tok_abc', sk: 'META' }],
    ['expenseLocator', keys.expenseLocator('exp_1'), { pk: 'EXPENSE#exp_1', sk: 'META' }],
    [
      'settlementLocator',
      keys.settlementLocator('stl_1'),
      { pk: 'SETTLEMENT#stl_1', sk: 'META' },
    ],
    [
      'rateLimit',
      keys.rateLimit('user', USR, '2026-08-08T10:00'),
      { pk: `RATE#user#${USR}`, sk: '2026-08-08T10:00' },
    ],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  /**
   * **User-scoped, and that is a security requirement.** A bare `IDEM#<key>` would let one
   * user's client-generated key return another user's stored response. Criterion 9 pins the
   * literal string.
   */
  it('scopes an idempotency record to the caller', () => {
    expect(keys.idempotency('usr_local_dev', 'e1c-key')).toEqual({
      pk: 'IDEM#usr_local_dev#e1c-key',
      sk: 'META',
    });
  });

  it('gives two users the same key different partitions', () => {
    expect(keys.idempotency('usr_a', 'same').pk).not.toBe(
      keys.idempotency('usr_b', 'same').pk,
    );
  });

  /** An email lookup that depended on typed casing would fail to match the same person. */
  it.each([['Ujjwal@Example.com'], ['UJJWAL@EXAMPLE.COM'], ['ujjwal@example.com']])(
    'lower-cases %s',
    (email) => {
      expect(keys.emailLookup(email)).toEqual({
        pk: 'EMAIL#ujjwal@example.com',
        sk: 'USER',
      });
    },
  );

  it('lower-cases the guest-email locator too', () => {
    expect(keys.guestEmail('Alice@Example.com', USR, PSN)).toEqual({
      pk: 'GUESTEMAIL#alice@example.com',
      sk: `OWNER#${USR}#PERSON#${PSN}`,
    });
  });
});

describe('§3.5 the four GSI1 buckets', () => {
  it.each([
    [
      'scheduled',
      keys.gsi1Scheduled(USR, '2026-08-06T19:30', ACT),
      'S',
      `2026-08-06T19:30#${ACT}`,
    ],
    [
      'needs a date',
      keys.gsi1NeedsDate(USR, '2026-08-06T19:30:00.000Z', ACT),
      'P',
      `2026-08-06T19:30:00.000Z#${ACT}`,
    ],
    [
      'anytime',
      keys.gsi1Anytime(USR, '2026-08-06T19:30:00.000Z', ACT),
      'N',
      `2026-08-06T19:30:00.000Z#${ACT}`,
    ],
    ['recurring', keys.gsi1Recurring(USR, '2026-08-06', ACT), 'R', `2026-08-06#${ACT}`],
  ])('%s lands in #%s', (_name, actual, bucket, expectedSk) => {
    expect(actual).toEqual({ gsi1pk: `U#${USR}#${bucket}`, gsi1sk: expectedSk });
  });

  /**
   * `#P` and `#N` are separate buckets and there is no single "unscheduled" one. Both are
   * undated and they mean opposite things — collapsing them sent an undecided group plan to
   * Today's Anytime list, which the model calls its largest product error.
   */
  it('keeps needs-a-date and anytime in different partitions', () => {
    expect(keys.gsi1NeedsDate(USR, 'x', ACT).gsi1pk).not.toBe(
      keys.gsi1Anytime(USR, 'x', ACT).gsi1pk,
    );
  });

  it('gives every bucket a different partition for the same user', () => {
    const partitions = (['S', 'P', 'N', 'R'] as const).map(
      (bucket) => keys.gsi1Bucket(USR, bucket).gsi1pk,
    );
    expect(new Set(partitions).size).toBe(4);
  });
});

/**
 * The prefix builders, which are how every `begins_with` read is expressed.
 *
 * Each is asserted against its literal **and** against the full key it is meant to match, so
 * a prefix that drifted from the builder it partners — the failure that silently returns an
 * empty list — fails here rather than in a screen with nothing on it.
 */
describe('sort-key prefixes match the keys they are meant to select', () => {
  it.each([
    [
      'childPointerPrefix',
      keys.childPointerPrefix(ACT),
      'SUB#',
      keys.childPointer(ACT, 'act_c').sk,
    ],
    [
      'reminderPrefix',
      keys.reminderPrefix(ACT, USR),
      `REM#${USR}#`,
      keys.reminder(ACT, USR, 'rem_1').sk,
    ],
    [
      'listPointerPrefix',
      keys.listPointerPrefix(USR),
      'LIST#',
      keys.listPointer(USR, LST).sk,
    ],
    ['personPrefix', keys.personPrefix(USR), 'PERSON#', keys.person(USR, PSN).sk],
    [
      'personLinkPrefix',
      keys.personLinkPrefix(USR, PSN),
      `PLINK#${PSN}#`,
      keys.personLink(USR, PSN, '2026-08-08T10:00:00.000Z', ACT).sk,
    ],
    [
      'personListLinkPrefix',
      keys.personListLinkPrefix(USR, PSN),
      `LLINK#${PSN}#`,
      keys.personListLink(USR, PSN, '2026-08-08T10:00:00.000Z', LST).sk,
    ],
    ['balancePrefix', keys.balancePrefix(USR), 'BAL#', keys.balance(USR, PSN, 'USD').sk],
    [
      'settlementPrefix',
      keys.settlementPrefix(USR, PSN),
      `SETTLE#${PSN}#`,
      keys.settlement(USR, PSN, '2026-08-08T10:00:00.000Z', 'stl_1').sk,
    ],
    ['devicePrefix', keys.devicePrefix(USR), 'DEVICE#', keys.device(USR, 'dev_1').sk],
    [
      'listItemPrefix',
      keys.listItemPrefix(LST),
      'ITEM#',
      keys.listItem(LST, '0|a', 'itm_1').sk,
    ],
  ])('%s is %s and selects its own key', (_name, prefix, expected, fullKey) => {
    expect(prefix.skPrefix).toBe(expected);
    expect(fullKey.startsWith(prefix.skPrefix)).toBe(true);
  });

  it('reads a whole list partition with no sort key', () => {
    expect(keys.listPartition(LST)).toEqual({ pk: `LIST#${LST}` });
  });

  it('queries every guest record for an email, lower-cased', () => {
    expect(keys.guestEmailPrefix('Alice@Example.com')).toEqual({
      pk: 'GUESTEMAIL#alice@example.com',
    });
    expect(keys.guestEmail('alice@example.com', USR, PSN).pk).toBe(
      keys.guestEmailPrefix('Alice@Example.com').pk,
    );
  });
});

/**
 * The property the whole file exists for. Every builder that identifies user-owned data
 * takes the user explicitly — none has a default and none reads a constant — so two users
 * can never collide, and there is no way to write a key without having said whose it is.
 */
describe('tenancy is in the key, not in a default', () => {
  const forUser = (userId: string) => [
    keys.userProfile(userId).pk,
    keys.activityIndex(userId, ACT).pk,
    keys.listPointer(userId, LST).pk,
    keys.person(userId, PSN).pk,
    keys.balance(userId, PSN, 'USD').pk,
    keys.device(userId, 'dev_1').pk,
    keys.idempotency(userId, 'k').pk,
    keys.gsi1Bucket(userId, 'S').gsi1pk,
    keys.gsi1Bucket(userId, 'N').gsi1pk,
  ];

  it('puts two users’ data in entirely disjoint partitions', () => {
    const alice = forUser('usr_a');
    const ben = forUser('usr_b');

    expect(alice).toHaveLength(ben.length);
    expect(alice.some((key) => ben.includes(key))).toBe(false);
  });

  it('never emits an undefined segment, which would silently merge tenants', () => {
    for (const key of forUser('usr_a')) {
      expect(key).not.toContain('undefined');
    }
  });
});
