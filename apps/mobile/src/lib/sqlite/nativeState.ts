import type { AccountDatabase } from '@/lib/sqlite/accountDatabase';
import type { NativeActivityActionCoordinator } from '@/lib/sqlite/actionCoordinator';
import type { ActivityRepository } from '@/lib/sqlite/activityRepository';
import type { AgendaRepository } from '@/lib/sqlite/agendaRepository';
import type { OutboxRepository } from '@/lib/sqlite/outbox';
import type { NativeSyncEngine } from '@/lib/sqlite/syncEngine';

export interface NativeActivityState {
  readonly account: AccountDatabase;
  readonly activities: ActivityRepository;
  readonly agenda: AgendaRepository;
  readonly outbox: OutboxRepository;
  readonly coordinator: NativeActivityActionCoordinator;
  readonly sync: NativeSyncEngine;
}

export interface NativeStateSession {
  readonly stop: () => void;
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
