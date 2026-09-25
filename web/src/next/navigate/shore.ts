/**
 * The "shoreline nearer than the horizon" horizon (dip short of the horizon, CONVENTIONS
 * section 5 step 2, docs/NAVIGATION_METHODS.md section 12): its distance field and the
 * sentence that says what it changes. OWNER: navigate2 agent (expansion programme).
 *
 * The reduction itself is the core's; the sentence here uses the same formula
 * (`corrections.ts`, `dipShortArcmin`, `seaHorizonNm`: Bowditch vol. 2 section 402 and
 * Table 14, tested against the table in navigate-extras.test.ts) so the person reads the
 * consequence before the sight is worked out. The workings then show the core's own step.
 */

import { dipArcmin, dipShortArcmin, seaHorizonNm } from '../../corrections.js';
import { h } from '../../dom.js';
import type { HorizonMode } from '../../types.js';
import { isShoreHorizon } from '../../types.js';
import { parseNumber } from './parse.js';
import { parsedField, type ParsedField } from './ui.js';

export interface ShoreSentence {
  /** `note` inside the sea horizon; `caution` beyond it (the waterline is hidden). */
  level: 'note' | 'caution';
  text: string;
  seaHorizonNm: number;
  dipArcmin: number;
  seaDipArcmin: number;
}

const f = (v: number, d: number): string => v.toFixed(d);

/** What a shore horizon at `distanceNm` does for a height of eye (the core's rule, in words). */
export function shoreSentence(distanceNm: number, heightOfEyeM: number): ShoreSentence {
  const horizon = seaHorizonNm(heightOfEyeM);
  const sea = dipArcmin(heightOfEyeM);
  if (!(distanceNm < horizon)) {
    return {
      level: 'caution',
      text:
        `Beyond the sea horizon, which is ${f(horizon, 2)} NM away for a height of eye of ${f(heightOfEyeM, 1)} m, the waterline is hidden by the curve of the sea: ` +
        `the sea horizon is what you see, so the ordinary dip (${f(sea, 2)}′) applies and the workings say so.`,
      seaHorizonNm: horizon,
      dipArcmin: sea,
      seaDipArcmin: sea,
    };
  }
  const short = Math.max(dipShortArcmin(heightOfEyeM, distanceNm), sea);
  return {
    level: 'note',
    text:
      `A waterline ${f(distanceNm, 2)} NM away is nearer than the sea horizon (${f(horizon, 2)} NM for a height of eye of ${f(heightOfEyeM, 1)} m), so it lies further below level: ` +
      `the dip short of the horizon is ${f(short, 2)}′ instead of the sea dip ${f(sea, 2)}′ (Bowditch, Table 14).`,
    seaHorizonNm: horizon,
    dipArcmin: short,
    seaDipArcmin: sea,
  };
}

/**
 * The distance field beside a horizon select: shown only while the horizon is a shore
 * horizon, it edits the distance and says what it does.
 */
export function shoreDistanceField(options: {
  read: () => HorizonMode | null;
  heightOfEyeM: () => number;
  commit: (horizon: HorizonMode) => void;
  label?: string;
}): ParsedField & { refresh(force?: boolean): void } {
  const field = parsedField<number>(options.label ?? 'Distance to the waterline (NM)', {
    term: 'dip short of the horizon',
    inputmode: 'decimal',
    size: 6,
    parse: (t) => parseNumber(t, { what: 'The distance to the waterline', min: 0, exclusiveMin: true, max: 100, unit: 'NM' }),
    format: (v) => String(v),
    read: () => {
      const h0 = options.read();
      return isShoreHorizon(h0) ? h0.shore.distance_nm : 1;
    },
    commit: (v) => options.commit({ shore: { distance_nm: v } }),
  });
  field.el.classList.add('sfn-shore');
  const sentence = h('p', { class: 'sfn-shore__sentence', role: 'note' });
  field.el.append(sentence);
  const base = field.refresh;
  const refresh = (force = false): void => {
    const horizon = options.read();
    field.el.hidden = !isShoreHorizon(horizon);
    if (!isShoreHorizon(horizon)) return;
    base(force);
    const s = shoreSentence(horizon.shore.distance_nm, options.heightOfEyeM());
    sentence.textContent = s.text;
    sentence.classList.toggle('sfn-shore__sentence--caution', s.level === 'caution');
  };
  refresh(true);
  return { ...field, refresh };
}
