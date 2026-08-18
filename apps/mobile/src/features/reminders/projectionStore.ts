import type { WallDate } from '@od/shared/time';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ArmingProfile } from './arming';
import type { ServerReminderSource } from './projection';

/**
 * The persisted half of the reminder projection (P2-57).
 *
 * `refreshLocalNotifications` used to call `getMe` and `getAgenda` on every recompute, which
 * meant a device with no connectivity could not work out what to arm — the exact situation
 * local notifications exist for. Storing the last good answer is what breaks that dependency:
 * the network fills this store when it can, and arming reads only the store.
 *
 * **Its own key, and disposable.** Unlike the intent log, everything here is reconstructable
 * from the server, so it may be discarded freely. It is a cache, and it is kept separate from
 * the query cache only because it must survive that cache's buster and outlive one session.
 */

const KEY = 'ordinarydays-reminder-projection-v1';

export interface StoredProjection {
  /** Reminder-relevant profile fields only — never the whole `User`. */
  profile: ArmingProfile;
  items: ServerReminderSource[];
  from: WallDate;
  to: WallDate;
  /** When the server last answered. Diagnostic; staleness never blocks arming. */
  updatedAt: string;
}

export interface ProjectionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function isStored(value: unknown): value is StoredProjection {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StoredProjection>;
  return (
    typeof candidate.profile === 'object' &&
    candidate.profile !== null &&
    Array.isArray(candidate.items) &&
    typeof candidate.from === 'string' &&
    typeof candidate.to === 'string'
  );
}

/**
 * The last stored projection, or `undefined`.
 *
 * A malformed or unreadable store returns `undefined` rather than throwing: arming still has
 * the intent log to work from, and a device with pending offline creates and a corrupt cache
 * should still fire those reminders.
 */
export async function loadProjection(
  storage: ProjectionStorage = AsyncStorage,
): Promise<StoredProjection | undefined> {
  try {
    const raw = await storage.getItem(KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isStored(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function saveProjection(
  projection: StoredProjection,
  storage: ProjectionStorage = AsyncStorage,
): Promise<void> {
  await storage.setItem(KEY, JSON.stringify(projection));
}

/** Sign-out disposal. The intent log is quarantined instead; this is only a cache. */
export async function clearProjection(
  storage: ProjectionStorage = AsyncStorage,
): Promise<void> {
  await storage.removeItem(KEY);
}
