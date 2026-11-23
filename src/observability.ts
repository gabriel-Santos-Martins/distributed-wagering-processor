const counters = new Map<string, number>();

export function observe(metric: string, value = 1): void {
  counters.set(metric, (counters.get(metric) ?? 0) + value);
}

export function metricSnapshot(): Record<string, number> { return Object.fromEntries(counters); }

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }));
}

export function sqlCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}
