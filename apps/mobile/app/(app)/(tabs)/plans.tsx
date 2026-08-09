import { TabScreen } from '@/features/shell/components/TabScreen';

/**
 * Plans.
 *
 * P1-23 has this tab render the flat activity list from **P1-16**
 * (`GET /v1/activities?filter=`), which has not landed — `services/api/src/routes/` is health
 * only. It is a placeholder until then rather than a list wired to an endpoint that returns
 * 404, and the three-stage Plans tab proper is Phase 3 (P3-14).
 */
export default function PlansTab() {
  return (
    <TabScreen
      title="Plans"
      emptyHeading="No plans"
      emptyBody="The plans list arrives with the activity list endpoint (P1-16)."
      testID="plans-screen"
    />
  );
}
