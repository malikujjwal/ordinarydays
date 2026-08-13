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
   * P2-46. A component-level `useMutation` that reuses a registered `mutationKey` and passes
   * its own `onSuccess` **replaces** the default's rather than composing with it, so the
   * default's `refreshActivityLists` never runs. Five call sites did that and lost the agenda
   * invalidation: a task saved from compose was missing from Today, a reschedule left the old
   * time on the row, a duplicate never appeared and a delete never left.
   *
   * The guard is structural rather than behavioural because the defect is structural — it is
   * invisible in every isolated test of the hook, since the hook does exactly what it says.
   */
  it.each(files)(
    '%s calls refreshActivityLists from every local mutation onSuccess',
    (relative) => {
      const source = sourceOf(relative);
      const handlers = source.match(/onSuccess\s*:/g)?.length ?? 0;
      const refreshes = source.match(/refreshActivityLists\(/g)?.length ?? 0;

      expect(refreshes).toBeGreaterThanOrEqual(handlers);
      if (handlers > 0) expect(source).toMatch(/refreshActivityLists/);
      // The bare invalidation is what the shared helper exists to replace; reaching for it
      // directly is how these five drifted apart in the first place.
      expect(source).not.toMatch(/invalidateQueries\(\{\s*queryKey:\s*\['agenda'\]/);
    },
  );

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
