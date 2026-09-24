/**
 * Frame-time bookkeeping for the Sky view (EXPLORER_PLAN §3.7: the view draws 9 000
 * stars in ≤ 8 ms). OWNER: sky agent. A fixed ring buffer: recording allocates nothing.
 */

export interface FrameStats {
  frames: number;
  /** Milliseconds per frame: whole draw (engine calls, geometry and canvas commands). */
  mean: number;
  p50: number;
  p95: number;
  max: number;
  last: number;
  /** The same for the parts: engine + geometry, and canvas drawing. */
  computeMean: number;
  paintMean: number;
}

export class FrameTimer {
  private readonly total: Float64Array;
  private readonly compute: Float64Array;
  private readonly paint: Float64Array;
  private n = 0;
  private next = 0;

  constructor(private readonly capacity = 600) {
    this.total = new Float64Array(capacity);
    this.compute = new Float64Array(capacity);
    this.paint = new Float64Array(capacity);
  }

  record(computeMs: number, paintMs: number): void {
    this.compute[this.next] = computeMs;
    this.paint[this.next] = paintMs;
    this.total[this.next] = computeMs + paintMs;
    this.next = (this.next + 1) % this.capacity;
    this.n = Math.min(this.n + 1, this.capacity);
  }

  reset(): void {
    this.n = 0;
    this.next = 0;
  }

  stats(): FrameStats {
    const n = this.n;
    if (n === 0) return { frames: 0, mean: 0, p50: 0, p95: 0, max: 0, last: 0, computeMean: 0, paintMean: 0 };
    const sorted = Float64Array.from(this.total.subarray(0, n)).sort();
    const mean = (a: Float64Array): number => {
      let s = 0;
      for (let i = 0; i < n; i += 1) s += a[i]!;
      return s / n;
    };
    const q = (p: number): number => sorted[Math.min(n - 1, Math.floor(p * (n - 1) + 0.5))]!;
    return {
      frames: n,
      mean: mean(this.total),
      p50: q(0.5),
      p95: q(0.95),
      max: sorted[n - 1]!,
      last: this.total[(this.next - 1 + this.capacity) % this.capacity]!,
      computeMean: mean(this.compute),
      paintMean: mean(this.paint),
    };
  }
}
