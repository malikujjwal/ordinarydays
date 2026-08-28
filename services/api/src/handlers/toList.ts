import type { List, ListItem, ListItemActivityLink } from '@od/shared/types';

/**
 * The List an API response carries — built **field by field, never by spreading**, for
 * `toUser`'s reason: a stored row carries storage attributes, and a projection that leaks
 * by default is corrected by remembering (`agent-playbook.md` §6.11).
 *
 * `itemVersion`, `rankRepairId` and `behaviourMigrationId` are deliberately absent: they are
 * storage-level concurrency state and never serialised (`data-model.md` §4.6).
 * `rankVersion` stays — item-page cursors are bound to it.
 */
export function toList(list: List): Record<string, unknown> {
  return {
    listId: list.listId,
    ownerId: list.ownerId,
    behaviour: list.behaviour,
    templateKey: list.templateKey,
    title: list.title,
    icon: list.icon,
    emptyStateCopy: list.emptyStateCopy,
    capabilities: {
      checkable: list.capabilities.checkable,
      supportsLocation: list.capabilities.supportsLocation,
    },
    slot: list.slot,
    ...(list.sourceActivityId === undefined
      ? {}
      : { sourceActivityId: list.sourceActivityId }),
    itemCount: list.itemCount,
    uncheckedCount: list.uncheckedCount,
    memberCount: list.memberCount,
    rankVersion: list.rankVersion,
    archived: list.archived,
    updatedAt: list.updatedAt,
    /**
     * Serialised, and it must be: the Lists index renders this rather than `updatedAt`
     * (`design-system.md` §7.2, P3-47). It is a display value with no precondition attached —
     * the opposite of `itemVersion` above it, which is concurrency state and stays behind.
     */
    lastItemActivityAt: list.lastItemActivityAt,
  };
}

/**
 * What a settings mutation answers with (`api-contract.md` §2.7, P3-09).
 *
 * The Undo pair travels **together or not at all** — one conditional spread, not two. A token
 * without the deadline it is offered until is an offer no client can time, and the shared
 * schema is a union of exactly these two shapes for that reason.
 */
export function toListSettings(result: {
  list: List;
  undo?: { token: string; expiresAt: string };
}): Record<string, unknown> {
  return {
    list: toList(result.list),
    ...(result.undo === undefined
      ? {}
      : { undoToken: result.undo.token, undoExpiresAt: result.undo.expiresAt }),
  };
}

/**
 * The ListItem a response carries. Storage-only `itemRevision` and `sourceProvenance` are
 * deliberately absent; `rank` stays, opaque, because the shared `(rank, itemId)` comparator
 * is also the client's sort order. The client needs the rendered `sourceLabel`, never its
 * ownership ledger.
 */
export function toListItem(item: ListItem): Record<string, unknown> {
  return {
    itemId: item.itemId,
    listId: item.listId,
    rank: item.rank,
    title: item.title,
    ...(item.note === undefined ? {} : { note: item.note }),
    checked: item.checked,
    ...(item.location === undefined ? {} : { location: item.location }),
    ...(item.sourceActivityId === undefined
      ? {}
      : { sourceActivityId: item.sourceActivityId }),
    ...(item.sourceLabel === undefined ? {} : { sourceLabel: item.sourceLabel }),
    ...(item.details === undefined ? {} : { details: item.details }),
  };
}

/** The caller's own link. The projection layer above guarantees it is never anyone else's. */
export function toListItemLink(link: ListItemActivityLink): Record<string, unknown> {
  return {
    listId: link.listId,
    itemId: link.itemId,
    viewerUserId: link.viewerUserId,
    activityId: link.activityId,
    linkedAt: link.linkedAt,
  };
}
