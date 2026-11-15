/** Read only the timing fields of the product's content-free answer latency ledger.
 * v1/v2 dual writes count once; a rotated file can overlap the current file. */
export function answerModelTiming(lines: string[]): { recordedCalls: number; analystMs: number; localMs: number } {
  const records = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const traces = new Map<string, any>();
  const legacy = new Map<string, any>();
  for (const record of records) {
    if (record?.kind === 'source_answer_latency_trace' && typeof record.correlation_id === 'string') traces.set(record.correlation_id, record);
    if (record?.kind === 'source_answer_latency' && typeof record.logged_at === 'string') legacy.set(record.logged_at, record);
  }
  for (const trace of traces.values()) if (trace.compat_v1_logged_at) legacy.delete(trace.compat_v1_logged_at);
  const ms = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  let analystMs = 0;
  let localMs = 0;
  for (const record of traces.values()) {
    analystMs += ms(record.phase_ms?.analyst_ms);
    for (const leg of Array.isArray(record.analyst_legs) ? record.analyst_legs : []) {
      if (leg.backend === 'local' || leg.backend === 'built_in') localMs += ms(leg.elapsed_ms);
    }
  }
  for (const record of legacy.values()) {
    const elapsed = ms(record.phase_timings?.analyst_ms);
    analystMs += elapsed;
    if (record.analyst_backend === 'local' || record.analyst_backend === 'built_in') localMs += elapsed;
  }
  return { recordedCalls: traces.size + legacy.size, analystMs, localMs };
}
