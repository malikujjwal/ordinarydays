import { TabScreen } from '@/features/shell/components/TabScreen';

/** Today. A query over the agenda, never storage — Phase 2 (P2-11) fills it. */
export default function TodayTab() {
  return (
    <TabScreen
      title="Today"
      emptyHeading="Nothing planned today"
      emptyBody="The day's agenda arrives in Phase 2."
      testID="today-screen"
    />
  );
}
