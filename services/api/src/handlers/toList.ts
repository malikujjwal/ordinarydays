import type { List, ListItem, ListItemActivityLink } from '@od/shared/types';

/**
 * The List an API response carries — built **field by field, never by spreading**, for
 * `toUser`'s reason: a stored row carries storage attributes, and a projection that leaks
 * by default is corrected by remembering (`agent-playbook.md` §6.11).
 *
 * `rankRepairId` and `behaviourMigrationId` are deliberately absent: they are storage-level
 * work markers that gate reads and are never serialised (`data-model.md` §4.6).
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
  };
}

/**
 * The ListItem a response carries. `itemRevision` — the storage-only mutation fence — is
 * deliberately absent; `rank` stays, opaque, because the shared `(rank, itemId)` comparator
 * is also the client's sort order.
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
