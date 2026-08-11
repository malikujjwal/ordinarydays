import type { CleanupPhase, CleanupRef, CleanupWork } from '../lib/idempotency.js';
import {
  deleteCleanup,
  listCleanup,
  loadCleanup,
  saveCleanupProgress,
} from '../repositories/idempotencyRepository.js';

export interface CleanupStepResult {
  readonly cursor?: string;
  readonly complete: boolean;
}

/** A phase executor must treat an already-applied effect as success. */
export type CleanupPhaseExecutor = (
  work: CleanupWork,
  phase: CleanupPhase,
) => Promise<CleanupStepResult>;

const MAX_PROGRESS_STEPS = 100;

/** Drains one work item and deletes it only after every persisted phase is complete. */
export async function drainCleanup(
  ref: CleanupRef,
  execute: CleanupPhaseExecutor,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  for (let step = 0; step < MAX_PROGRESS_STEPS; step += 1) {
    const work = await loadCleanup(ref);
    if (work === undefined) return;

    const index = work.phases.findIndex((phase) => !phase.complete);
    if (index < 0) {
      if (await deleteCleanup(work)) return;
      continue;
    }

    const phase = work.phases[index];
    if (phase === undefined) throw new Error('Cleanup phase index was invalid.');
    const result = await execute(work, phase);
    const replacement: CleanupPhase = {
      kind: phase.kind,
      ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      complete: result.complete,
    };
    const phases = work.phases.map((phase, phaseIndex) =>
      phaseIndex === index ? replacement : phase,
    );
    await saveCleanupProgress(work, phases, now());
  }

  throw new Error('Cleanup work exceeded the bounded progress limit.');
}

/** Opportunistic recovery before the next mutation touching this Activity. */
export async function drainActivityCleanup(
  activityId: string,
  execute: CleanupPhaseExecutor,
  now?: () => string,
): Promise<void> {
  const pending = await listCleanup(activityId);
  for (const work of pending) await drainCleanup(work, execute, now);
}
