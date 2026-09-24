/**
 * The ten packaged demonstrations as guided stories. OWNER: learn agent.
 *
 * The scenarios themselves come from the core (`demos()` in `skyfix-wasm`, the same
 * `skyfix_sim::demos` the command line runs); this file only says how to tell each one:
 * a title, two sentences on what it shows, what to look at in the picture, and what to
 * try next. docs/DEMOS.md is the reference for every number a story quotes, and
 * web/test/next/learn-wasm.test.ts checks them against the real engine.
 *
 * Plain words first (EXPLORER_PLAN §1): a story never assumes the reader knows what a
 * residual or a condition number is before it has said so.
 */

/** The packaged scenario names, in the order `demos()` returns them. */
export const STORY_IDS = [
  'philadelphia-stars',
  'philadelphia-stars-real',
  'philadelphia-stars-sextant',
  'good-geometry',
  'clustered-geometry',
  'one-bad-sight',
  'clock-offset',
  'shared-bias',
  'single-sight',
  'two-sight-ambiguous',
] as const;

export type StoryId = (typeof STORY_IDS)[number];

export function isStoryId(value: unknown): value is StoryId {
  return typeof value === 'string' && (STORY_IDS as readonly string[]).includes(value);
}

/** The brief's six required demonstrations (docs/BRIEF.md, docs/DEMOS.md). */
export type GroupNumber = 1 | 2 | 3 | 4 | 5 | 6;

export interface StoryGroup {
  n: GroupNumber;
  title: string;
  /** One line under the group heading. */
  line: string;
}

export const GROUPS: readonly StoryGroup[] = [
  { n: 1, title: 'A fix that works', line: 'What healthy looks like, so the rest are recognisable.' },
  { n: 2, title: 'Where the stars are matters', line: 'The same sights, spread out or bunched together.' },
  { n: 3, title: 'One bad sight', line: 'A single misread sight among good ones.' },
  { n: 4, title: 'A clock that is wrong', line: 'Perfect sights, timed by a fast watch.' },
  { n: 5, title: 'An error every sight shares', line: 'Averaging cannot remove it.' },
  { n: 6, title: 'Too few sights', line: 'A circle, and two crossings.' },
];

/**
 * Something the result panel can offer after a run. `variant` re-runs the same story with
 * one thing changed (see `run.ts`); `story` opens another story; `experiment` repeats this
 * scenario with fresh noise in the Simulator; `simulator` opens it there with one knob set.
 */
export type TryAction =
  | { kind: 'variant'; variant: VariantId; label: string }
  | { kind: 'story'; story: StoryId; label: string }
  | { kind: 'experiment'; repetitions: number; label: string }
  | { kind: 'simulator'; set?: SimulatorPreset; label: string };

/** A one-knob change applied when a story opens in the Simulator. */
export type SimulatorPreset = 'no-bias' | 'clock-sigma-60' | 'eye-height-10';

/** Re-runs of a story with one thing changed; defined in `run.ts`. */
export type VariantId = 'robust' | 'clock-sigma' | 'estimate-bias' | 'third-star';

export interface Story {
  id: StoryId;
  group: GroupNumber;
  /** Plain words, a few of them. */
  title: string;
  /** Exactly two sentences: what this demonstration shows (tested). */
  summary: string;
  /** What to look at in the picture and the numbers. */
  lookAt: string;
  /** What to try next: a sentence and the actions that do it. */
  next: { text: string; actions: readonly TryAction[] };
  /**
   * Show the fit map (the residual heat map) with the chart from the start, where it teaches
   * the most: the two basins of an ambiguous fix, the long valley of poor geometry.
   */
  fitMap?: boolean;
}

export const STORIES: readonly Story[] = [
  {
    id: 'philadelphia-stars',
    group: 1,
    title: 'A healthy fix',
    summary:
      'Five sights of stars spread right round the sky, each off by a small random amount. ' +
      'The fix lands close to the truth and inside its own 95 % ellipse: this is what working looks like.',
    lookAt:
      'Five lines of position crossing near one point, a small round ellipse, and the answer key inside it.',
    next: {
      text:
        'One run proves little. Repeat it fifty times with fresh noise and count how often the truth lands inside the ellipse: close to 95 in 100 is the promise.',
      actions: [
        { kind: 'experiment', repetitions: 50, label: 'Repeat it 50 times' },
        { kind: 'story', story: 'one-bad-sight', label: 'Next: one bad sight' },
      ],
    },
  },
  {
    id: 'philadelphia-stars-real',
    group: 1,
    title: 'Real stars',
    summary:
      'The same fix with six real navigational stars, Vega, Altair, Arcturus, Deneb, Capella and Polaris, looked up in the built-in almanac. ' +
      'It agrees with the invented-star version, so the astronomy and the navigation agree.',
    lookAt:
      'The circles now belong to real stars in their real directions; the ellipse and the error are the same size as with invented stars.',
    next: {
      text:
        'Compare it with the invented-star version, then repeat it fifty times: the coverage should again be near 95 in 100.',
      actions: [
        { kind: 'story', story: 'philadelphia-stars', label: 'Compare: invented stars' },
        { kind: 'experiment', repetitions: 50, label: 'Repeat it 50 times' },
      ],
    },
  },
  {
    id: 'philadelphia-stars-sextant',
    group: 1,
    title: 'Raw sextant readings',
    summary:
      'The same sky, but the session holds what the sextant actually read, before the index error, the dip of the horizon and refraction are taken out. ' +
      'The tool undoes each correction step by step, and over many runs the fix behaves exactly like the corrected-altitude version.',
    lookAt:
      'The correction table: one row per step, with its size and sign, for every sight.',
    next: {
      text:
        'Open it in the Simulator and raise the height of eye: the dip correction grows, the readings change, and the fix does not move.',
      actions: [{ kind: 'simulator', set: 'eye-height-10', label: 'Open in the Simulator, eye at 10 m' }],
    },
  },
  {
    id: 'good-geometry',
    group: 2,
    title: 'Stars all round',
    summary:
      'Six sights of stars spread round the compass, with one arcminute of noise each. ' +
      'The lines cross at wide angles, so the error ellipse is small and nearly round.',
    lookAt: 'The size and shape of the ellipse, and the condition number (1 is perfectly balanced).',
    next: {
      text:
        'Now run the clustered version: the same stars, the same noise and the same random seed, but only the ones in one corner of the sky.',
      actions: [{ kind: 'story', story: 'clustered-geometry', label: 'Next: stars bunched together' }],
    },
  },
  {
    id: 'clustered-geometry',
    group: 2,
    title: 'Stars bunched together',
    summary:
      'The same stars, noise and seed, but only the three that sit in one 30° patch of sky. ' +
      'Nearly parallel lines make a long, thin ellipse, and the solver says plainly that the geometry is poor.',
    lookAt:
      'The ellipse is not just bigger, it is a different shape: long across the direction the stars were in.',
    fitMap: true,
    next: {
      text:
        'Put it beside the spread-out run, then repeat it fifty times: the big ellipse still holds the truth about 95 times in 100. It is honest, just less certain.',
      actions: [
        { kind: 'story', story: 'good-geometry', label: 'Compare: stars all round' },
        { kind: 'experiment', repetitions: 50, label: 'Repeat it 50 times' },
      ],
    },
  },
  {
    id: 'one-bad-sight',
    group: 3,
    title: 'One bad sight',
    summary:
      'Five sights, one of them misread by 8 arcminutes, the kind of slip that comes from reading the sextant drum wrong. ' +
      'Least squares splits the difference, so the fix moves by kilometres and the bad sight shows up as one residual far bigger than the rest.',
    lookAt:
      'The residual bars: one stands far outside the others, which points at a sight rather than at the position.',
    next: {
      text:
        'Turn on robust weighting: the solver gives the odd sight less say, the fix moves back towards the truth, and the report says the uncertainty is now approximate.',
      actions: [{ kind: 'variant', variant: 'robust', label: 'Turn on robust weighting' }],
    },
  },
  {
    id: 'clock-offset',
    group: 4,
    title: 'A fast watch',
    summary:
      'Five perfect sights timed by a watch that runs exactly one minute fast. ' +
      'The fix moves a quarter of a degree of longitude due west while every residual stays at zero, so nothing in the data looks wrong.',
    lookAt:
      'The fix sits due west of the truth on the same latitude, with a small ellipse that does not reach it.',
    next: {
      text:
        'Tell the solver the watch may be a minute out. It cannot move the fix (clock error and longitude are the same unknown), but it stretches the ellipse east and west until it covers the truth.',
      actions: [{ kind: 'variant', variant: 'clock-sigma', label: 'Declare 60 s of clock doubt' }],
    },
  },
  {
    id: 'shared-bias',
    group: 5,
    title: 'The same error on every sight',
    summary:
      'Twenty-four sights from an instrument that reads 3 arcminutes too high every time. ' +
      'Averaging shrinks the ellipse but cannot remove an error every sight shares, so the fix is kilometres off with a tiny ellipse.',
    lookAt:
      'Three things side by side: the small stated uncertainty, the large actual error, and residuals no bigger than an ordinary sextant’s scatter.',
    next: {
      text:
        'Ask the solver to estimate a shared bias as well as the position, or open the Simulator and set the bias to zero.',
      actions: [
        { kind: 'variant', variant: 'estimate-bias', label: 'Let the solver estimate the bias' },
        { kind: 'simulator', set: 'no-bias', label: 'Open in the Simulator with no bias' },
      ],
    },
  },
  {
    id: 'single-sight',
    group: 6,
    title: 'One sight',
    summary:
      'One measured height of one star puts you on a circle about 2,700 nautical miles in radius, centred where that star is overhead. ' +
      'It cannot say where on the circle, so the honest answer is no position at all.',
    lookAt: 'A circle and no fix. The answer key sits somewhere on it; the sight alone cannot say where.',
    next: {
      text: 'Add a second star and the circles cross, but in two places.',
      actions: [{ kind: 'story', story: 'two-sight-ambiguous', label: 'Next: two sights' }],
    },
  },
  {
    id: 'two-sight-ambiguous',
    group: 6,
    title: 'Two sights',
    summary:
      'Two stars 90° apart in bearing give two circles that cross twice, thousands of kilometres apart. ' +
      'Both crossings fit the sights exactly, so both are reported and neither is preferred.',
    lookAt: 'Two candidates drawn the same way. One is the truth; nothing in the two sights says which.',
    fitMap: true,
    next: {
      text: 'Add a third star in another direction: its circle passes through only one of the crossings.',
      actions: [{ kind: 'variant', variant: 'third-star', label: 'Add a third star' }],
    },
  },
];

export function storyById(id: StoryId): Story {
  const story = STORIES.find((s) => s.id === id);
  if (!story) throw new Error(`no story ${id}`);
  return story;
}

export function groupOf(story: Story): StoryGroup {
  return GROUPS.find((g) => g.n === story.group)!;
}

/**
 * Sentences in a short text, for the "exactly two sentences" rule. A full stop, question
 * mark or exclamation mark followed by a space and a capital (or the end) ends a sentence;
 * "e.g." style abbreviations are not used in the summaries.
 */
export function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).length;
}
