/**
 * Lazy schema migration (`data-model.md` §9).
 *
 * **Every item carries `schemaVersion`.** The repository upgrades an item in memory on read
 * and writes the upgraded shape on the next write. There is no migration job for the common
 * case, no downtime, and no moment where half the table is one shape and half another with
 * code that only understands one of them.
 *
 * The registry below is the whole mechanism. Version 1 is the identity function, so today it
 * does nothing at all — which is the point: it exists so that version 2 is a one-file change
 * made by somebody who does not also have to design the upgrade path under pressure. Batch
 * backfills, when a lazy upgrade is not enough, are one-off reviewed scripts under
 * `infra/scripts/migrations/` and are the only place a `Scan` is permitted.
 */

/** The version every item written today carries. */
export const CURRENT_SCHEMA_VERSION = 1;

/** A stored item, before it is known to match any particular entity's shape. */
export type StoredItem = Record<string, unknown> & { schemaVersion?: number };

/**
 * Upgrades an item **one** version, from `n` to `n + 1`.
 *
 * One step per function rather than one function per source version: an item at v1 in a
 * codebase at v4 runs 1→2, 2→3, 3→4 in sequence, so adding v5 means writing one function
 * and never revisiting the others. The alternative — a function per (from, to) pair — grows
 * quadratically and each new pair is a chance to reimplement an old step slightly differently.
 */
export type Upgrade = (item: StoredItem) => StoredItem;

/**
 * `version n → n + 1`. Keyed by the version being upgraded **from**.
 *
 * When adding a version: append the step here, bump {@link CURRENT_SCHEMA_VERSION}, and
 * write the test that takes a realistic v(n) item through it. Do not edit an existing step —
 * stored data has already been through it, and changing it means two items that claim the
 * same version have different shapes.
 */
export type UpgradeRegistry = ReadonlyMap<number, Upgrade>;

const UPGRADES: UpgradeRegistry = new Map<number, Upgrade>([
  // 1 → 2 goes here. Nothing yet: version 1 is what the product writes today.
]);

/**
 * Applies each registered step in turn until `item` reaches `target`.
 *
 * **Takes its registry and target as arguments**, which is what makes the machinery
 * testable while the product is still at version 1: a test supplies a synthetic 1 → 2 step
 * and asserts the loop, rather than the loop staying unexercised until the day it first
 * matters — which is exactly the day nobody wants to discover it was wrong. No global
 * mutation, so no test can leak a step into another.
 *
 * Returns the item unchanged — the same object, not a copy — when it is already at `target`.
 * That is every read in the product today, and the agenda query runs this over every row it
 * returns; cloning each one to achieve nothing would be a cost with no benefit.
 *
 * An item with **no** `schemaVersion` is treated as version 1. Only pre-Phase-1 scratch data
 * can be in that state, and defaulting is kinder than throwing on a laptop.
 */
export function upgradeItem<T extends StoredItem>(
  item: T,
  target: number,
  upgrades: UpgradeRegistry,
): T {
  const from = item.schemaVersion ?? 1;

  if (from === target) return item;

  /**
   * An item from the future — written by a newer deploy and read by an older one during a
   * rolling deployment. Downgrading is not possible and guessing is worse than failing, so
   * it is returned untouched and the caller's schema validation decides, rather than this
   * layer silently dropping fields it does not recognise.
   */
  if (from > target) return item;

  let current: StoredItem = item;
  for (let version = from; version < target; version += 1) {
    const upgrade = upgrades.get(version);
    if (upgrade === undefined) {
      throw new Error(
        `No upgrade registered for schemaVersion ${version} → ${version + 1}. ` +
          `The target is ${target}; every step between must exist.`,
      );
    }
    current = { ...upgrade(current), schemaVersion: version + 1 };
  }

  return current as T;
}

/** Brings a stored item up to {@link CURRENT_SCHEMA_VERSION}. What repositories call. */
export function upgradeOnRead<T extends StoredItem>(item: T): T {
  return upgradeItem(item, CURRENT_SCHEMA_VERSION, UPGRADES);
}

/** Applies {@link upgradeOnRead} across a query result. */
export function upgradeAll<T extends StoredItem>(items: readonly T[]): T[] {
  return items.map((item) => upgradeOnRead(item));
}
