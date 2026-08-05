/**
 * Wall-clock per phase, logged as one line per job.
 *
 * Optimising this feature was guesswork until the phases were measured: the
 * intuitive suspect (the 3,000-fingerprint Blizzard sweep) turned out to be 24% of
 * a job, while 8 serial calls to a 1,029ms Raider.IO endpoint were 52%. One
 * summary line keeps that visible per run without spamming the log.
 *
 * Lives in its own module so the sweep can measure its own sub-phases: runJob
 * imports discoverAlts, so discoverAlts cannot import from runJob.
 */
export class PhaseTimings {
  private readonly ms = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private readonly started = Date.now();
  private last = Date.now();

  /**
   * Attribute everything since the previous mark to `phase`. Accumulates, so a
   * phase interleaved with others in a loop (a roster fetch, then its
   * fingerprint batch, per guild) still totals correctly.
   */
  mark(phase: string): void {
    const now = Date.now();
    this.ms.set(phase, (this.ms.get(phase) ?? 0) + (now - this.last));
    this.last = now;
  }

  /**
   * A plain number alongside the timings. Wall-clock alone cannot say whether a
   * slow phase was slow per call or merely made many calls, which is exactly the
   * question a timing line gets asked next.
   */
  count(label: string, n: number): void {
    this.counts.set(label, n);
  }

  /** Whatever phases completed, so a paused job still reports where it got to. */
  summary(): string {
    const parts = [...this.ms.entries()].map(([k, v]) => `${k}=${(v / 1000).toFixed(1)}s`);
    parts.push(`total=${((Date.now() - this.started) / 1000).toFixed(1)}s`);
    for (const [k, v] of this.counts) parts.push(`${k}=${v}`);
    return parts.join(' ');
  }
}
