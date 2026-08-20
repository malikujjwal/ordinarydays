export type RepositoryScope = string;
export interface RepositoryInvalidationMetadata {
  readonly scope: RepositoryScope;
  readonly commitRevision?: number;
}
export type RepositoryListener = (metadata: RepositoryInvalidationMetadata) => void;

/** Account-local invalidation versions suitable for `useSyncExternalStore`. */
export class RepositorySubscriptions {
  private readonly listeners = new Map<RepositoryScope, Set<RepositoryListener>>();
  private readonly versions = new Map<RepositoryScope, number>();

  subscribe(scope: RepositoryScope, listener: RepositoryListener): () => void {
    const listeners = this.listeners.get(scope) ?? new Set<RepositoryListener>();
    listeners.add(listener);
    this.listeners.set(scope, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(scope);
    };
  }

  version(scope: RepositoryScope): number {
    return this.versions.get(scope) ?? 0;
  }

  publish(scopes: ReadonlySet<RepositoryScope>, commitRevision?: number): void {
    for (const scope of scopes) {
      this.versions.set(scope, this.version(scope) + 1);
      const metadata: RepositoryInvalidationMetadata = {
        scope,
        ...(commitRevision === undefined ? {} : { commitRevision }),
      };
      for (const listener of this.listeners.get(scope) ?? []) listener(metadata);
    }
  }
}
