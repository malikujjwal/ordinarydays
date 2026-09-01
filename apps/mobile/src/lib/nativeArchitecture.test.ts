import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function productionSources(): Array<{ readonly path: string; readonly source: string }> {
  return walk(sourceRoot)
    .filter(
      (path) =>
        /\.tsx?$/.test(path) &&
        !/\.test\.[^.]+$/.test(path) &&
        !/\.performance\.test\.[^.]+$/.test(path),
    )
    .map((path) => ({
      path: relative(sourceRoot, path).replaceAll('\\', '/'),
      source: readFileSync(path, 'utf8'),
    }));
}

function source(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8');
}

const nativeDomainHooks = productionSources()
  .map(({ path }) => path)
  .filter(
    (path) =>
      /^features\/(?:activity|agenda|compose)\/hooks\/.*\.native\.tsx?$/.test(path) ||
      path === 'hooks/usePendingIntents.native.ts',
  );

describe('native Activity/Agenda architecture boundaries', () => {
  it.each(nativeDomainHooks)(
    '%s cannot use TanStack domain operations or direct HTTP',
    (relativePath) => {
      const content = source(relativePath);
      expect(content).not.toMatch(/\b(?:useMutation|useQuery|useInfiniteQuery)\s*\(/);
      expect(content).not.toMatch(/from\s+['"]@\/lib\/apiClient['"]/);
      const sharedClientRuntimeImports = [
        ...content.matchAll(
          /import\s+\{([^}]+)\}\s+from\s+['"]@od\/shared\/client['"]/gs,
        ),
      ].flatMap((match) =>
        (match[1] ?? '')
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name.length > 0),
      );
      expect(sharedClientRuntimeImports.filter((name) => name !== 'isRetryable')).toEqual(
        [],
      );
      expect(content).not.toMatch(/\bfetch\s*\(/);
      expect(content).not.toMatch(
        /from\s+['"]@\/lib\/(?:agendaCache|durableAction|mutationDefaults|queryClient|startUndoable)['"]/,
      );
    },
  );

  it('keeps AsyncStorage outside native Activity/Agenda authority', () => {
    const allowed = new Set([
      'features/agenda/hooks/useShowSkippedPreference.ts',
      'features/reminders/projectionStore.ts',
      'lib/legacyIntentLog.ts',
      'lib/persister.ts',
      'lib/sqlite/legacyMigration.ts',
    ]);
    const importers = productionSources()
      .filter(({ source: content }) =>
        content.includes('@react-native-async-storage/async-storage'),
      )
      .map(({ path }) => path);

    expect(importers.filter((path) => !allowed.has(path))).toEqual([]);
    expect(importers.filter((path) => path.startsWith('lib/sqlite/'))).toEqual([
      'lib/sqlite/legacyMigration.ts',
    ]);
  });

  it('cannot register the retired AsyncStorage replay path as a second queue', () => {
    const forbidden =
      /\b(?:setActiveIntentLog|registerIntentReplayTarget|requestActiveIntentReplay|replayIntents|getActiveIntentLog)\b|intentReplay/;
    const hits = productionSources()
      .filter(({ source: content }) => forbidden.test(content))
      .map(({ path }) => path);
    expect(hits).toEqual([]);

    const legacyConstructors = productionSources()
      .filter(({ source: content }) => /new\s+LegacyIntentLog\s*\(/.test(content))
      .map(({ path }) => path);
    expect(legacyConstructors).toEqual(['lib/sqlite/legacyMigration.ts']);

    const nativeClient = source('lib/queryClient.native.ts');
    expect(nativeClient).not.toMatch(
      /new\s+MutationCache|import[^;]*\bMutationCache\b|registerActivityMutationDefaults\s*\(/,
    );
  });

  it('keeps row and screen pending selectors behind one account presentation store', () => {
    const hook = source('hooks/usePendingIntents.native.ts');
    expect(hook).toMatch(/requireActiveNativeState\(\)\.outboxPresentation/);
    expect(hook).toMatch(/store\.subscribeEntity/);
    expect(hook).toMatch(/store\.subscribeOccurrence/);
    expect(hook).not.toMatch(/\.outbox\.(?:all|subscribe)|account\.subscriptions/);

    const store = source('lib/sqlite/outboxPresentationStore.ts');
    expect(store.match(/subscriptions\.subscribe\('outbox'/g)).toHaveLength(1);
    expect(store).toMatch(/getEntitySnapshot/);
    expect(store).toMatch(/getOccurrenceSnapshot/);
  });

  it('limits projection-reader snapshots to presentation-only repositories', () => {
    const allowed = new Set([
      'lib/sqlite/agendaRepository.ts',
      'lib/sqlite/anytimeRepository.ts',
      /* P3-25. Presentation-only on the same terms: it serves the Lists index and makes no
         write decision from a snapshot — its three writers all take an explicit transaction. */
      'lib/sqlite/listsRepository.ts',
      /* P3-27, on the same terms one level down: it serves list detail, and its snapshot
         reads rows and page state together only so a screen sees one consistent pair. Every
         writer takes an explicit transaction, and the `503` recovery decisions are the sync
         engine's. */
      'lib/sqlite/listItemsRepository.ts',
      /* P3-36, on the Lists terms: it serves the Plans tab, its one writer (`install`) takes
         an explicit transaction, and it makes no write decision from a snapshot. Reading
         through the serialized reader is what stops two overlapping UI reads from nesting
         BEGIN on the writer connection. */
      'lib/sqlite/plansRepository.ts',
      'lib/sqlite/outboxPresentationStore.ts',
    ]);
    const callers = productionSources()
      .filter(({ source: content }) =>
        /(?:projectionReader|projections)\.snapshot\s*\(/.test(content),
      )
      .map(({ path }) => path);
    expect(callers.filter((path) => !allowed.has(path))).toEqual([]);

    const writeDecisionFiles = [
      'lib/sqlite/actionCoordinator.ts',
      'lib/sqlite/activityRepository.ts',
      'lib/sqlite/activityTransactions.ts',
      'lib/sqlite/legacyImporter.ts',
      'lib/sqlite/outbox.ts',
      'lib/sqlite/syncEngine.ts',
    ];
    for (const path of writeDecisionFiles) {
      expect(source(path), path).not.toMatch(
        /RevisionedProjectionReader|projectionReader|projections\.snapshot/,
      );
    }

    const fallback = source('lib/sqlite/projectionReader.ts');
    expect(fallback).toMatch(/source:\s*'writer-fallback'/);
    expect(fallback).toMatch(/this\.transactions\.read/);
    expect(fallback).toMatch(/this\.database\.readTransaction/);
    expect(
      productionSources().some(({ source: content }) => /legacyRead/.test(content)),
    ).toBe(false);
  });
});
