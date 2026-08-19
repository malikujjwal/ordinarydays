import type { QueryClient } from '@tanstack/react-query';
import type { NativeStateSession } from '@/lib/sqlite/nativeState';

/** Web retains its online-first TanStack adapter and opens no SQLite database. */
export async function startNativeStateSession(
  _queryClient: QueryClient,
): Promise<NativeStateSession | undefined> {
  return undefined;
}
