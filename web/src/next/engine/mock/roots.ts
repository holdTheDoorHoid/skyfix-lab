/**
 * MOCK ENGINE ONLY — root finding for events, following CONVENTIONS 13.3: bracket sign
 * changes on a fixed grid, refine by bisection to better than a second.
 */

export interface Crossing {
  /** jd_utc of the crossing. */
  t: number;
  /** The function went from negative to non-negative. */
  rising: boolean;
}

/** Half a second, in days: bisection stops below this bracket width. */
export const ROOT_TOLERANCE_DAYS = 0.5 / 86_400;

/** Grid from t0 to t1 inclusive with steps no longer than `step` (days). */
export function grid(t0: number, t1: number, step: number): Float64Array {
  const n = Math.max(1, Math.ceil((t1 - t0) / step - 1e-9));
  const h = (t1 - t0) / n;
  const out = new Float64Array(n + 1);
  for (let k = 0; k <= n; k += 1) out[k] = k === n ? t1 : t0 + k * h;
  return out;
}

export interface CrossingOptions {
  /**
   * For angle-like functions wrapped to (-180, 180]: ignore sign changes where either
   * side is further than this from zero (that is the wrap, not a root).
   */
  maxJump?: number;
  /** Keep only rising crossings. */
  risingOnly?: boolean;
  tolerance?: number;
}

/**
 * Every sign change of `f` between consecutive grid samples `values[k] = f(times[k])`,
 * refined by bisection. A root exactly on the first sample is not a crossing: the
 * window's edges never create events.
 */
export function crossings(
  f: (t: number) => number,
  times: Float64Array,
  values: Float64Array,
  options: CrossingOptions = {},
): Crossing[] {
  const maxJump = options.maxJump ?? Infinity;
  const tol = options.tolerance ?? ROOT_TOLERANCE_DAYS;
  const out: Crossing[] = [];
  for (let k = 0; k + 1 < times.length; k += 1) {
    const va = values[k]!;
    const vb = values[k + 1]!;
    const rising = va < 0 && vb >= 0;
    const falling = va >= 0 && vb < 0;
    if (!rising && !falling) continue;
    if (Math.abs(va) > maxJump || Math.abs(vb) > maxJump) continue;
    if (options.risingOnly && !rising) continue;
    let a = times[k]!;
    let b = times[k + 1]!;
    let fa = va;
    while (b - a > tol) {
      const m = 0.5 * (a + b);
      const fm = f(m);
      if (Math.abs(fm) > maxJump) break; // should not happen inside a genuine bracket
      if (fa < 0 === fm < 0) {
        a = m;
        fa = fm;
      } else {
        b = m;
      }
    }
    out.push({ t: 0.5 * (a + b), rising });
  }
  return out;
}

/** Evaluate `f` on a grid. */
export function sample(f: (t: number) => number, times: Float64Array): Float64Array {
  const out = new Float64Array(times.length);
  for (let k = 0; k < times.length; k += 1) out[k] = f(times[k]!);
  return out;
}
