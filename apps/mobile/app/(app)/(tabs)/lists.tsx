import { TabScreen } from '@/features/shell/components/TabScreen';

/** Lists. Phase 3 (P3-01 onward) fills it; the tab exists now so the three nouns are stable. */
export default function ListsTab() {
  return (
    <TabScreen
      title="Lists"
      emptyHeading="No lists yet"
      emptyBody="Lists arrive in Phase 3."
      testID="lists-screen"
    />
  );
}
