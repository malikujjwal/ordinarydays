import { createHash, randomBytes } from 'node:crypto';
import { UNDO_OFFER_SECONDS } from '@od/shared';
import {
  type ChangeListBehaviourInput,
  DATA_LOSS_DETAIL_PATHS,
  type PatchListInput,
} from '@od/shared/schemas';
import type {
  List,
  ListBehaviour,
  ListCapabilities,
  ListItem,
  ListItemDetails,
} from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import { writeReceiptOnly } from '../repositories/idempotencyRepository.js';
import {
  applyBehaviourMigrationChunk,
  BehaviourMigrationAlreadyStartedError,
  BehaviourMigrationContendedError,
  type BehaviourMigrationWork,
  beginBehaviourMigration,
  finishBehaviourMigration,
  getBehaviourMigrationWork,
  getListMeta,
  type ListAccessGrant,
  ListNotFoundError,
  ListReadFenceError,
  type ListSettingsInverse,
  type ListSettingsPreconditions,
  type ListSettingsUndo,
  newListOperationId,
  patchListMeta,
  type RemovedListDefault,
  readAllListItems,
  snapshotBehaviourMigration,
} from '../repositories/listRepository.js';
import { assertListAccess, type ListAccess } from './authz.js';
import { drainRankRepair } from './listRankRepairService.js';

/**
 * List settings: capabilities, slot, archive and rename on `PATCH /v1/lists/:id`, and the
 * behaviour change on the replay-protected `POST /v1/lists/:id/behaviour`
 * (§P3-09, `api-contract.md` §2.7, `plans-and-lists.md` §5.5).
 *
 * ## The one rule the whole file implements
 *
 * `interaction-contract.md` §1a.1: an **additive** change loses nothing, so it applies
 * immediately with an Undo offer and no dialog; a **destructive** change removes stored data,
 * so it applies only after a confirmation that names the fields and the exact number of
 * records carrying them. Everything below is that sentence, split by which side of it a
 * change falls on.
 *
 * Capabilities, slot and archive are additive in both directions — turning `checkable` off
 * *retains* every `checked` value — so they are ordinary conditional `META` writes. Behaviour
 * is not, in either direction: `collection → watch` has to give 500 items a `details` object
 * they do not have, and `watch → collection` has to take one away. Public schema validation
 * requires `details.behaviour === List.behaviour` at every committed instant, so neither
 * direction can be one write, and both go through the same gated, resumable migration.
 *
 * ## Why the behaviour route is a POST and not part of the PATCH
 *
 * A migration is an operation, not a field edit. It needs a stable identity to resume under,
 * replay protection so a retried request does not start a second one, and a receipt holding
 * the answer it already gave. `POST /v1/lists/:id/behaviour` is registered `mutates: true`,
 * so the existing idempotency middleware owns receipt lookup and replay and there is no
 * second, PATCH-shaped receipt path to keep in step with it.
 */

/**
 * What both settings paths return.
 *
 * It carries the **stored** List, where the shared `ListSettingsMutation` wire shape carries
 * the `ListView` projection. The handler projects between them field by field, for `toUser`'s
 * reason: a projection that leaks by default is corrected by remembering, so the explicit one
 * stays the only way a row reaches a client.
 */
export interface ListSettingsResult {
  readonly list: List;
  readonly undoToken?: string;
  readonly undoExpiresAt?: string;
}

/** The copy for a stale `If-Match`, and its `409`, exactly as `activityService` produces it. */
const STALE = 'This changed while you were editing it. Review the update.';
const LIST_NOT_FOUND = 'List not found.';
const NOTHING_TO_CHANGE = 'This update changes nothing.';
const MEMBER_CANNOT = 'Only the list owner can make this change.';
const MARKER_WITHOUT_WORK =
  'A list migration marker names no work record; the migration cannot be resumed.';

/**
 * Chunks one request drains before handing the client a `503` and continuing next time.
 *
 * Eight chunks is 320 items, so a list at the 500-item cap migrates in two requests, and one
 * request cannot spend its whole Lambda budget here. The same bound rank repair uses.
 */
const MAX_DRAIN_CHUNKS = 8;

/**
 * The `409` a stale `If-Match` produces, carrying the current `updatedAt` in `details[]` —
 * the encoding `PATCH /v1/activities/:id` established (P1-13) and the same one the data-loss
 * preview below uses, because the envelope has exactly one structured slot.
 */
function staleEdit(currentUpdatedAt: string): AppError {
  return new AppError('conflict', STALE, [
    { path: 'updatedAt', message: currentUpdatedAt },
  ]);
}

/**
 * The retryable answer when this request's bounded drain left work outstanding.
 *
 * The **same** typed failure a fenced read raises, deliberately: `api-contract.md` §2.7 gives
 * one answer for a list whose work marker is still standing — `503 internal` with
 * `Retry-After: 1` — and the error handler already maps this class to exactly that. A
 * hand-rolled `AppError('internal', …)` would carry the retry hint on a `500`, which tells a
 * client the request cannot succeed while asking it to try again.
 */
function fenced(): Error {
  return new ListReadFenceError();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

/**
 * The migration's stable identity: this caller's `Idempotency-Key`, hashed.
 *
 * §P3-09 makes the migration "identified by that key", and it has to be: the receipt is
 * written by the **final** transaction, so a replay that arrives while the migration is still
 * running finds no receipt and reaches the handler again. Deriving the operation id from the
 * key is what lets that replay recognise its own work and resume it instead of installing a
 * second marker. Hashed with the user id rather than used raw, so two members of one list who
 * happened to mint the same UUID cannot address each other's operation.
 */
function behaviourOperationId(userId: string, idempotencyKey: string): string {
  return `bmg_${sha256(`${userId}:${idempotencyKey}`).slice(0, 32)}`;
}

async function requireList(
  userId: string,
  listId: string,
  access: ListAccessGrant,
): Promise<List> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
  return list;
}

// ── The item shape each behaviour requires ──────────────────────────────────────────────

/**
 * The `details` every item on a list of this behaviour carries, at its defaults.
 *
 * One function, applied in **every** direction, which is what keeps
 * `details.behaviour === List.behaviour` true of every item at every committed generation.
 * §P3-09 describes the three cases separately — `collection → watch` initialises
 * `watchStatus: 'want'`, `collection → meals` an empty ingredient list, a downgrade drops
 * `details` — and they are the same rule read three times: write the target behaviour's
 * default, and `collection`'s default is no `details` at all.
 *
 * Reading it as three cases instead would leave `watch → meals` the odd one out, with items
 * carrying no `details` on a list whose other items (added afterwards) would.
 */
function defaultDetailsFor(behaviour: ListBehaviour): ListItemDetails | undefined {
  if (behaviour === 'watch') return { behaviour: 'watch', watchStatus: 'want' };
  if (behaviour === 'meals') return { behaviour: 'meals', ingredients: [] };
  return undefined;
}

// ── The destructive-change preview ──────────────────────────────────────────────────────

/**
 * The user-facing name of every typed field a behaviour stores, in the order a confirmation
 * should read them (`interaction-contract.md` §1a.1 rule 4, `plans-and-lists.md` §5.7).
 *
 * Named the way the user sees them — `Season`, never `details.season`. The server sends the
 * labels and the client composes the sentence around its own list title, because the copy
 * belongs to the surface that knows what the list is called.
 */
const WATCH_FIELD_LABELS = [
  ['watchStatus', 'Watch status'],
  ['mediaKind', 'Movie or show'],
  ['season', 'Season'],
  ['episode', 'Episode'],
] as const;

const INGREDIENTS_LABEL = 'Ingredients';

interface DataLossPreview {
  readonly fields: readonly string[];
  /** Items **actually carrying** the data, never the list's size (§1a.1 rule 2). */
  readonly itemCount: number;
}

/**
 * What leaving `behaviour` would destroy, counted over the items that really hold it.
 *
 * A 20-item watchlist where 7 rows have progress says 7, and a field nothing carries is not
 * named: a confirmation listing `Season` for a list where nobody set one asks the user to
 * agree to a loss that would not happen.
 */
function previewDataLoss(
  behaviour: ListBehaviour,
  items: readonly ListItem[],
): DataLossPreview {
  const fields = new Set<string>();
  let itemCount = 0;

  for (const item of items) {
    const details = item.details;
    if (details === undefined || details.behaviour !== behaviour) continue;

    if (details.behaviour === 'watch') {
      itemCount += 1;
      for (const [key, label] of WATCH_FIELD_LABELS) {
        if (details[key] !== undefined) fields.add(label);
      }
      continue;
    }
    // `meals`: an empty ingredient list is a shape, not data. Dropping it loses nothing, so
    // it neither names a field nor counts an item.
    if ((details.ingredients?.length ?? 0) > 0) {
      itemCount += 1;
      fields.add(INGREDIENTS_LABEL);
    }
  }

  const ordered = [...WATCH_FIELD_LABELS.map(([, label]) => label), INGREDIENTS_LABEL];
  return { fields: ordered.filter((label) => fields.has(label)), itemCount };
}

const CONFIRM_REQUIRED =
  'Changing this list would remove information its items are carrying.';

/**
 * The `409` an unconfirmed destructive change answers with, before anything is written.
 *
 * The preview travels in `details[]` at the paths `DATA_LOSS_DETAIL_PATHS` exports, so the
 * service that emits it and the client that maps it back (P3-24) share one definition rather
 * than two descriptions of the same encoding.
 */
function confirmationRequired(preview: DataLossPreview): AppError {
  return new AppError('conflict', CONFIRM_REQUIRED, [
    { path: DATA_LOSS_DETAIL_PATHS.itemCount, message: String(preview.itemCount) },
    ...preview.fields.map((label, index) => ({
      path: DATA_LOSS_DETAIL_PATHS.field(index),
      message: label,
    })),
  ]);
}

// ── Draining somebody's standing work ───────────────────────────────────────────────────

type FinishOutcome = 'committed' | 'already-finished';

/**
 * The Undo record the final transaction stores, derived rather than kept twice.
 *
 * Everything it needs is already in the work record: the behaviour to restore, the exact
 * default the upgrade created, and — once the snapshot is filled — the items it created them
 * on. Deriving it here means **any** finisher writes the identical inverse, including a drain
 * provoked by a stranger's blocked read, so a crashed client cannot leave a completed upgrade
 * without the Undo it was promised.
 *
 * A confirmed downgrade has no `undo` on its work record and gets none: its only path back is
 * a fresh confirmed call (`interaction-contract.md` §4.1).
 */
function undoFor(work: BehaviourMigrationWork): ListSettingsUndo | undefined {
  if (work.undo === undefined) return undefined;
  const inverse: ListSettingsInverse = {
    behaviour: work.fromBehaviour,
    ...(work.toDetails === undefined ? {} : { createdDetails: work.toDetails }),
    affectedItemIds: work.entries.map((entry) => entry.itemId),
  };
  const preconditions: ListSettingsPreconditions = {
    behaviour: work.toBehaviour,
    ...(work.toDetails === undefined ? {} : { itemDetails: work.toDetails }),
  };
  return {
    operationId: work.operationId,
    kind: 'behaviour_upgrade',
    tokenHash: sha256(work.undo.token),
    undoExpiresAt: work.undo.expiresAt,
    inverse,
    preconditions,
  };
}

/**
 * Commits the final transaction, tolerating a concurrent drain that got there first.
 *
 * The condition names this operation id, so a second finisher fails it — and that failure
 * means the migration is **done**, not that anything went wrong. An idempotency race is a
 * different thing entirely and is rethrown for the middleware to recover.
 */
async function finishOnce(
  work: BehaviourMigrationWork,
  receipt?: IdempotencyReceipt,
): Promise<FinishOutcome> {
  const undo = undoFor(work);
  try {
    await finishBehaviourMigration(work, {
      ...(undo === undefined ? {} : { undo }),
      ...(receipt === undefined ? {} : { idempotencyReceipt: receipt }),
    });
    return 'committed';
  } catch (error) {
    if (error instanceof IdempotencyRaceError) throw error;
    const current = await getBehaviourMigrationWork(work.listId, work.operationId);
    if (current === undefined) return 'already-finished';
    throw error;
  }
}

/**
 * Finishes the snapshot if it is still outstanding, runs bounded chunks, then commits.
 *
 * `undefined` means work remains and the caller must answer the retryable `503`. The stored
 * cursor is re-read every pass for the reason rank repair records: two requests can drain one
 * operation — a replay and a blocked read — and applying a slice from a stale cursor would
 * rewrite entries the other has already done.
 */
async function drainFrom(
  seed: BehaviourMigrationWork,
  now: string,
  receipt?: IdempotencyReceipt,
): Promise<FinishOutcome | undefined> {
  const { listId, operationId } = seed;

  for (let chunk = 0; chunk < MAX_DRAIN_CHUNKS; chunk += 1) {
    const stored = await getBehaviourMigrationWork(listId, operationId);
    if (stored === undefined) return 'already-finished';

    // Still `snapshotting` means the installer never filled it — a crash, or a lost race.
    // Finishing it here is what stops a marker with no entries gating the list permanently.
    let current: BehaviourMigrationWork;
    try {
      current = await snapshotBehaviourMigration(stored, now);
    } catch (error) {
      if (error instanceof BehaviourMigrationContendedError) continue;
      throw error;
    }

    if (current.cursor >= current.entries.length) return finishOnce(current, receipt);

    try {
      await applyBehaviourMigrationChunk(current);
    } catch (error) {
      if (error instanceof BehaviourMigrationContendedError) continue;
      throw error;
    }
  }

  const remaining = await getBehaviourMigrationWork(listId, operationId);
  if (remaining === undefined) return 'already-finished';
  if (remaining.cursor < remaining.entries.length) return undefined;
  return finishOnce(remaining, receipt);
}

/**
 * Advances an **already-installed** behaviour migration, and reports whether the list is
 * clear.
 *
 * `false` means work remains and the caller must answer the retryable `503`. It is `true`
 * when no marker stands at all, so a fence failure caused by something else — a racing
 * reorder changing `rankVersion` between a page's two META reads — falls straight through to
 * that same `503` without pretending to have migrated anything.
 */
export async function drainBehaviourMigration(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  now: string,
): Promise<boolean> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) return true;
  const operationId = list.behaviourMigrationId;
  if (operationId === undefined) return true;

  const work = await getBehaviourMigrationWork(listId, operationId);
  if (work === undefined) {
    /**
     * The marker and its work row are installed in one transaction and cleared in another,
     * so at every committed boundary they agree — including mid-snapshot, which is what the
     * `snapshotting` state is for. A missing record therefore means either that a concurrent
     * drain finished and cleared both between the two reads above, or that the record was
     * removed out of band. Re-reading META separates them.
     */
    const after = await getListMeta(userId, listId, access);
    if (after?.behaviourMigrationId === undefined) return true;
    throw new AppError('internal', 'An unexpected error occurred.', [
      { path: 'behaviourMigrationId', message: MARKER_WITHOUT_WORK },
    ]);
  }
  return (await drainFrom(work, now)) !== undefined;
}

/**
 * Drains whichever bounded work marker stands on this list, and reports whether it is clear.
 *
 * The two markers are mutually exclusive — each installs itself only when both are absent —
 * so this is a choice, not a loop. It exists because "attempt a bounded drain, otherwise
 * `503`" is the contract for **every** public item read and mutation
 * (`api-contract.md` §2.7), and a caller blocked by a gate has no business knowing which kind
 * of work put it there.
 */
export async function drainListWork(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  now: string,
): Promise<boolean> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) return true;
  if (list.rankRepairId !== undefined) {
    return drainRankRepair(userId, listId, access, now);
  }
  if (list.behaviourMigrationId !== undefined) {
    return drainBehaviourMigration(userId, listId, access, now);
  }
  return true;
}

/**
 * Runs a fenced read, draining a standing repair or migration once before giving up.
 *
 * Pattern 8's fence throws for two different reasons and this handles both: a work marker,
 * which a drain may clear, and a `rankVersion` that moved between the two META reads, which
 * it cannot. In the second case the drain reports "clear" immediately, the retried read fails
 * the same way, and the caller gets the `503` telling the client to restart at page one.
 */
export async function withListWorkDrain<T>(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  read: () => Promise<T>,
  now: string = new Date().toISOString(),
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof ListReadFenceError)) throw error;
    const cleared = await drainListWork(userId, listId, access, now);
    if (!cleared) throw error;
    return read();
  }
}

// ── PATCH /v1/lists/:id ─────────────────────────────────────────────────────────────────

/**
 * Who may change what.
 *
 * A member may rename a shared list — it changes nothing but the title — and may not touch
 * behaviour, capabilities, slot or archive: those are changes to the object rather than to
 * one person's view of it (`api-contract.md` §3, `plans-and-lists.md` §5.6). `403` rather
 * than `404`, because a member can already see the list and is being told what they may not
 * do with it.
 */
function assertMayPatch(access: ListAccess, input: PatchListInput): void {
  if (access.isOwner) return;
  const restricted = (['capabilities', 'slot', 'archived'] as const).filter(
    (field) => field in input,
  );
  if (restricted.length === 0) return;
  throw new AppError(
    'forbidden',
    MEMBER_CANNOT,
    restricted.map((field) => ({ path: field, message: MEMBER_CANNOT })),
  );
}

function sameCapabilities(a: ListCapabilities, b: ListCapabilities): boolean {
  return a.checkable === b.checkable && a.supportsLocation === b.supportsLocation;
}

interface SettingsChange {
  readonly capabilities?: ListCapabilities;
  readonly slot?: List['slot'];
  readonly archived?: boolean;
}

/**
 * `PATCH /v1/lists/:id` — title, capabilities, slot and archive, under `If-Match`.
 *
 * One conditional `META` write. Everything here is additive in both directions, so it applies
 * immediately with no confirmation (`interaction-contract.md` §1a.1): turning `checkable` off
 * **retains** every `checked` value and turning `supportsLocation` off retains every stored
 * location, which is exactly why neither is a destructive change and why the row renderer,
 * not the data, is what stops hiding them.
 *
 * The Undo inverse covers only the fields that **actually moved**. A rename is deliberately
 * not among them: `interaction-contract.md` §4.1 has no undo row for renaming a list, and a
 * token that silently reverted a title alongside a capability would take back something the
 * user was never offered the chance to keep.
 */
export async function patchListSettings(
  userId: string,
  listId: string,
  input: PatchListInput,
  ifMatch: string,
  now: string,
): Promise<ListSettingsResult> {
  const access = await assertListAccess(userId, listId, 'write');
  assertMayPatch(access, input);
  if (Object.keys(input).length === 0) {
    throw new AppError('validation_failed', NOTHING_TO_CHANGE, [
      { path: 'title', message: NOTHING_TO_CHANGE },
    ]);
  }

  const list = await requireList(userId, listId, access.index);
  if (list.updatedAt !== ifMatch) throw staleEdit(list.updatedAt);

  /**
   * The patch is a **partial** pair, merged onto the stored one field by field rather than
   * by spreading: a flag the client omitted must keep its stored value, and a spread of an
   * optional-keyed object cannot express that to the type system.
   */
  const capabilities =
    input.capabilities === undefined
      ? undefined
      : {
          checkable: input.capabilities.checkable ?? list.capabilities.checkable,
          supportsLocation:
            input.capabilities.supportsLocation ?? list.capabilities.supportsLocation,
        };
  const changed: SettingsChange = {
    ...(capabilities !== undefined && !sameCapabilities(capabilities, list.capabilities)
      ? { capabilities }
      : {}),
    ...('slot' in input && input.slot !== undefined && input.slot !== list.slot
      ? { slot: input.slot }
      : {}),
    ...(input.archived !== undefined && input.archived !== list.archived
      ? { archived: input.archived }
      : {}),
  };

  /**
   * Changing or clearing a slot removes `defaultLists[oldSlot]` in the **same transaction**,
   * conditioned on that slot still naming this list (`api-contract.md` §2.7, P3-12). The
   * caller supplies it whenever the list held a slot; no profile pre-read decides it, because
   * a read that missed a concurrent selection would wrongly skip the cleanup, and a slot that
   * now names a newer destination fails only that item and survives.
   */
  const clearsDefault = 'slot' in changed && list.slot !== null;

  const undoToken = randomBytes(32).toString('base64url');
  const undoExpiresAt = new Date(
    Date.parse(now) + UNDO_OFFER_SECONDS * 1000,
  ).toISOString();
  /**
   * A server-minted id, unlike the behaviour migration's. Nothing about this write is
   * resumable across requests, so there is nothing for a replay to recognise: the `If-Match`
   * already makes a retry either land the same values or be told the version moved.
   */
  const operationId = newListOperationId();
  const reversible = Object.keys(changed).length > 0;

  const undoFrom = (removedDefault?: RemovedListDefault): ListSettingsUndo => ({
    operationId,
    kind: 'settings',
    tokenHash: sha256(undoToken),
    undoExpiresAt,
    inverse: {
      ...(changed.capabilities === undefined ? {} : { capabilities: list.capabilities }),
      ...('slot' in changed ? { slot: list.slot } : {}),
      ...(changed.archived === undefined ? {} : { archived: list.archived }),
      ...(removedDefault === undefined ? {} : { removedDefault }),
    },
    preconditions: {
      ...(changed.capabilities === undefined
        ? {}
        : { capabilities: changed.capabilities }),
      ...('slot' in changed ? { slot: changed.slot ?? null } : {}),
      ...(changed.archived === undefined ? {} : { archived: changed.archived }),
      ...(removedDefault === undefined ? {} : { defaultSlotAbsent: removedDefault.slot }),
    },
  });

  await write(
    userId,
    listId,
    access.index,
    {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...changed,
    },
    list.updatedAt,
    now,
    {
      ...(clearsDefault && list.slot !== null
        ? { clearProfileDefault: { slot: list.slot } }
        : {}),
      ...(reversible ? { undoFor: undoFrom } : {}),
    },
  );

  /**
   * The post-image, composed rather than re-read. The write was conditional on the exact
   * version it replaced, so the committed row is this one; asking storage for it again would
   * cost two more strong reads to be told what the condition already guaranteed.
   */
  return {
    list: {
      ...list,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...changed,
      updatedAt: now,
    },
    ...(reversible ? { undoToken, undoExpiresAt } : {}),
  };
}

/**
 * The conditional write, with the two failures it can produce told apart.
 *
 * The `META` condition covers both the `If-Match` and the absence of a work marker, so a
 * bare `409` would report "somebody edited this" for a list that is merely mid-migration. The
 * re-read decides: a marker means the retryable `503`, and anything else is a genuine stale
 * edit answered with the current version.
 */
async function write(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  patch: Parameters<typeof patchListMeta>[3],
  expectedUpdatedAt: string,
  now: string,
  options: Parameters<typeof patchListMeta>[6],
): Promise<void> {
  try {
    await patchListMeta(userId, listId, access, patch, expectedUpdatedAt, now, options);
    return;
  } catch (error) {
    if (error instanceof ListNotFoundError) {
      throw new AppError('not_found', LIST_NOT_FOUND);
    }
    if (!(error instanceof AppError) || error.code !== 'conflict') throw error;
    const fresh = await getListMeta(userId, listId, access);
    if (fresh === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
    if (fresh.rankRepairId !== undefined || fresh.behaviourMigrationId !== undefined) {
      const cleared = await drainListWork(userId, listId, access, now);
      throw cleared ? staleEdit(fresh.updatedAt) : fenced();
    }
    throw staleEdit(fresh.updatedAt);
  }
}

// ── POST /v1/lists/:id/behaviour ────────────────────────────────────────────────────────

/**
 * The row a migration will write, as the final transaction will write it.
 *
 * Built rather than re-read because the response has to exist **before** the transaction that
 * commits it: its JSON is the idempotency receipt's body, and the receipt is one of that
 * transaction's items. Nothing may change `META` while the marker stands, so every field but
 * the three this operation sets is already the row's final value.
 */
function migratedList(list: List, work: BehaviourMigrationWork): List {
  const visible: List = {
    ...list,
    behaviour: work.toBehaviour,
    rankVersion: work.rankVersion + 1,
    updatedAt: work.committedAt,
  };
  delete visible.behaviourMigrationId;
  delete visible.rankRepairId;
  return visible;
}

function responseFor(list: List, work: BehaviourMigrationWork): ListSettingsResult {
  return {
    list: migratedList(list, work),
    ...(work.undo === undefined
      ? {}
      : { undoToken: work.undo.token, undoExpiresAt: work.undo.expiresAt }),
  };
}

/**
 * A `watch` or `meals` list is leaving a shape that stores data; a `collection` is not.
 *
 * `watch → meals` is destructive in exactly the way `watch → collection` is: it is not a
 * sideways move, because nothing carries season, episode and status across it (§P3-09).
 */
function isDestructive(from: ListBehaviour, to: ListBehaviour): boolean {
  return from !== to && from !== 'collection';
}

/**
 * Drives an installed migration to completion and answers with the operation's own response.
 *
 * `already-finished` means a concurrent drain — a replay of this key, or a stranger's blocked
 * read — committed the identical domain state without this request's receipt, so the receipt
 * is written on its own here. It carries the same body either way: `committedAt` and the Undo
 * token were fixed when the operation was accepted, precisely so that no two finishers can
 * disagree about what it did.
 */
async function driveMigration(
  list: List,
  work: BehaviourMigrationWork,
  now: string,
  receiptFor: (result: ListSettingsResult) => IdempotencyReceipt,
): Promise<ListSettingsResult> {
  const response = responseFor(list, work);
  const outcome = await drainFrom(work, now, receiptFor(response));
  if (outcome === undefined) throw fenced();
  if (outcome === 'already-finished') await writeReceiptOnly(receiptFor(response));
  return response;
}

/**
 * `POST /v1/lists/:id/behaviour` — the three-step migration, in both directions.
 *
 * ## What each step is for
 *
 * 1. One transaction checks `If-Match`, requires both work gates absent, installs
 *    `BEHAVIOUR_MIGRATION#<operationId>` in `snapshotting` state and points `META` at it. It
 *    leaves the behaviour, the timestamp and every item untouched: flipping the behaviour
 *    first would advertise a shape the items do not have yet, and a crash would leave it that
 *    way.
 * 2. The worker snapshots the at-most-500 stable ids, ranks and revisions under the gate —
 *    which is what makes the snapshot stable — and rewrites bounded chunks, advancing each
 *    row and locator's matching revision. While the marker stands, every public item read and
 *    mutation drains what it can and otherwise answers the retryable `503`.
 * 3. One final transaction condition-checks the work record, flips the behaviour, clears the
 *    marker, advances `rankVersion` so pre-migration item cursors are rejected rather than
 *    resumed through rewritten rows, records the Undo inverse and the receipt, and deletes
 *    the work row.
 *
 * A crash in any phase resumes from the stored cursor. A replay of the same key resolves to
 * the same operation id, so it drains its own work rather than starting a second migration.
 *
 * ## Where the confirmation sits
 *
 * A destructive transition is refused **before** step 1, so an unconfirmed call leaves no
 * receipt, no marker and no work record — nothing at all (§P3-09). The confirmed action is a
 * new logical action under a newly minted key, which is why `confirmDataLoss` is a query
 * parameter rather than a body field: the two calls are not the same request sent twice.
 */
export async function changeListBehaviour(
  userId: string,
  listId: string,
  input: ChangeListBehaviourInput,
  ifMatch: string,
  confirmDataLoss: boolean,
  idempotencyKey: string,
  now: string,
  receiptFor: (result: ListSettingsResult) => IdempotencyReceipt,
): Promise<ListSettingsResult> {
  const access = await assertListAccess(userId, listId, 'owner');
  const operationId = behaviourOperationId(userId, idempotencyKey);

  let list = await requireList(userId, listId, access.index);
  if (list.updatedAt !== ifMatch) throw staleEdit(list.updatedAt);

  // This key's own migration is already installed: resume it, never start a second.
  if (list.behaviourMigrationId === operationId) {
    const resumed = await getBehaviourMigrationWork(listId, operationId);
    if (resumed !== undefined) {
      return driveMigration(list, resumed, now, receiptFor);
    }
  }

  if (list.rankRepairId !== undefined || list.behaviourMigrationId !== undefined) {
    if (!(await drainListWork(userId, listId, access.index, now))) throw fenced();
    list = await requireList(userId, listId, access.index);
    // A migration that finished under us moved `updatedAt`; the client's version is stale.
    if (list.updatedAt !== ifMatch) throw staleEdit(list.updatedAt);
  }

  /**
   * Already there. Either a genuine no-op or a replay that arrives after somebody else's
   * drain committed this operation, and both answer with current truth. The Undo offer is
   * absent by construction: its token lived in the work record the finisher deleted, and a
   * server that minted a fresh one would be handing out a compensation nothing recorded.
   */
  if (list.behaviour === input.behaviour) {
    const settled: ListSettingsResult = { list };
    await writeReceiptOnly(receiptFor(settled));
    return settled;
  }

  const destructive = isDestructive(list.behaviour, input.behaviour);
  if (destructive && !confirmDataLoss) {
    const preview = previewDataLoss(
      list.behaviour,
      await readAllListItems(userId, listId, access.index),
    );
    /**
     * **Nothing to lose, nothing to confirm.** §1a.1 rule 3 makes a behaviour change
     * destructive only *conditionally*, and calls a confirmation that can appear with a count
     * of zero a bug — so an empty watchlist, or a meals list nobody has put an ingredient on,
     * changes immediately like any additive settings change. `api-contract.md` §2.7 states
     * the row unconditionally; the product doc outranks it on behaviour and this follows it.
     */
    if (preview.itemCount > 0) throw confirmationRequired(preview);
  }

  const toDetails = defaultDetailsFor(input.behaviour);
  /**
   * Only an upgrade carries an Undo offer. A downgrade is confirmed rather than undone
   * (`interaction-contract.md` §4.1), and there is nothing honest to restore: the data it
   * removed is gone, so a token would promise a compensation the server cannot perform.
   */
  const undo = destructive
    ? undefined
    : {
        token: randomBytes(32).toString('base64url'),
        expiresAt: new Date(Date.parse(now) + UNDO_OFFER_SECONDS * 1000).toISOString(),
      };

  let work: BehaviourMigrationWork;
  try {
    work = await beginBehaviourMigration(userId, listId, access.index, {
      operationId,
      toBehaviour: input.behaviour,
      ...(toDetails === undefined ? {} : { toDetails }),
      expectedUpdatedAt: ifMatch,
      now,
      ...(undo === undefined ? {} : { undo }),
    });
  } catch (error) {
    /**
     * Somebody installed a marker between the read above and this write. The loser sees that
     * two ways depending on how far it got — the fence assertion on its own META read, or the
     * conditional install losing — and both mean the same thing: this request has not started
     * anything, and the client should retry once the list is clear.
     */
    const contended =
      error instanceof BehaviourMigrationAlreadyStartedError ||
      error instanceof ListReadFenceError;
    if (!contended) throw error;
    await drainListWork(userId, listId, access.index, now);
    throw fenced();
  }

  return driveMigration(list, work, now, receiptFor);
}
