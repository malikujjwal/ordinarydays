import type { Activity } from '@od/shared/types';

export interface ActionCapabilityContext {
  readonly activity: Activity;
  readonly callerId: string;
  readonly callerRole: 'owner' | 'participant' | 'none';
  readonly parentOwnerId?: string;
  readonly participatesInParent: boolean;
}

export interface ActionCapabilities {
  readonly complete: boolean;
  readonly skip: boolean;
  readonly snooze: boolean;
}

/**
 * Applies the one action-authority policy shared by agenda projection and mutations.
 * The caller supplies an already-hydrated relationship context; this function performs no I/O.
 */
export function deriveActionCapabilities(
  context: ActionCapabilityContext,
): ActionCapabilities {
  const mayAct =
    context.callerRole === 'owner' ||
    (context.activity.parentActivityId !== undefined &&
      (context.callerId === context.parentOwnerId || context.participatesInParent));

  return { complete: mayAct, skip: mayAct, snooze: mayAct };
}
