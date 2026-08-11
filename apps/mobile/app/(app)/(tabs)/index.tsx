import { useRouter } from 'expo-router';
import { TodayScreen } from '@/features/agenda/components/TodayScreen';

/** Thin Today route: the feature owns the projection; this edge owns pushed navigation. */
export default function TodayTab() {
  const router = useRouter();
  return <TodayScreen onOpenAnytime={() => router.push('/anytime')} />;
}
