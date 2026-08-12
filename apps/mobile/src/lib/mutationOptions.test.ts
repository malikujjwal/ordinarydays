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
