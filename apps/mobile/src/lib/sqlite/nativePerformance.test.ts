import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordNativePerformanceMetric,
  resetNativePerformanceMetricsForTests,
} from './nativePerformance';

describe('native SQLite performance summaries', () => {
  afterEach(() => {
    resetNativePerformanceMetricsForTests();
    vi.restoreAllMocks();
  });

  it('reports p50, p95, and max for each bounded ten-sample checkpoint', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    for (let value = 1; value <= 10; value += 1) {
      recordNativePerformanceMetric('completion_queue_wait', value);
    }

    expect(info).toHaveBeenCalledWith('native_performance_summary', {
      metric: 'completion_queue_wait',
      count: 10,
      windowSize: 10,
      p50Ms: 5,
      p95Ms: 10,
      maxMs: 10,
    });
  });

  it('keeps unrelated metric streams independent', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    for (let value = 0; value < 9; value += 1) {
      recordNativePerformanceMetric('agenda_full_window_reader', value);
      recordNativePerformanceMetric('agenda_targeted_reader', value);
    }
    recordNativePerformanceMetric('agenda_targeted_reader', 9);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      'native_performance_summary',
      expect.objectContaining({ metric: 'agenda_targeted_reader', count: 10 }),
    );
  });
});
