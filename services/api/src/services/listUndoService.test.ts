import { instant } from '@od/shared/schemas';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { hashUndoToken, mintUndoToken } from '../lib/undoToken.js';
import type {
  ListAccessGrant,
  ListUndoOperation,
} from '../repositories/listRepository.js';

/**
 * The compensation service's own decisions, with storage mocked
 * (`definition-of-done.md` §3).
 *
 * `test/integration/listUndo.int.test.ts` proves what the inverses actually write; this file
 * proves what the **service** answers, which is a different question and mostly about the
 * cases where it writes nothing at all. Three of them are easy to get subtly wrong: a token
 * that names nothing must be indistinguishable from one past retention, an already-used
 * operation must not be an error, and `undoExpiresAt` must never be consulted.
 */

vi.mock('../repositories/listRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../repositories/listRepository.js')
  >('../repositories/listRepository.js');
  return {
    ...actual,
    acceptListUndoOperation: vi.fn(() =>
      Promise.resolve({
        acceptedAt: instant.parse('2026-08-24T09:00:00.000Z'),
        completedCount: 0,
      }),
    ),
    getListMeta: vi.fn(),
    getListUndoOperation: vi.fn(),
    applyListSettingsInverse: vi.fn(() => Promise.resolve()),
    consumeListUndoOperation: vi.fn(() => Promise.resolve()),
    readAllListItems: vi.fn(() => Promise.resolve([])),
    restoreDoneStates: vi.fn(() => Promise.resolve(0)),
    restoreListItems: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('./authz.js', () => ({ assertListAccess: vi.fn() }));
const repository = await import('../repositories/listRepository.js');
const authz = await import('./authz.js');
const { undoListOperation } = await import('./listUndoService.js');

const USER = 'usr_local_dev';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const NOW = instant.parse('2026-08-24T09:00:00.000Z');
const RETRY_AT = instant.parse('2026-08-24T09:05:00.000Z');
const GRANT = { listId: LIST, userId: USER, role: 'owner' } as unknown as ListAccessGrant;

const RECEIPT: IdempotencyReceipt = {
  userId: USER,
  key: 'key',
  route: 'POST /v1/lists/:id/undo',
  status: 200,
  body: '{}',
  ttl: 0,
  createdAt: NOW,
};
const receiptFor = vi.fn(() => RECEIPT);

/** A live operation: well inside retention, unused. */
const operation = (overrides: Partial<ListUndoOperation> = {}): ListUndoOperation => ({
  listId: LIST,
  operationId: 'op_live',
  kind: 'clear_done',
  tokenHash: 'unset',
  // Deliberately in the past: the UI window is over, and it must change nothing here.
  undoExpiresAt: '2026-08-24T08:00:00.000Z',
  affectedItemIds: ['itm_a', 'itm_b'],
  completedCount: 0,
  consumed: false,
  ttl: Math.floor(Date.parse(NOW) / 1000) + 60 * 60 * 24,
  ...overrides,
});

/** A token addressing that operation, and the record that would accept it. */
function live(overrides: Partial<ListUndoOperation> = {}) {
  const record = operation(overrides);
  const { token, tokenHash } = mintUndoToken(record.operationId);
  vi.mocked(repository.getListUndoOperation).mockResolvedValue({ ...record, tokenHash });
  return token;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authz.assertListAccess).mockResolvedValue({ index: GRANT, isOwner: true });
  vi.mocked(repository.readAllListItems).mockResolvedValue([]);
  vi.mocked(repository.restoreListItems).mockResolvedValue([]);
  vi.mocked(repository.restoreDoneStates).mockResolvedValue(0);
  vi.mocked(repository.acceptListUndoOperation).mockResolvedValue({
    acceptedAt: NOW,
    completedCount: 0,
  });
});

const undoAt = (token: string, now: string) =>
  undoListOperation(USER, LIST, token, now, receiptFor as never);
const undo = (token: string) => undoAt(token, NOW);

describe('resolving the token', () => {
  /**
   * A token that names nothing, one whose secret half is wrong and one past retention are the
   * **same answer**: telling a caller their token is well-formed but stale would tell them
   * something about an operation they may not own.
   */
  it('answers expired for a token with no addressable half', async () => {
    await expect(undo('no-separator')).resolves.toEqual({ outcome: 'expired' });
    await expect(undo('.leading-separator')).resolves.toEqual({ outcome: 'expired' });
    await expect(undo('trailing-separator.')).resolves.toEqual({ outcome: 'expired' });
    expect(repository.getListUndoOperation).not.toHaveBeenCalled();
  });

  it('answers expired for a token addressing no operation', async () => {
    vi.mocked(repository.getListUndoOperation).mockResolvedValue(undefined);

    await expect(undo('op_gone.secret')).resolves.toEqual({ outcome: 'expired' });
    expect(repository.restoreListItems).not.toHaveBeenCalled();
  });

  it('answers expired when the secret half does not match', async () => {
    live();

    await expect(undo('op_live.a-different-secret')).resolves.toEqual({
      outcome: 'expired',
    });
    expect(repository.restoreListItems).not.toHaveBeenCalled();
  });

  /**
   * TTL deletion is lazy — typically within 48 hours, with no guarantee — so an operation
   * past retention is very often still readable. Treating "present" as "valid" would quietly
   * extend the retention by however long the sweeper took.
   */
  it('answers expired for an operation past retention that storage has not swept', async () => {
    const token = live({ ttl: Math.floor(Date.parse(NOW) / 1000) - 1 });

    await expect(undo(token)).resolves.toEqual({ outcome: 'expired' });
    expect(repository.restoreListItems).not.toHaveBeenCalled();
  });

  /** Single use. Already spent is not an error — it is what happened to the compensation. */
  it('answers no_longer_applicable for an operation already used', async () => {
    const token = live({ consumed: true });

    await expect(undo(token)).resolves.toEqual({ outcome: 'no_longer_applicable' });
    expect(repository.restoreListItems).not.toHaveBeenCalled();
  });

  /**
   * The rule this file is arranged around: the UI deadline governs whether a client may
   * **offer** a new Undo, never whether an accepted inverse may run. Every fixture here has an
   * `undoExpiresAt` an hour in the past, and this one still applies.
   */
  it('applies an inverse whose UI window closed long ago', async () => {
    const token = live();
    vi.mocked(repository.restoreListItems).mockResolvedValue([
      { itemId: 'itm_a' },
      { itemId: 'itm_b' },
    ] as never);

    await expect(undo(token)).resolves.toEqual({ outcome: 'applied', affectedCount: 2 });
  });
});

describe('dispatching on the recorded kind', () => {
  it('restores a delete through the tombstone-aware path', async () => {
    const token = live({ kind: 'delete_item', affectedItemIds: ['itm_a'] });
    vi.mocked(repository.restoreListItems).mockResolvedValue([
      { itemId: 'itm_a' },
    ] as never);

    await expect(undo(token)).resolves.toEqual({ outcome: 'applied', affectedCount: 1 });
    expect(vi.mocked(repository.restoreListItems).mock.calls[0]?.[3]).toEqual(['itm_a']);
  });

  /** An empty clear still spends its token, so the offer cannot be used twice. */
  it('spends an empty clear without restoring anything', async () => {
    const token = live({ affectedItemIds: [] });

    await expect(undo(token)).resolves.toEqual({ outcome: 'applied', affectedCount: 0 });
    expect(repository.consumeListUndoOperation).toHaveBeenCalled();
    expect(repository.restoreListItems).not.toHaveBeenCalled();
  });

  it('re-checks exactly the recorded set, and reports the survivors', async () => {
    const token = live({ kind: 'reopen_done', affectedItemIds: ['itm_a', 'itm_b'] });
    vi.mocked(repository.restoreDoneStates).mockResolvedValue(1);

    await expect(undo(token)).resolves.toEqual({ outcome: 'applied', affectedCount: 1 });
    expect(vi.mocked(repository.restoreDoneStates).mock.calls[0]?.[3]).toEqual([
      'itm_a',
      'itm_b',
    ]);
  });

  it('includes already committed restore chunks in the logical Undo count', async () => {
    const token = live({ kind: 'clear_done', affectedItemIds: ['itm_a', 'itm_b'] });
    vi.mocked(repository.acceptListUndoOperation).mockResolvedValue({
      acceptedAt: NOW,
      completedCount: 1,
    });
    vi.mocked(repository.restoreListItems).mockResolvedValue([
      {
        itemId: 'itm_b',
        listId: LIST,
        rank: 'V',
        itemRevision: 0,
        title: 'B',
        state: 'done',
      },
    ]);

    await expect(undo(token)).resolves.toEqual({
      outcome: 'applied',
      affectedCount: 2,
    });
    expect(vi.mocked(repository.restoreListItems).mock.calls[0]?.[4]).toMatchObject({
      previouslyAffectedCount: 1,
    });
  });

  it('reuses the first accepted instant when a bulk Undo resumes', async () => {
    const token = live({ kind: 'reopen_done', affectedItemIds: ['itm_a'] });
    const acceptedAt = instant.parse('2026-08-24T08:59:30.000Z');
    vi.mocked(repository.acceptListUndoOperation).mockResolvedValue({
      acceptedAt,
      completedCount: 0,
    });

    await undo(token);

    expect(vi.mocked(repository.restoreDoneStates).mock.calls[0]?.[4]).toMatchObject({
      now: acceptedAt,
    });
  });

  it('keeps that instant after a compensation chunk crashes and a later request resumes', async () => {
    const token = live({ kind: 'reopen_done', affectedItemIds: ['itm_a', 'itm_b'] });
    const acceptedAt = instant.parse('2026-08-24T08:59:30.000Z');
    vi.mocked(repository.acceptListUndoOperation)
      .mockResolvedValueOnce({ acceptedAt, completedCount: 0 })
      .mockResolvedValueOnce({ acceptedAt, completedCount: 1 });
    // The first rejection represents a later repository chunk failing after an earlier one
    // committed; the next service invocation is the post-restart request with a changed clock.
    vi.mocked(repository.restoreDoneStates)
      .mockRejectedValueOnce(new Error('process stopped after a committed chunk'))
      .mockResolvedValueOnce(2);

    await expect(undoAt(token, NOW)).rejects.toThrow('process stopped');
    await expect(undoAt(token, RETRY_AT)).resolves.toEqual({
      outcome: 'applied',
      affectedCount: 2,
    });

    expect(
      vi.mocked(repository.acceptListUndoOperation).mock.calls.map((call) => call[4]),
    ).toEqual([NOW, RETRY_AT]);
    expect(
      vi.mocked(repository.restoreDoneStates).mock.calls.map((call) => call[4].now),
    ).toEqual([acceptedAt, acceptedAt]);
    expect(
      vi
        .mocked(repository.restoreDoneStates)
        .mock.calls.map((call) => call[4].previouslyAffectedCount),
    ).toEqual([0, 1]);
  });

  it('answers no_longer_applicable when a concurrent replay spends the bulk Undo', async () => {
    const token = live({ kind: 'reopen_done', affectedItemIds: ['itm_a'] });
    vi.mocked(repository.acceptListUndoOperation).mockRejectedValue(
      new repository.ListUndoNotApplicableError(),
    );

    await expect(undo(token)).resolves.toEqual({ outcome: 'no_longer_applicable' });
    expect(repository.restoreDoneStates).not.toHaveBeenCalled();
  });

  it('applies a settings inverse and reports one list changed', async () => {
    const token = live({
      kind: 'settings',
      inverse: { archived: false },
      preconditions: { archived: true },
    });

    await expect(undo(token)).resolves.toEqual({ outcome: 'applied', affectedCount: 1 });
    expect(vi.mocked(repository.applyListSettingsInverse).mock.calls[0]?.[3]).toEqual({
      archived: false,
    });
  });

  /**
   * A precondition that has moved is not a failure of the request — the operation is retained
   * and the token is right, the world simply changed. The condition lives on the write, and
   * this maps its refusal to the typed outcome.
   */
  it('answers no_longer_applicable when a settings condition refuses', async () => {
    const token = live({ kind: 'settings', inverse: { archived: false } });
    vi.mocked(repository.applyListSettingsInverse).mockRejectedValue(
      new repository.ListUndoNotApplicableError(),
    );

    await expect(undo(token)).resolves.toEqual({ outcome: 'no_longer_applicable' });
  });

  it('answers no_longer_applicable when every tombstone has gone', async () => {
    const token = live();
    vi.mocked(repository.restoreListItems).mockRejectedValue(
      new repository.ListUndoNotApplicableError(),
    );

    await expect(undo(token)).resolves.toEqual({ outcome: 'no_longer_applicable' });
  });

  it('rethrows a failure that is not a moved precondition', async () => {
    const token = live();
    const boom = new Error('throughput');
    vi.mocked(repository.restoreListItems).mockRejectedValue(boom);

    await expect(undo(token)).rejects.toBe(boom);
  });

  it('404s a list that has gone while the compensation ran', async () => {
    const token = live();
    vi.mocked(repository.restoreListItems).mockRejectedValue(
      new repository.ListNotFoundError(),
    );

    await expect(undo(token)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the token itself', () => {
  /**
   * Only the hash enters the retained Undo record, so leaking that row does not reveal the
   * capability — and the addressable half is what lets one `GetItem` find the operation
   * without a second index or a query across a month of retained ones. Exact-response
   * receipts are the separate, bounded replay copy of tokens returned to clients.
   */
  it('addresses its operation and hides its secret behind a hash', () => {
    const { token, tokenHash } = mintUndoToken('op_abc');

    expect(token.startsWith('op_abc.')).toBe(true);
    expect(tokenHash).toBe(hashUndoToken(token));
    expect(token).not.toContain(tokenHash);
    expect(mintUndoToken('op_abc').token).not.toBe(token);
  });
});
