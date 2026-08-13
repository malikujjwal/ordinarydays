import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const files = [
  '../features/compose/hooks/useCreateActivity.ts',
  '../features/activity/hooks/useActivity.ts',
  '../features/activity/hooks/useActivityActions.ts',
  '../features/agenda/hooks/useAgendaActivityActions.ts',
];

const sourceOf = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('offline mutation option guard', () => {
  it.each(files)('%s inherits the shared queue network/retry defaults', (relative) => {
    const source = sourceOf(relative);
    const firstMutation = source.search(/=\s*useMutation/);
    expect(firstMutation).toBeGreaterThan(-1);
    const mutationSurface = source.slice(firstMutation);

    expect(mutationSurface).not.toMatch(/networkMode\s*:\s*['"]always['"]/);
    expect(mutationSurface).not.toMatch(/retry\s*:\s*false/);
    expect(mutationSurface.match(/=\s*useMutation/g)?.length).toBe(
      mutationSurface.match(/mutationKey\s*:/g)?.length,
    );
  });

  /**
   * P2-46. A component's `onSuccess` is bound to that component's observer and never runs once
   * the component has gone — and the two writes that most need to refresh Today are exactly
   * the two that close their own surface on success: compose unmounts on save, and the
   * reschedule sheet unmounts when it closes. So the agenda refresh belongs on the
   * `MutationCache`, which outlives every screen and also covers mutations replayed from the
   * offline queue after a restart.
   *
   * The guard is structural because the defect is: every isolated test of these hooks passes,
   * since each hook does exactly what it says it does. Only the interaction between a handler
   * and its component's lifetime is wrong, and nothing at unit level can see that.
   */
  it.each(files)('%s does not own the agenda refresh', (relative) => {
    const source = sourceOf(relative);

    expect(source).not.toMatch(/refreshActivityLists/);
    expect(source).not.toMatch(/invalidateQueries\(\{\s*queryKey:\s*\['agenda'\]/);
  });

  it('keeps the agenda refresh on the MutationCache, where an unmount cannot cancel it', () => {
    const source = sourceOf('./queryClient.ts');
    const cacheSurface = source.slice(
      source.indexOf('new MutationCache'),
      source.indexOf('defaultOptions'),
    );

    expect(cacheSurface).toMatch(/onSuccess/);
    expect(cacheSurface).toMatch(/changesActivityLists/);
    expect(cacheSurface).toMatch(/refreshActivityLists\(client\)/);
  });

  it('keeps the Activity GET override that makes Try again issue a request', () => {
    const source = sourceOf('../features/activity/hooks/useActivity.ts');
    const querySurface = source.slice(
      source.indexOf('const query = useQuery'),
      source.indexOf('const mutation = useMutation'),
    );

    expect(querySurface).toMatch(/networkMode\s*:\s*['"]always['"]/);
    expect(querySurface).toMatch(/retry\s*:\s*false/);
  });
});
