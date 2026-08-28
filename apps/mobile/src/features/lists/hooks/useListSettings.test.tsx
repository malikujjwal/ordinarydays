import type { FetchLike } from '@od/shared/client';
import { instant } from '@od/shared/schemas';
import type { List, ListBehaviour, ListBehaviourConfirmation } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useListSettings } from './useListSettings';

/**
 * The settings protocol (§P3-32, §P3-09,
 * [`interaction-contract.md`](../../../../../docs/01-product/interaction-contract.md) §1a.1,
 * §4.1).
 *
 * ## Why the real transport, and only `fetch` is faked
 *
 * The properties under test are transport properties: that one decision leaves the device
 * under **one** `Idempotency-Key` however many times it is retried, that the `409` becomes a
 * typed confirmation rather than an error toast, and that the confirmed call echoes the
 * server's object **byte-identically**. Stubbing `changeListBehaviour` would assert the
 * arguments this file passes and prove none of that. So the hook talks to a real
 * `createHttpClient` and the requests are read off the fake `fetch`.
 */

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const calls = vi.hoisted(() => ({ uuid: vi.fn(), fetch: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));
vi.mock('@/lib/apiClient', async () => {
  const { createHttpClient: create } = await import('@od/shared/client');
  return {
    apiClient: create({
      baseUrl: 'https://api.test',
      fetch: calls.fetch as unknown as FetchLike,
      tokenProvider: {
        getToken: async () => 'token',
        getIdentity: async () => 'usr_local_dev',
      },
      timezone: 'Europe/London',
      clientVersion: 'test/1.0.0',
      strictResponses: true,
      // A retry test must not spend real seconds sleeping.
      sleep: async () => undefined,
      newRequestId: () => 'req_test',
    }),
  };
});

const list = (overrides: Partial<List> = {}): List => ({
  listId: LIST_ID,
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: 'groceries',
  itemCount: 20,
  uncheckedCount: 2,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-27T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-27T09:00:00.000Z'),
  ...overrides,
});

const preview = (
  overrides: Partial<ListBehaviourConfirmation> = {},
): ListBehaviourConfirmation => ({
  fromBehaviour: 'watch',
  toBehaviour: 'collection',
  itemVersion: 12,
  itemCount: 7,
  fields: ['Watch status', 'Season', 'Episode'],
  ...overrides,
});

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const settings = (row: List, undo?: { token: string; expiresAt: string }): Reply =>
  ok({
    data:
      undo === undefined
        ? { list: row }
        : { list: row, undoToken: undo.token, undoExpiresAt: undo.expiresAt },
    meta: { requestId: 'req_test' },
  });
const conflict = (confirmation: ListBehaviourConfirmation): Reply => ({
  status: 409,
  body: {
    error: {
      code: 'conflict',
      message: 'Changing this list would remove information its items are carrying.',
      requestId: 'req_test',
    },
    confirmation,
  },
});
const undone = (
  outcome: 'applied' | 'expired' | 'no_longer_applicable' = 'applied',
): Reply =>
  ok({
    data: outcome === 'applied' ? { outcome, affectedCount: 1 } : { outcome },
    meta: { requestId: 'req_test' },
  });
const unavailable = (): Reply => ({
  status: 503,
  body: { error: { code: 'internal', message: 'Try again.', requestId: 'req_test' } },
});

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const sent: Sent[] = [];

function reply(...queue: Reply[]) {
  let index = 0;
  calls.fetch.mockImplementation(
    async (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      sent.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        body: init?.body === undefined ? undefined : JSON.parse(init.body),
      });
      const next = queue[Math.min(index, queue.length - 1)];
      index += 1;
      if (next === undefined) throw new Error(`no reply queued for ${url}`);
      return {
        ok: next.status < 400,
        status: next.status,
        headers: { get: () => null },
        json: async () => next.body,
        text: async () => JSON.stringify(next.body),
      };
    },
  );
}

const behaviourCalls = () => sent.filter((call) => call.url.endsWith('/behaviour'));
const keysOf = (calls_: readonly Sent[]) =>
  calls_.map((call) => call.headers['Idempotency-Key']);

function setup(...row: readonly [List | undefined] | []) {
  const onChanged = vi.fn();
  const onServerChanged = vi.fn();
  const rendered = renderHook(
    ({ current }: { current: List | undefined }) =>
      useListSettings({ list: current, onChanged, onServerChanged }),
    { initialProps: { current: row.length === 0 ? list() : row[0] } },
  );
  return { ...rendered, onChanged, onServerChanged };
}

const tapUndo = () => {
  const current = useToast.getState().current;
  if (current?.kind !== 'undo') throw new Error('no undo toast is being offered');
  act(() => current.onUndo());
};

beforeEach(() => {
  sent.length = 0;
  let next = 0;
  calls.uuid.mockImplementation(() => `key-${++next}`);
  useToast.setState({ current: undefined });
  reply(settings(list()));
});

describe('the additive controls', () => {
  it('renames with one PATCH under If-Match, and offers no undo', async () => {
    reply(settings(list({ title: 'Shopping' })));
    const { result, onChanged } = setup();

    act(() => result.current.rename('Shopping'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('PATCH');
    expect(sent[0]?.body).toEqual({ title: 'Shopping' });
    expect(sent[0]?.headers['If-Match']).toBe('2026-08-27T09:00:00.000Z');
    // §4.1 has no undo row for renaming a list, and the response carries no token.
    expect(useToast.getState().current).toBeUndefined();
  });

  it('draws the new title before the server answers', async () => {
    reply(settings(list({ title: 'Shopping' })));
    const { result } = setup();

    act(() => result.current.rename('Shopping'));
    expect(result.current.view?.title).toBe('Shopping');
  });

  it('sends one capability without restating the other', async () => {
    reply(
      settings(list({ capabilities: { checkable: false, supportsLocation: false } }), {
        token: 'undo-1',
        expiresAt: new Date(Date.now() + 6_000).toISOString(),
      }),
    );
    const { result } = setup();

    act(() => result.current.setCapability('checkable', false));
    await waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]?.body).toEqual({ capabilities: { checkable: false } });
    expect(result.current.view?.capabilities).toEqual({
      checkable: false,
      supportsLocation: false,
    });
  });

  /** §4.1's capability row: no dialog, a six-second undo, and `/undo` with the token. */
  it('offers the undo and reverts through the compensation endpoint', async () => {
    reply(
      settings(list({ capabilities: { checkable: false, supportsLocation: false } }), {
        token: 'undo-1',
        expiresAt: new Date(Date.now() + 6_000).toISOString(),
      }),
      undone(),
    );
    const { result } = setup();

    act(() => result.current.setCapability('checkable', false));
    await waitFor(() =>
      expect(useToast.getState().current?.message).toBe('Checkboxes hidden'),
    );
    expect(useToast.getState().current?.duration).toBeLessThanOrEqual(6_000);

    tapUndo();
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[1]?.url).toContain('/undo');
    expect(sent[1]?.body).toEqual({ undoToken: 'undo-1' });
    // Never a second PATCH: the server owns the inverse and the client sends only the token.
    expect(sent.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(result.current.view?.capabilities.checkable).toBe(true);
  });

  it('clears a slot with an explicit null rather than by omitting it', async () => {
    reply(
      settings(list({ slot: null }), {
        token: 'undo-slot',
        expiresAt: new Date(Date.now() + 6_000).toISOString(),
      }),
    );
    const { result } = setup();

    act(() => result.current.setSlot(null));
    await waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]?.body).toEqual({ slot: null });
    // One list PATCH, and no second request to the profile (§5.5's edge case).
    expect(sent.every((call) => !call.url.includes('/me'))).toBe(true);
  });

  it('puts the failed field back and leaves the others alone', async () => {
    reply(settings(list({ title: 'Shopping' })), {
      status: 403,
      body: {
        error: { code: 'forbidden', message: 'Not yours.', requestId: 'req_test' },
      },
    });
    const { result } = setup();

    act(() => result.current.rename('Shopping'));
    await waitFor(() => expect(result.current.view?.title).toBe('Shopping'));

    act(() => result.current.setCapability('checkable', false));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('message'));
    expect(result.current.view?.capabilities.checkable).toBe(true);
    // The rename stands: a rejected toggle is not a reason to take back a different write.
    expect(result.current.view?.title).toBe('Shopping');
  });

  it('names the losing side of a concurrent list edit', async () => {
    reply({
      status: 409,
      body: {
        error: { code: 'conflict', message: 'Version mismatch.', requestId: 'req_test' },
      },
    });
    const { result } = setup();

    act(() => result.current.rename('Shopping'));
    await waitFor(() =>
      expect(useToast.getState().current?.message).toBe(
        'This list changed while you were editing.',
      ),
    );
  });
});

describe('upgrading a behaviour', () => {
  /** §4.1's upgrade row: additive, so it applies at once with no dialog. */
  it('applies with no dialog and offers Undo', async () => {
    reply(
      settings(list({ behaviour: 'watch' }), {
        token: 'undo-upgrade',
        expiresAt: new Date(Date.now() + 6_000).toISOString(),
      }),
    );
    const { result } = setup();

    act(() => result.current.changeBehaviour('watch'));
    expect(result.current.confirmation).toBeUndefined();
    expect(result.current.view?.behaviour).toBe('watch');

    await waitFor(() =>
      expect(useToast.getState().current?.message).toBe('Now a watchlist'),
    );
    expect(behaviourCalls()[0]?.body).toEqual({ behaviour: 'watch' });
    // No `confirmation` is sent for an additive change; there is nothing to confirm.
    expect(behaviourCalls()[0]?.body).not.toHaveProperty('confirmation');
  });

  /** §P3-32: undo goes through `/undo`, never through a destructive downgrade POST. */
  it('undoes through the compensation endpoint and restores collection', async () => {
    reply(
      settings(list({ behaviour: 'watch' }), {
        token: 'undo-upgrade',
        expiresAt: new Date(Date.now() + 6_000).toISOString(),
      }),
      undone(),
    );
    const { result, rerender } = setup();

    act(() => result.current.changeBehaviour('watch'));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    // The refresh the accepted change asked for: `watch` is now committed truth.
    rerender({ current: list({ behaviour: 'watch' }) });
    tapUndo();
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[1]?.url).toContain('/undo');
    expect(sent[1]?.body).toEqual({ undoToken: 'undo-upgrade' });
    expect(behaviourCalls()).toHaveLength(1);
    expect(result.current.view?.behaviour).toBe('collection');
  });

  /**
   * §P3-32: a `no_longer_applicable` outcome leaves current data untouched, and says so. The
   * list stays on the behaviour the upgrade gave it rather than snapping back to a lie.
   */
  it('leaves the list as it is when the undo no longer applies, and says so', async () => {
    reply(
      settings(list({ behaviour: 'watch' }), {
        token: 'undo-upgrade',
        expiresAt: new Date(Date.now() + 6_000).toISOString(),
      }),
      undone('no_longer_applicable'),
    );
    const { result, rerender } = setup();

    act(() => result.current.changeBehaviour('watch'));
    await waitFor(() => expect(useToast.getState().current?.kind).toBe('undo'));
    rerender({ current: list({ behaviour: 'watch' }) });
    tapUndo();

    await waitFor(() =>
      expect(useToast.getState().current?.message).toBe(
        'The list has changed since, so it was left as it is.',
      ),
    );
    // The compensation did not run, so the list stays exactly as the upgrade left it.
    expect(result.current.view?.behaviour).toBe('watch');
  });

  /** §P3-09: one key identifies the migration, so a replay resumes it rather than restarting. */
  it('reuses one idempotency key across transport retries', async () => {
    reply(unavailable(), unavailable(), settings(list({ behaviour: 'watch' })));
    const { result } = setup();

    act(() => result.current.changeBehaviour('watch'));
    await waitFor(() => expect(behaviourCalls()).toHaveLength(3));

    expect(new Set(keysOf(behaviourCalls())).size).toBe(1);
  });
});

describe('downgrading a behaviour', () => {
  const watchList = list({ behaviour: 'watch', title: 'Watchlist' });

  /** The unconfirmed call is a preview: it asks, and the `409` is the answer, not a failure. */
  it('previews first and turns the 409 into the confirmation', async () => {
    reply(conflict(preview()));
    const { result } = setup(watchList);

    act(() => result.current.changeBehaviour('collection'));
    await waitFor(() => expect(result.current.confirmation).toEqual(preview()));

    expect(behaviourCalls()).toHaveLength(1);
    expect(behaviourCalls()[0]?.body).toEqual({ behaviour: 'collection' });
    // Not an error toast (§5.3's `409` row), and nothing has been applied optimistically.
    expect(useToast.getState().current).toBeUndefined();
    expect(result.current.view?.behaviour).toBe('watch');
  });

  it('writes nothing when the question is cancelled', async () => {
    reply(conflict(preview()));
    const { result } = setup(watchList);

    act(() => result.current.changeBehaviour('collection'));
    await waitFor(() => expect(result.current.confirmation).toBeDefined());
    act(() => result.current.cancelBehaviour());

    expect(result.current.confirmation).toBeUndefined();
    expect(result.current.view?.behaviour).toBe('watch');
    expect(behaviourCalls()).toHaveLength(1);
  });

  /** The whole object goes back, unedited: `itemVersion` binds the decision to a generation. */
  it('echoes the complete confirmation byte-identically on confirm', async () => {
    const answer = preview();
    reply(conflict(answer), settings(list({ behaviour: 'collection' })));
    const { result } = setup(watchList);

    act(() => result.current.changeBehaviour('collection'));
    await waitFor(() => expect(result.current.confirmation).toBeDefined());
    act(() => result.current.confirmBehaviour());
    await waitFor(() => expect(behaviourCalls()).toHaveLength(2));

    const echoed = behaviourCalls()[1]?.body as {
      behaviour: ListBehaviour;
      confirmation: ListBehaviourConfirmation;
    };
    expect(echoed.behaviour).toBe('collection');
    expect(echoed.confirmation).toEqual(answer);
    expect(JSON.stringify(echoed.confirmation)).toBe(JSON.stringify(answer));
  });

  it('closes the question and offers no undo once the destructive change lands', async () => {
    reply(conflict(preview()), settings(list({ behaviour: 'collection' })));
    const { result, onChanged } = setup(watchList);

    act(() => result.current.changeBehaviour('collection'));
    await waitFor(() => expect(result.current.confirmation).toBeDefined());
    act(() => result.current.confirmBehaviour());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    expect(result.current.confirmation).toBeUndefined();
    expect(result.current.view?.behaviour).toBe('collection');
    // Destructive changes get a confirmation and **no** undo (§4.1).
    expect(useToast.getState().current).toBeUndefined();
  });

  it('uses a new key for the confirmed call, and reuses it across transport retries', async () => {
    reply(
      conflict(preview()),
      unavailable(),
      unavailable(),
      settings(list({ behaviour: 'collection' })),
    );
    const { result } = setup(watchList);

    act(() => result.current.changeBehaviour('collection'));
    await waitFor(() => expect(result.current.confirmation).toBeDefined());
    act(() => result.current.confirmBehaviour());
    await waitFor(() => expect(behaviourCalls()).toHaveLength(4));

    const [previewKey, ...confirmed] = keysOf(behaviourCalls());
    expect(new Set(confirmed).size).toBe(1);
    expect(confirmed[0]).not.toBe(previewKey);
  });

  /**
   * §P3-09: an item mutation between preview and confirmation makes the count wrong, so a
   * fresh `409` replaces the question rather than failing the action.
   */
  it('replaces the question when the server previews it again', async () => {
    const second = preview({ itemCount: 8, itemVersion: 13 });
    reply(conflict(preview()), conflict(second));
    const { result } = setup(watchList);

    act(() => result.current.changeBehaviour('collection'));
    await waitFor(() => expect(result.current.confirmation?.itemCount).toBe(7));
    act(() => result.current.confirmBehaviour());
    await waitFor(() => expect(result.current.confirmation?.itemCount).toBe(8));

    expect(result.current.confirmation).toEqual(second);
    expect(result.current.view?.behaviour).toBe('watch');
  });

  /**
   * §1a.1 rule 3: "a conditional confirmation that can appear with a count of 0 is a bug". The
   * server answers additively with a settings token, and the client renders an ordinary toggle.
   */
  it('shows no dialog and takes a token when nothing would be lost', async () => {
    reply(
      settings(list({ behaviour: 'collection' }), {
        token: 'undo-empty-downgrade',
        expiresAt: new Date(Date.now() + 6_000).toISOString(),
      }),
    );
    const { result, onServerChanged } = setup(watchList);

    act(() => result.current.changeBehaviour('collection'));
    await waitFor(() => expect(onServerChanged).toHaveBeenCalled());

    expect(result.current.confirmation).toBeUndefined();
    expect(result.current.view?.behaviour).toBe('collection');
    expect(useToast.getState().current?.message).toBe('Now a plain list');
    expect(behaviourCalls()).toHaveLength(1);
    expect(behaviourCalls()[0]?.body).toEqual({ behaviour: 'collection' });
  });
});

describe('the optimistic overlay', () => {
  it('retires a field once the committed projection carries it', async () => {
    reply(settings(list({ title: 'Shopping' })));
    const { result, rerender } = setup();

    act(() => result.current.rename('Shopping'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(result.current.view?.title).toBe('Shopping');

    rerender({ current: list({ title: 'Shopping' }) });
    // Still `Shopping`, now because the row says so rather than because the overlay does.
    expect(result.current.view?.title).toBe('Shopping');

    rerender({ current: list({ title: 'Renamed elsewhere' }) });
    expect(result.current.view?.title).toBe('Renamed elsewhere');
  });

  it('has no view at all before the projection has a list', () => {
    const { result } = setup(undefined);

    expect(result.current.view).toBeUndefined();
    act(() => result.current.rename('Shopping'));
    expect(sent).toHaveLength(0);
  });

  it('sends nothing when the value is already what was asked for', () => {
    const { result } = setup();

    act(() => result.current.rename('Groceries'));
    act(() => result.current.setCapability('checkable', true));
    act(() => result.current.setSlot('groceries'));
    act(() => result.current.changeBehaviour('collection'));

    expect(sent).toHaveLength(0);
  });
});
