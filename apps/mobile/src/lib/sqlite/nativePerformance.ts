export type NativePerformanceMetric =
  | 'completion_queue_wait'
  | 'completion_writer_transaction'
  | 'agenda_targeted_reader'
  | 'agenda_full_window_reader'
  | 'agenda_result_application';

interface MetricState {
  readonly values: number[];
  count: number;
}

const REPORT_EVERY = 10;
const WINDOW_SIZE = 100;
const states = new Map<NativePerformanceMetric, MetricState>();

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

/** Emits bounded rolling summaries without retaining a long-session telemetry history. */
export function recordNativePerformanceMetric(
  metric: NativePerformanceMetric,
  durationMs: number,
): void {
  if (!__DEV__ || !Number.isFinite(durationMs) || durationMs < 0) return;
  const state = states.get(metric) ?? { values: [], count: 0 };
  state.count += 1;
  state.values.push(durationMs);
  if (state.values.length > WINDOW_SIZE) state.values.shift();
  states.set(metric, state);
  if (state.count % REPORT_EVERY !== 0) return;

  const sorted = [...state.values].sort((left, right) => left - right);
  console.info('native_performance_summary', {
    metric,
    count: state.count,
    windowSize: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1) ?? 0,
  });
}

export function resetNativePerformanceMetricsForTests(): void {
  states.clear();
}
