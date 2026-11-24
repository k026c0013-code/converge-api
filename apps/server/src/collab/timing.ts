/**
 * Opt-in latency breakdown for load tests (COLLAB_TIMING=1). Keeps a bounded sample per stage
 * and logs p50/p95/max every interval. Off by default: zero overhead beyond a boolean check.
 */
export class StageTimer {
  private readonly samples = new Map<string, number[]>();
  private readonly timer: NodeJS.Timeout | null;

  constructor(
    readonly enabled: boolean,
    log: (summary: Record<string, { n: number; p50: number; p95: number; max: number }>) => void,
    intervalMs = 10_000,
  ) {
    this.timer = enabled
      ? setInterval(() => {
          const out: Record<string, { n: number; p50: number; p95: number; max: number }> = {};
          for (const [stage, xs] of this.samples) {
            if (xs.length === 0) continue;
            xs.sort((a, b) => a - b);
            const at = (p: number) => Math.round(xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]! * 10) / 10;
            out[stage] = { n: xs.length, p50: at(0.5), p95: at(0.95), max: at(1) };
            xs.length = 0;
          }
          if (Object.keys(out).length) log(out);
        }, intervalMs)
      : null;
    this.timer?.unref();
  }

  record(stage: string, ms: number): void {
    if (!this.enabled) return;
    let xs = this.samples.get(stage);
    if (!xs) this.samples.set(stage, (xs = []));
    if (xs.length < 50_000) xs.push(ms);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export const NO_TIMING = new StageTimer(false, () => {});
