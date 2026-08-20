import type { Intent } from '@/lib/intentLog';

export interface PendingCreateState {
  pending: boolean;
  canCancel: boolean;
  intentId: string | undefined;
  status: Intent['status'] | undefined;
}

export interface RecurrenceEditState {
  inert: boolean;
  message: string | undefined;
  status: 'idle' | 'queued' | 'updating' | 'retry' | 'failed';
}

export interface AgendaRowIntentState {
  pendingCreate: PendingCreateState;
  recurrenceEdit: RecurrenceEditState;
  mutationInert: boolean;
}

export function pendingCreateState(
  intents: readonly Intent[],
  entityId: string | undefined,
): PendingCreateState {
  const create = intents.find(
    (intent) =>
      intent.entityId === entityId &&
      intent.mutationKey[0] === 'activity' &&
      intent.mutationKey[1] === 'create' &&
      (intent.status === 'queued' || intent.status === 'in_flight'),
  );
  return {
    pending: create !== undefined,
    canCancel: create?.status === 'queued',
    intentId: create?.intentId,
    status: create?.status,
  };
}

export function recurrenceEditState(intents: readonly Intent[]): RecurrenceEditState {
  const edit = [...intents].reverse().find((intent) => {
    if (intent.mutationKey[0] !== 'activity' || intent.mutationKey[1] !== 'patch') {
      return false;
    }
    const input = (intent.variables as { input?: unknown } | undefined)?.input;
    return (
      typeof input === 'object' && input !== null && Object.hasOwn(input, 'recurrence')
    );
  });
  if (edit === undefined) return { inert: false, message: undefined, status: 'idle' };
  if (edit.status === 'queued') {
    return { inert: true, message: 'Will update when online', status: 'queued' };
  }
  if (edit.status === 'in_flight') {
    return { inert: true, message: 'Updating schedule…', status: 'updating' };
  }
  if (edit.status === 'acknowledged') {
    return edit.lastError === undefined
      ? { inert: true, message: 'Updating schedule…', status: 'updating' }
      : { inert: true, message: "Couldn't refresh schedule · Retry", status: 'retry' };
  }
  return {
    inert: false,
    message: edit.lastError ?? 'Schedule update needs attention',
    status: 'failed',
  };
}

export function agendaRowIntentState(
  intents: readonly Intent[],
  entityId: string | undefined,
): AgendaRowIntentState {
  const pendingCreate = pendingCreateState(intents, entityId);
  const recurrenceEdit = recurrenceEditState(intents);
  return {
    pendingCreate,
    recurrenceEdit,
    mutationInert: pendingCreate.pending || recurrenceEdit.inert,
  };
}
