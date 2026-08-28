import { MAX_OWNED_LISTS } from '@od/shared';
import { LIST_TEMPLATES } from '@od/shared/lists';
import { type CreateListInput, instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import {
  countOwnedLists,
  createList,
  ListIdUnavailableError,
  newListId,
} from '../repositories/listRepository.js';
import { ID_UNAVAILABLE } from './activityService.js';
import { assertActivityAccess } from './authz.js';

/**
 * `POST /v1/lists` — template resolution at creation (`phase-03` §P3-05, ADR-032).
 *
 * One function, **no branch per template**: the selected catalogue entry is looked up by its
 * exact key and its structural and presentation fields are copied — as values, never a
 * reference — onto the new row. The stored List is then the whole truth about what it can
 * do; no read path ever consults the catalogue again, which is what lets a shipped catalogue
 * change leave every existing list untouched (acceptance criterion 3).
 *
 * This file is one of the three modules the `list-templates-are-creation-data` rules allow
 * to name `LIST_TEMPLATES`. Do not export the catalogue onward from here.
 */

const UNKNOWN_TEMPLATE = 'That list style isn’t available.';
const NOT_A_PLAN = 'A list can only be created from a plan.';

/**
 * Resolves the selected template and creates the list, its owner pointer, the optional
 * `SOURCE_LIST#` projection and the idempotency receipt in one transaction.
 *
 * The four steps of §P3-05, in order:
 *
 * 1. The visible `title` is required (the strict schema enforces it) and `templateKey` must
 *    name a **current** catalogue entry. A missing or unknown key is `validation_failed`;
 *    the server never substitutes `simple-list` — guessing on the client's behalf produces
 *    a list that is not what the user picked.
 * 2. `behaviour`, `capabilities`, `slot`, `icon` and `emptyStateCopy` are **copied** onto
 *    the row. `templateKey` is stored as provenance and analytics only.
 * 3. A `sourceActivityId` must name an **owned Plan**, and forces the copied `slot` to
 *    `null` — a list made for one Plan must not silently become a standing destination
 *    (`plans-and-lists.md` §4.1). The same transaction writes the id-only reverse
 *    projection.
 * 4. The owned-list cap: at {@link MAX_OWNED_LISTS} owner pointers, creation is refused.
 *    Memberships received from other owners never consume this quota.
 *
 * `input.listId`, when supplied, is the client's permanent `lst_` ULID (ADR-055) — identity
 * only; ownership and timestamps are derived here. A collision with a live row or retained
 * tombstone answers with the same metadata-free `conflict` copy Activity creation uses.
 */
export async function createListFromTemplate(
  userId: string,
  input: CreateListInput,
  now: string,
  receiptFor?: (list: List) => IdempotencyReceipt,
): Promise<List> {
  const template = LIST_TEMPLATES.find(
    (entry) => entry.templateKey === input.templateKey,
  );
  if (template === undefined) {
    throw new AppError('validation_failed', UNKNOWN_TEMPLATE, [
      { path: 'templateKey', message: UNKNOWN_TEMPLATE },
    ]);
  }

  let slot = template.slot;
  if (input.sourceActivityId !== undefined) {
    const { activity } = await assertActivityAccess(
      userId,
      input.sourceActivityId,
      'owner',
    );
    if (activity.objectKind !== 'plan') {
      throw new AppError('validation_failed', NOT_A_PLAN, [
        { path: 'sourceActivityId', message: NOT_A_PLAN },
      ]);
    }
    slot = null;
  }

  if ((await countOwnedLists(userId)) >= MAX_OWNED_LISTS) {
    throw new AppError(
      'validation_failed',
      `You can have up to ${MAX_OWNED_LISTS} lists.`,
    );
  }

  const list: List = {
    schemaVersion: 2,
    listId: input.listId ?? newListId(),
    ownerId: userId,
    templateKey: template.templateKey,
    title: input.title,
    icon: template.icon,
    emptyStateCopy: template.emptyStateCopy,
    // Field by field, so the stored row holds values rather than a live reference into the
    // catalogue — the copy acceptance criterion 3 mutates the template to prove.
    itemStateMode: structuredClone(template.itemStateMode),
    featureConfig: structuredClone(template.featureConfig),
    slot,
    ...(input.sourceActivityId === undefined
      ? {}
      : { sourceActivityId: input.sourceActivityId }),
    itemCount: 0,
    doneCount: 0,
    memberCount: 1,
    rankVersion: 0,
    itemVersion: 0,
    archived: false,
    updatedAt: instant.parse(now),
    /**
     * Seeded equal to `createdAt` (P3-47). A brand-new list has had no item written to it, so
     * the honest answer to "when was this last used" is "when it was made" — and the Lists
     * index renders this field, so leaving it to the first item write would give a fresh card
     * nothing to say.
     */
    lastItemActivityAt: instant.parse(now),
  };

  try {
    await createList(userId, list, {
      now,
      ...(receiptFor === undefined ? {} : { idempotencyReceipt: receiptFor(list) }),
    });
  } catch (error) {
    if (error instanceof ListIdUnavailableError) {
      throw new AppError('conflict', ID_UNAVAILABLE);
    }
    throw error;
  }

  return list;
}
