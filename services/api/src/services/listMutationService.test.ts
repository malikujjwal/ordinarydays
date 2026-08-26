import type { List, ListBehaviourConfirmation, ListItem } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import type {
  BehaviourMigrationWork,
  ListAccessGrant,
} from '../repositories/listRepository.js';

/**
 * The migration coordinator's own rules, with storage mocked
 * (`definition-of-done.md` §3, and the coverage rule for a new service).
 *
 * `test/integration/listBehaviourMigration.int.test.ts` proves what the transactions do; this
 * file proves what the **service** decides when they answer awkwardly — a drain that runs out
 * of budget, a record somebody else finished first, a snapshot two callers raced for, a marker
 * naming no work. Every one of those is a branch a happy path never reaches and a real
 * incident would.
 */

vi.mock('../repositories/listRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../repositories/listRepository.js')
  >('../repositories/listRepository.js');
  return {
    ...actual,
    getListMeta: vi.fn(),
    getBehaviourMigrationWork: vi.fn(),
    beginBehaviourMigration: vi.fn(),
    snapshotBehaviourMigration: vi.fn(),
    applyBehaviourMigrationChunk: vi.fn(),
    finishBehaviourMigration: vi.fn(),
    abandonBehaviourMigration: vi.fn(),
    snapshotListItems: vi.fn(),
  };
});

vi.mock('../repositories/idempotencyRepository.js', () => ({
  writeReceiptOnly: vi.fn(() => Promise.resolve()),
}));

vi.mock('./authz.js', () => ({
  assertListAccess: vi.fn(),
}));

vi.mock('./listRankRepairService.js', () => ({
  drainRankRepair: vi.fn(() => Promise.resolve(true)),
}));

const repository = await import('../repositories/listRepository.js');
const idempotency = await import('../repositories/idempotencyRepository.js');
const authz = await import('./authz.js');
const repair = await import('./listRankRepairService.js');
const { changeListBehaviour, drainBehaviourMigration, drainListWork, withListWorkDrain } =
  await import('./listMutationService.js');

const USER = 'usr_local_dev';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const NOW = '2026-08-24T09:00:00.000Z';
/**
 * Generated rather than written as a literal, like every other request in this suite. A UUID
 * spelled out beside a constant called `KEY` reads as a credential to a secret scanner, and
 * the value is only ever an `Idempotency-Key`: what matters is that it is the **same** one
 * across the calls that stand for a retry.
 */
const KEY = crypto.randomUUID();

const GRANT = { listId: LIST, userId: USER, role: 'owner' } as unknown as ListAccessGrant;

const RECEIPT: IdempotencyReceipt = {
  userId: USER,
  key: KEY,
  route: 'POST /v1/lists/:id/behaviour',
  status: 200,
  body: '{}',
  ttl: 0,
  createdAt: NOW,
};

const receiptFor = vi.fn(() => RECEIPT);

const list = (overrides: Partial<List> = {}): List => ({
  listId: LIST,
  ownerId: USER,
  behaviour: 'collection',
  templateKey: 'checklist',
  title: 'Watch later',
  icon: 'check-square',
  emptyStateCopy: 'Add something.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: null,
  itemCount: 2,
  uncheckedCount: 2,
  memberCount: 1,
  rankVersion: 3,
  itemVersion: 0,
  archived: false,
  updatedAt: NOW,
  ...overrides,
});

const work = (
  overrides: Partial<BehaviourMigrationWork> = {},
): BehaviourMigrationWork => ({
  listId: LIST,
  operationId: 'bmg_fixture',
  state: 'rewriting',
  fromBehaviour: 'collection',
  toBehaviour: 'watch',
  toDetails: { behaviour: 'watch', watchStatus: 'want' },
  entries: [{ itemId: 'itm_a', rank: 'a0', fromRevision: 0 }],
  cursor: 0,
  rankVersion: 3,
  expectedUpdatedAt: NOW,
  committedAt: NOW,
  undo: { token: 'tok', expiresAt: '2026-08-24T09:00:06.000Z' },
  receipt: RECEIPT,
  lossCount: 0,
  lossFields: [],
  ...overrides,
});

const confirmation = (
  toBehaviour: ListBehaviourConfirmation['toBehaviour'],
  overrides: Partial<ListBehaviourConfirmation> = {},
): ListBehaviourConfirmation => ({
  fromBehaviour: 'watch',
  toBehaviour,
  itemVersion: 0,
  itemCount: 1,
  fields: ['Watch status', 'Season'],
  ...overrides,
});

const change = (
  behaviour: ListBehaviourConfirmation['toBehaviour'] = 'watch',
  confirm: ListBehaviourConfirmation | true | undefined = undefined,
) =>
  changeListBehaviour(
    USER,
    LIST,
    {
      behaviour,
      ...(confirm === undefined
        ? {}
        : { confirmation: confirm === true ? confirmation(behaviour) : confirm }),
    },
    NOW,
    KEY,
    NOW,
    receiptFor,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authz.assertListAccess).mockResolvedValue({
    index: GRANT,
    isOwner: true,
  });
  vi.mocked(repository.getListMeta).mockResolvedValue(list());
  vi.mocked(repository.snapshotBehaviourMigration).mockImplementation((pending) =>
    Promise.resolve({
      ...pending,
      state: 'rewriting',
      lossCount: 0,
      lossFields: [],
    }),
  );
  vi.mocked(repository.abandonBehaviourMigration).mockResolvedValue(undefined);
  vi.mocked(repository.finishBehaviourMigration).mockResolvedValue(undefined);
  vi.mocked(repository.snapshotListItems).mockResolvedValue({
    items: [],
    rankVersion: 3,
    itemVersion: 0,
  });
  vi.mocked(repair.drainRankRepair).mockResolvedValue(true);
});

/** The install, plus a stored record the drain will read back. */
function installReturns(stored: BehaviourMigrationWork): void {
  vi.mocked(repository.beginBehaviourMigration).mockResolvedValue(stored);
  vi.mocked(repository.getBehaviourMigrationWork).mockResolvedValue(stored);
}

describe('driving a migration to completion', () => {
  it('records the operation under the receipt when it commits the final transaction', async () => {
    installReturns(work({ cursor: 1 }));

    const result = await change();

    expect(result.list.behaviour).toBe('watch');
    expect(result.list.rankVersion).toBe(4);
    expect(result.undo?.token).toBe('tok');
    expect(vi.mocked(repository.finishBehaviourMigration).mock.calls[0]?.[1]).toEqual({
      undo: {
        operationId: 'bmg_fixture',
        kind: 'behaviour_upgrade',
        tokenHash: expect.any(String),
        undoExpiresAt: '2026-08-24T09:00:06.000Z',
        inverse: {
          behaviour: 'collection',
          affectedItemIds: ['itm_a'],
        },
        preconditions: {
          behaviour: 'watch',
          itemDetails: { behaviour: 'watch', watchStatus: 'want' },
        },
      },
    });
    expect(idempotency.writeReceiptOnly).not.toHaveBeenCalled();
  });

  /**
   * The receipt is **on the work record**, so the caller that commits the final transaction
   * records this operation's answer under this operation's key — even when that caller is a
   * blocked read finishing somebody else's migration. Without it the author's replay finds no
   * receipt and is then told its `If-Match` conflicts, by the very write it asked for.
   */
  it('hands the final transaction the receipt the operation was accepted under', async () => {
    installReturns(work({ cursor: 1 }));

    await change();

    expect(vi.mocked(repository.beginBehaviourMigration).mock.calls[0]?.[3].receipt).toBe(
      RECEIPT,
    );
    // Nothing is passed to the finisher: it reads the receipt off the record it was given.
    expect(
      vi.mocked(repository.finishBehaviourMigration).mock.calls[0]?.[1],
    ).not.toHaveProperty('idempotencyReceipt');
  });

  /**
   * Somebody else's blocked read drained this operation and committed it — the only thing
   * that ungates a list whose client never came back. The answer is still this operation's
   * answer, because `committedAt`, the token and the receipt were all fixed when it was
   * accepted, so the response this request returns is the one already recorded.
   */
  it('returns the operation’s own answer when a concurrent drain finished first', async () => {
    vi.mocked(repository.beginBehaviourMigration).mockResolvedValue(work({ cursor: 1 }));
    vi.mocked(repository.getBehaviourMigrationWork).mockResolvedValue(undefined);

    const result = await change();

    expect(result.list.behaviour).toBe('watch');
    expect(result.undo?.token).toBe('tok');
    expect(repository.finishBehaviourMigration).not.toHaveBeenCalled();
  });

  /** A second finisher fails the condition naming this operation. That means done. */
  it('treats a lost race to finish as done, not as a failure', async () => {
    installReturns(work({ cursor: 1 }));
    vi.mocked(repository.finishBehaviourMigration).mockRejectedValue(
      new Error('condition failed'),
    );
    vi.mocked(repository.getBehaviourMigrationWork)
      .mockResolvedValueOnce(work({ cursor: 1 }))
      .mockResolvedValue(undefined);

    await expect(change()).resolves.toMatchObject({ list: { behaviour: 'watch' } });
  });

  it('rethrows an idempotency race for the middleware to recover', async () => {
    installReturns(work({ cursor: 1 }));
    vi.mocked(repository.finishBehaviourMigration).mockRejectedValue(
      new IdempotencyRaceError(),
    );

    await expect(change()).rejects.toBeInstanceOf(IdempotencyRaceError);
  });

  it('rethrows a finish failure that is not a lost race', async () => {
    installReturns(work({ cursor: 1 }));
    const boom = new Error('throughput');
    vi.mocked(repository.finishBehaviourMigration).mockRejectedValue(boom);

    await expect(change()).rejects.toBe(boom);
  });

  /**
   * Two callers may drain one operation, and the loser re-reads the authoritative cursor
   * rather than reapplying a slice somebody else already did.
   */
  it('re-reads and continues when another caller snapshotted first', async () => {
    installReturns(work({ state: 'snapshotting', entries: [], cursor: 0 }));
    vi.mocked(repository.snapshotBehaviourMigration)
      .mockRejectedValueOnce(new repository.BehaviourMigrationContendedError())
      .mockImplementation((pending) =>
        Promise.resolve({ ...pending, state: 'rewriting', lossCount: 0 }),
      );

    await expect(change()).resolves.toMatchObject({ list: { behaviour: 'watch' } });
    expect(repository.snapshotBehaviourMigration).toHaveBeenCalledTimes(2);
  });

  it('re-reads and continues when another caller applied the same chunk', async () => {
    vi.mocked(repository.beginBehaviourMigration).mockResolvedValue(work());
    vi.mocked(repository.getBehaviourMigrationWork)
      // The contended pass re-reads the same cursor; the winner's advance shows up next.
      .mockResolvedValueOnce(work())
      .mockResolvedValue(work({ cursor: 1 }));
    vi.mocked(repository.applyBehaviourMigrationChunk).mockRejectedValue(
      new repository.BehaviourMigrationContendedError(),
    );

    await expect(change()).resolves.toMatchObject({ list: { behaviour: 'watch' } });
    expect(repository.applyBehaviourMigrationChunk).toHaveBeenCalledTimes(1);
  });

  it('rethrows a chunk failure that is not contention', async () => {
    installReturns(work());
    const boom = new Error('throughput');
    vi.mocked(repository.applyBehaviourMigrationChunk).mockRejectedValue(boom);

    await expect(change()).rejects.toBe(boom);
  });

  /**
   * The bounded drain is the whole reason the endpoint can answer at all on a 500-item list.
   * When the budget runs out with work still to do, the caller gets the retryable answer and
   * the next request continues from the stored cursor.
   */
  it('answers 503 when work outlives the bounded drain, without finishing', async () => {
    installReturns(work({ entries: Array.from({ length: 900 }, atEntry) }));
    vi.mocked(repository.applyBehaviourMigrationChunk).mockImplementation((current) =>
      Promise.resolve(current),
    );

    await expect(change()).rejects.toBeInstanceOf(repository.ListReadFenceError);
    expect(repository.finishBehaviourMigration).not.toHaveBeenCalled();
  });
});

function atEntry(_value: unknown, index: number) {
  return { itemId: `itm_${String(index)}`, rank: `a${String(index)}`, fromRevision: 0 };
}

describe('a replay that arrives before the receipt exists', () => {
  /**
   * The operation id is derived from the key, so a replay recognises its **own** outstanding
   * work and resumes it. The derivation is not restated here: the first call's id is captured
   * and handed back as the standing marker, which is exactly what storage would have done.
   */
  it('resumes its own migration instead of installing a second', async () => {
    installReturns(work({ cursor: 1 }));
    await change();
    const operationId = vi.mocked(repository.beginBehaviourMigration).mock.calls[0]?.[3]
      .operationId as string;
    expect(operationId).toMatch(/^bmg_/);

    vi.clearAllMocks();
    vi.mocked(repository.getListMeta).mockResolvedValue(
      list({ behaviourMigrationId: operationId }),
    );
    vi.mocked(repository.getBehaviourMigrationWork).mockResolvedValue(
      work({ operationId, cursor: 1 }),
    );
    vi.mocked(repository.finishBehaviourMigration).mockResolvedValue(undefined);

    const resumed = await change();

    expect(repository.beginBehaviourMigration).not.toHaveBeenCalled();
    expect(resumed.list.behaviour).toBe('watch');
    expect(resumed.undo?.token).toBe('tok');
  });

  /** A marker installed by somebody else between the read and the write is not ours to keep. */
  it('drains and answers 503 when another operation took the gate first', async () => {
    vi.mocked(repository.beginBehaviourMigration).mockRejectedValue(
      new repository.BehaviourMigrationAlreadyStartedError(),
    );
    vi.mocked(repository.getBehaviourMigrationWork).mockResolvedValue(undefined);

    await expect(change()).rejects.toBeInstanceOf(repository.ListReadFenceError);
  });

  it('rethrows an install failure that is not contention', async () => {
    const boom = new Error('throughput');
    vi.mocked(repository.beginBehaviourMigration).mockRejectedValue(boom);

    await expect(change()).rejects.toBe(boom);
  });
});

describe('binding the confirmation to what is actually there', () => {
  /** A lossy operation's record: no Undo offer was prepared for it (§4.1). */
  const withoutUndo = (
    overrides: Partial<BehaviourMigrationWork> = {},
  ): BehaviourMigrationWork => {
    const record = work(overrides);
    delete (record as { undo?: unknown }).undo;
    return record;
  };

  const watching = {
    itemId: 'itm_a',
    listId: LIST,
    rank: 'a0',
    itemRevision: 0,
    title: 'Severance',
    checked: false,
    details: { behaviour: 'watch', watchStatus: 'watching', season: 2 },
  } as unknown as ListItem;

  beforeEach(() => {
    vi.mocked(repository.getListMeta).mockResolvedValue(list({ behaviour: 'watch' }));
  });

  /**
   * The count that decides the confirmation is taken before the marker goes down, so a write
   * landing in between can change what the operation is about to destroy. The snapshot taken
   * **under** the gate is the real one, and when the two disagree the untouched install is
   * rolled back and the caller is answered with the truth.
   */
  it('rolls the install back and re-asks when the gated count disagrees', async () => {
    vi.mocked(repository.snapshotListItems).mockResolvedValue({
      items: [],
      rankVersion: 3,
      itemVersion: 0,
    });
    vi.mocked(repository.beginBehaviourMigration).mockResolvedValue(
      work({ fromBehaviour: 'watch', toBehaviour: 'collection', lossCount: 1 }),
    );

    await expect(change('collection')).rejects.toMatchObject({
      code: 'conflict',
      confirmation: {
        fromBehaviour: 'watch',
        toBehaviour: 'collection',
        itemVersion: 0,
        itemCount: 0,
        fields: [],
      },
    });
    expect(repository.abandonBehaviourMigration).toHaveBeenCalled();
    expect(repository.applyBehaviourMigrationChunk).not.toHaveBeenCalled();
  });

  /** Confirmed is no exemption: it confirmed a loss of two, not of three. */
  it('re-asks a confirmed change whose gated count moved', async () => {
    vi.mocked(repository.snapshotListItems).mockResolvedValue({
      items: [watching],
      rankVersion: 3,
      itemVersion: 0,
    });
    vi.mocked(repository.beginBehaviourMigration).mockResolvedValue(
      work({ fromBehaviour: 'watch', toBehaviour: 'collection', lossCount: 5 }),
    );

    await expect(change('collection', true)).rejects.toMatchObject({ code: 'conflict' });
    expect(repository.abandonBehaviourMigration).toHaveBeenCalled();
  });

  /**
   * §1a.1 rule 3 and §4.1 read together: a departure that loses nothing is not destructive,
   * so it needs no confirmation — and being additive, it gets the standard Undo. Deciding
   * those two from different rules is what left an empty watchlist unable to be undone.
   */
  it('offers Undo on a departure that loses nothing', async () => {
    vi.mocked(repository.snapshotListItems).mockResolvedValue({
      items: [],
      rankVersion: 3,
      itemVersion: 0,
    });
    installReturns(
      work({
        fromBehaviour: 'watch',
        toBehaviour: 'collection',
        cursor: 1,
        lossCount: 0,
      }),
    );

    const result = await change('collection');

    expect(result.undo?.token).toBe('tok');
    expect(
      vi.mocked(repository.beginBehaviourMigration).mock.calls[0]?.[3].undo,
    ).toBeDefined();
    expect(
      vi.mocked(repository.finishBehaviourMigration).mock.calls[0]?.[1].undo,
    ).toBeDefined();
  });

  /** A departure that does lose something is confirmed rather than offered (§4.1). */
  it('prepares no Undo for a confirmed lossy departure', async () => {
    vi.mocked(repository.snapshotListItems).mockResolvedValue({
      items: [watching],
      rankVersion: 3,
      itemVersion: 0,
    });
    const lossy = withoutUndo({
      fromBehaviour: 'watch',
      toBehaviour: 'collection',
      cursor: 1,
      lossCount: 1,
      lossFields: ['Watch status', 'Season'],
    });
    vi.mocked(repository.beginBehaviourMigration).mockResolvedValue(lossy);
    vi.mocked(repository.getBehaviourMigrationWork).mockResolvedValue(lossy);

    const result = await change('collection', true);

    expect(result.undo).toBeUndefined();
    expect(
      vi.mocked(repository.beginBehaviourMigration).mock.calls[0]?.[3].undo,
    ).toBeUndefined();
    expect(
      vi.mocked(repository.finishBehaviourMigration).mock.calls[0]?.[1].undo,
    ).toBeUndefined();
  });
});

describe('the checks before anything is installed', () => {
  it('409s a stale If-Match with the current version, installing nothing', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(
      list({ updatedAt: '2026-08-24T10:00:00.000Z' }),
    );

    await expect(change()).rejects.toMatchObject({
      code: 'conflict',
      details: [{ path: 'updatedAt', message: '2026-08-24T10:00:00.000Z' }],
    });
    expect(repository.beginBehaviourMigration).not.toHaveBeenCalled();
  });

  it('404s a list this caller can reach no row for', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(undefined);

    await expect(change()).rejects.toMatchObject({ code: 'not_found' });
  });

  /**
   * A rank repair holds the same gate, and the drain that clears it does not move
   * `updatedAt`, so the client's version is still good and the migration proceeds.
   */
  it('drains a standing rank repair, then installs its own migration', async () => {
    vi.mocked(repository.getListMeta)
      // The request's own read, then the drain's; the third is the post-drain re-read.
      .mockResolvedValueOnce(list({ rankRepairId: 'op_repair' }))
      .mockResolvedValueOnce(list({ rankRepairId: 'op_repair' }))
      .mockResolvedValue(list());
    installReturns(work({ cursor: 1 }));
    vi.mocked(repository.snapshotListItems).mockResolvedValue({
      items: [],
      rankVersion: 3,
      itemVersion: 0,
    });

    await expect(change()).resolves.toMatchObject({ list: { behaviour: 'watch' } });
    expect(repair.drainRankRepair).toHaveBeenCalled();
  });

  it('answers 503 when the standing work cannot be cleared', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(
      list({ rankRepairId: 'op_repair' }),
    );
    vi.mocked(repair.drainRankRepair).mockResolvedValue(false);

    await expect(change()).rejects.toBeInstanceOf(repository.ListReadFenceError);
    expect(repository.beginBehaviourMigration).not.toHaveBeenCalled();
  });

  /** A migration that finished under this request moved the version out from under it. */
  it('409s when a drained migration moved the version it was holding', async () => {
    vi.mocked(repository.getListMeta)
      .mockResolvedValueOnce(list({ behaviourMigrationId: 'op_someone_else' }))
      .mockResolvedValue(list({ updatedAt: '2026-08-24T11:00:00.000Z' }));
    vi.mocked(repository.getBehaviourMigrationWork).mockResolvedValue(undefined);

    await expect(change()).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('draining somebody else’s work', () => {
  it('reports clear when no marker stands', async () => {
    await expect(drainListWork(USER, LIST, GRANT, NOW)).resolves.toBe(true);
    await expect(drainBehaviourMigration(USER, LIST, GRANT, NOW)).resolves.toBe(true);
  });

  it('reports clear for a list that is gone', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(undefined);

    await expect(drainListWork(USER, LIST, GRANT, NOW)).resolves.toBe(true);
    await expect(drainBehaviourMigration(USER, LIST, GRANT, NOW)).resolves.toBe(true);
  });

  it('routes a rank-repair marker to the repair worker', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(
      list({ rankRepairId: 'op_repair' }),
    );

    await expect(drainListWork(USER, LIST, GRANT, NOW)).resolves.toBe(true);
    expect(repair.drainRankRepair).toHaveBeenCalledWith(USER, LIST, GRANT, NOW);
  });

  /**
   * The marker and its record are written and cleared in one transaction, so a marker naming
   * nothing is not a race — it is corruption, and continuing on a snapshot nobody has would
   * migrate rows from nothing. It is reported rather than retried forever.
   */
  it('raises when a standing marker names no work record', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(
      list({ behaviourMigrationId: 'bmg_ghost' }),
    );
    vi.mocked(repository.getBehaviourMigrationWork).mockResolvedValue(undefined);

    await expect(drainBehaviourMigration(USER, LIST, GRANT, NOW)).rejects.toMatchObject({
      code: 'internal',
      details: [{ path: 'behaviourMigrationId', message: expect.any(String) }],
    });
  });

  it('reports clear when the marker went between the two reads', async () => {
    vi.mocked(repository.getListMeta)
      .mockResolvedValueOnce(list({ behaviourMigrationId: 'bmg_ghost' }))
      .mockResolvedValue(list());
    vi.mocked(repository.getBehaviourMigrationWork).mockResolvedValue(undefined);

    await expect(drainBehaviourMigration(USER, LIST, GRANT, NOW)).resolves.toBe(true);
  });
});

describe('withListWorkDrain', () => {
  it('returns a read that succeeds without touching the drain', async () => {
    const read = vi.fn(() => Promise.resolve('page'));

    await expect(withListWorkDrain(USER, LIST, GRANT, read, NOW)).resolves.toBe('page');
    expect(read).toHaveBeenCalledTimes(1);
    expect(repository.getListMeta).not.toHaveBeenCalled();
  });

  it('retries the read once after clearing the work that fenced it', async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new repository.ListReadFenceError())
      .mockResolvedValue('page');

    await expect(withListWorkDrain(USER, LIST, GRANT, read, NOW)).resolves.toBe('page');
    expect(read).toHaveBeenCalledTimes(2);
  });

  /**
   * A `rankVersion` that moved between a page's two META reads is not drainable. The drain
   * reports clear immediately and the caller gets the fence it started with, which is the
   * `503` telling the client to restart at page one.
   */
  it('rethrows the fence when there was no work to clear', async () => {
    vi.mocked(repository.getListMeta).mockResolvedValue(
      list({ rankRepairId: 'op_repair' }),
    );
    vi.mocked(repair.drainRankRepair).mockResolvedValue(false);
    const fence = new repository.ListReadFenceError();
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(fence);

    await expect(withListWorkDrain(USER, LIST, GRANT, read, NOW)).rejects.toBe(fence);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('passes anything that is not a fence straight through', async () => {
    const boom = new AppError('not_found', 'List not found.');
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(boom);

    await expect(withListWorkDrain(USER, LIST, GRANT, read, NOW)).rejects.toBe(boom);
  });
});
