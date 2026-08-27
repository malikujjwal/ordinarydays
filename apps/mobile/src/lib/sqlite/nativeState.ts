import type { NativeActivityActionCoordinator } from '@/lib/sqlite/actionCoordinator';
import type { ActivityRepository } from '@/lib/sqlite/activityRepository';
import type { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import type { AnytimeRepository } from '@/lib/sqlite/anytimeRepository';
import type { SqliteDatabase } from '@/lib/sqlite/database';
import type { ListItemsRepository } from '@/lib/sqlite/listItemsRepository';
import type { ListsRepository } from '@/lib/sqlite/listsRepository';
import type { OutboxRepository } from '@/lib/sqlite/outbox';
import type { OutboxPresentationStore } from '@/lib/sqlite/outboxPresentationStore';
import type { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import type { NativeSyncEngine } from '@/lib/sqlite/syncEngine';
import type { SerializedTransactionRunner } from '@/lib/sqlite/transaction';

export interface NativeAccountState {
  readonly accountNamespace: string;
  readonly filename: string;
  readonly database: SqliteDatabase;
  readonly subscriptions: RepositorySubscriptions;
  readonly transactions: SerializedTransactionRunner;
}

export interface NativeActivityState {
  readonly sessionId: string;
  readonly ownerUserId: string;
  readonly account: NativeAccountState;
  readonly activities: ActivityRepository;
  readonly agenda: AgendaRepository;
  readonly anytime?: AnytimeRepository;
  /** The SQLite-owned Lists index, including optimistic outbox projections. */
  readonly lists?: ListsRepository;
  /** The item slice behind list detail, scoped and subscribed per list (P3-27). */
  readonly listItems?: ListItemsRepository;
  readonly outbox: OutboxRepository;
  readonly outboxPresentation: OutboxPresentationStore;
  readonly coordinator: NativeActivityActionCoordinator;
  readonly sync: NativeSyncEngine;
}

export interface NativeStateSession {
  readonly sessionId: string;
  readonly queryPersistenceSafe: boolean;
  readonly stop: () => void;
  readonly closed: Promise<void>;
}

let active: NativeActivityState | undefined;

export function setActiveNativeState(state: NativeActivityState | undefined): void {
  active = state;
}

export function getActiveNativeState(): NativeActivityState | undefined {
  return active;
}

export function requireActiveNativeState(): NativeActivityState {
  if (active === undefined) throw new Error('Native SQLite state is not ready.');
  return active;
}
