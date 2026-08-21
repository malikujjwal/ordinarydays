import type { Intent } from '@/lib/intentLog';
import { changesRecurrenceTopology } from '@/lib/mutationKeys';

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
  /** Completion overrides owned by these failed intents must yield to restored server truth. */
  failedCompletionIntentIds: readonly string[];
}

const COMPLETION_MUTATIONS = new Set(['complete', 'uncomplete']);

function completionOccurrenceDate(intent: Intent): string | undefined | null {
  if (typeof intent.variables !== 'object' || intent.variables === null) return null;
  const input = (intent.variables as { readonly input?: unknown }).input;
  if (typeof input !== 'object' || input === null) return null;
  const occurrenceDate = (input as { readonly occurrenceDate?: unknown }).occurrenceDate;
  return occurrenceDate === undefined
    ? undefined
    : typeof occurrenceDate === 'string'
      ? occurrenceDate
      : null;
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
      intent.status !== 'acknowledged',
  );
  return {
    pending: create !== undefined,
    canCancel: create?.status === 'queued',
    intentId: create?.intentId,
    status: create?.status,
  };
}

export function recurrenceEditState(intents: readonly Intent[]): RecurrenceEditState {
  const edit = [...intents].reverse().find(changesRecurrenceTopology);
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
  occurrenceDate?: string,
): AgendaRowIntentState {
  const pendingCreate = pendingCreateState(intents, entityId);
  const recurrenceEdit = recurrenceEditState(intents);
  return {
    pendingCreate,
    recurrenceEdit,
    mutationInert: pendingCreate.pending || recurrenceEdit.inert,
    failedCompletionIntentIds: intents
      .filter(
        (intent) =>
          intent.status === 'needs_attention' &&
          intent.mutationKey[0] === 'activity' &&
          COMPLETION_MUTATIONS.has(intent.mutationKey[1] ?? '') &&
          completionOccurrenceDate(intent) === occurrenceDate,
      )
      .map((intent) => intent.intentId),
  };
}
