/**
 * The Demonstrations tab: the ten packaged scenarios as story cards, and the result of the
 * one last run. OWNER: learn agent.
 *
 * "Run it" simulates with the core and solves the session alone (run.ts); the result
 * panel then shows the kind of answer, how far it is from the answer key against what it
 * claims, the picture, what happened and why, and what to try next.
 */

import { h } from '../../dom.js';
import { button, icon } from '../theme/index.js';
import type { LearnEnv, StoryRunState } from './env.js';
import { explain, keyNumber } from './explain.js';
import { factsOf } from './facts.js';
import { answerKey, correctionTable, figure, kindChip, numbersList, residualChart, simulatedBadge, tiles, warningsList, type Figure } from './result.js';
import { VARIANTS } from './run.js';
import { GROUPS, STORIES, groupOf, storyById, type Story, type StoryId, type TryAction } from './stories.js';

export interface StoriesTab {
  el: HTMLElement;
  destroy(): void;
}

function storyCard(env: LearnEnv, story: Story): HTMLElement {
  const titleId = `sfl-story-${story.id}`;
  const run = button({
    label: 'Run it',
    icon: 'play',
    size: 'sm',
    variant: 'primary',
    attrs: { 'aria-label': `Run it: ${story.title}`, 'data-run': story.id },
    onClick: () => void env.runStory(story.id, null, { scroll: true }),
  });
  return h(
    'article',
    { class: 'sfl-story', 'data-story': story.id, 'aria-labelledby': titleId },
    h('h3', { class: 'sfl-story__title', id: titleId }, story.title),
    h('p', { class: 'sfl-story__summary' }, story.summary),
    h('div', { class: 'sfl-story__foot' }, run, h('code', { class: 'sfl-story__name', 'data-tip': 'The scenario’s name in the command-line tool and docs/DEMOS.md' }, story.id)),
  );
}

function storyList(env: LearnEnv): HTMLElement {
  const groups = GROUPS.map((g) =>
    h(
      'section',
      { class: 'sfl-group', 'aria-labelledby': `sfl-group-${g.n}` },
      h('h2', { class: 'sfl-group__title', id: `sfl-group-${g.n}` }, h('span', { class: 'sfl-group__n', 'aria-hidden': 'true' }, String(g.n)), g.title),
      h('p', { class: 'sfl-group__line' }, g.line),
      ...STORIES.filter((s) => s.group === g.n).map((s) => storyCard(env, s)),
    ),
  );
  return h('nav', { class: 'sfl-list', 'aria-label': 'Demonstrations' }, ...groups);
}

function welcome(env: LearnEnv): HTMLElement {
  return h(
    'section',
    { class: 'sfl-result sfl-result--welcome', 'aria-label': 'How to use the demonstrations' },
    h('p', { class: 'sfl-eyebrow' }, 'Ten worked demonstrations'),
    h('h2', { class: 'sfl-h2' }, 'Run one, and compare the answer with the truth'),
    h(
      'p',
      { class: 'sfl-lede' },
      'Each demonstration generates star sights for an observer whose position is known, hands the sights, and only the sights, to the solver, and then compares its answer with the truth. ' +
        'The truth is the answer key: you see it, the solver never does.',
    ),
    h(
      'ol',
      { class: 'sfl-steps' },
      h('li', {}, h('strong', {}, 'What kind of answer? '), 'A unique fix, two equally good answers, a circle with no point, or a failure. The tool always says which.'),
      h('li', {}, h('strong', {}, 'How far off, against what it claims? '), 'The distance to the answer key beside the uncertainty the fix reports, and whether the truth falls inside its 95 % ellipse.'),
      h('li', {}, h('strong', {}, 'Why? '), 'A short explanation with the number that matters, and something to try next.'),
    ),
    h(
      'div',
      { class: 'sfl-actions' },
      button({ label: 'Run the first one: a healthy fix', icon: 'play', variant: 'primary', onClick: () => void env.runStory('philadelphia-stars', null) }),
      button({ label: 'New to this? How it works', icon: 'learn', variant: 'outline', onClick: () => env.selectTab('primer') }),
    ),
  );
}

function actionButton(env: LearnEnv, story: Story, action: TryAction): HTMLElement {
  switch (action.kind) {
    case 'variant':
      return button({ label: action.label, icon: 'play', variant: 'primary', size: 'sm', onClick: () => void env.runStory(story.id, action.variant) });
    case 'story':
      return button({ label: action.label, icon: 'chevron-right', variant: 'outline', size: 'sm', onClick: () => void env.runStory(action.story, null, { scroll: true }) });
    case 'experiment':
      return button({
        label: action.label,
        icon: 'speed',
        variant: 'outline',
        size: 'sm',
        tip: 'Opens the Simulator with this scenario and runs the coverage experiment',
        onClick: () => void env.openSimulator({ story: story.id, experiment: action.repetitions }),
      });
    case 'simulator':
      return button({
        label: action.label,
        icon: 'settings',
        variant: 'outline',
        size: 'sm',
        onClick: () => void env.openSimulator({ story: story.id, preset: action.set ?? null, run: true }),
      });
  }
}

function running(story: Story): HTMLElement {
  return h(
    'section',
    { class: 'sfl-result sfl-result--busy', 'aria-busy': 'true' },
    h('p', { class: 'sfl-eyebrow' }, `Demonstration ${story.group} · ${groupOf(story).title}`),
    h('h2', { class: 'sfl-h2' }, story.title),
    h('p', { class: 'sfl-muted' }, 'Simulating the sights and solving…'),
  );
}

function failed(env: LearnEnv, story: Story, message: string): HTMLElement {
  return h(
    'section',
    { class: 'sfl-result' },
    h('p', { class: 'sfl-eyebrow' }, `Demonstration ${story.group} · ${groupOf(story).title}`),
    h('h2', { class: 'sfl-h2' }, story.title),
    h('div', { class: 'sf-notice sf-notice--error', role: 'alert' }, icon('caution'), h('span', {}, message)),
    h('div', { class: 'sfl-actions' }, button({ label: 'Try again', icon: 'play', size: 'sm', onClick: () => void env.runStory(story.id, null) })),
  );
}

/** The full result of a story run. */
function storyResult(env: LearnEnv, st: StoryRunState): { el: HTMLElement; fig: Figure | null } {
  const story = storyById(st.id);
  const run = st.run!;
  const fmt = env.fmt();
  const facts = factsOf(run.result, run.truth.position);
  const key = keyNumber(story.id, run, facts, fmt);
  const why = explain(story.id, run, facts, fmt);
  const variant = run.variant ? VARIANTS[run.variant] : null;

  const fig = figure(run.result, run.truth, env.figureEnv(`${story.title}`), {
    view: env.state.get().chartView,
    onView: (v) => env.state.patch({ chartView: v }),
    lookAt: story.lookAt,
    title: story.title,
  });

  const badges = h('div', { class: 'sfl-result__badges' }, kindChip(run.result), simulatedBadge());
  if (variant) badges.append(h('span', { class: 'sfl-variant' }, icon('edit'), variant.label));

  const nextActions = story.next.actions.filter((a) => !(a.kind === 'variant' && a.variant === run.variant)).map((a) => actionButton(env, story, a));
  if (variant) {
    nextActions.unshift(button({ label: 'Run the original again', icon: 'play', variant: 'primary', size: 'sm', onClick: () => void env.runStory(story.id, null) }));
  }

  const rawReadings = run.reduced && run.reduced.length ? correctionTable(run.reduced) : null;
  const el = h(
    'section',
    { class: 'sfl-result', 'aria-labelledby': 'sfl-result-title', 'data-story': story.id, 'data-kind': run.result.kind },
    h(
      'header',
      { class: 'sfl-result__head' },
      h('div', {}, h('p', { class: 'sfl-eyebrow' }, `Demonstration ${story.group} · ${groupOf(story).title}`), h('h2', { class: 'sfl-h2', id: 'sfl-result-title' }, story.title)),
      badges,
    ),
    variant ? h('p', { class: 'sfl-variant-note' }, h('strong', {}, 'Changed: '), variant.describe) : null,
    h('div', { class: 'sfl-hero' }, h('div', { class: 'sfl-hero__value sf-num' }, key.value), h('div', { class: 'sfl-hero__caption' }, key.caption)),
    tiles(facts, fmt),
    fig.el,
    h(
      'div',
      { class: 'sfl-explain' },
      h('h3', { class: 'sfl-h3' }, 'What happened'),
      ...why.happened.map((p) => h('p', {}, p)),
      h('h3', { class: 'sfl-h3' }, 'Why'),
      ...why.why.map((p) => h('p', {}, p)),
    ),
    warningsList(run.result.warnings),
    facts.kind === 'unique' ? residualChart(facts) : null,
    rawReadings,
    h(
      'div',
      { class: 'sfl-next' },
      h('h3', { class: 'sfl-h3' }, icon('chevron-right'), 'What to try next'),
      h('p', {}, story.next.text),
      h('div', { class: 'sfl-actions' }, ...nextActions),
    ),
    h(
      'details',
      { class: 'sfl-more' },
      h('summary', {}, 'All the numbers'),
      numbersList(run.result, facts, fmt),
      answerKey(run.truth, fmt),
      run.session.meta.notes ? h('p', { class: 'sfl-muted' }, h('strong', {}, 'Session notes: '), run.session.meta.notes) : null,
      h('p', { class: 'sfl-muted' }, `${run.session.observations.length} sights simulated and solved by the ${env.engineLabel()} in ${run.ms.toFixed(0)} ms.`),
    ),
  );
  return { el, fig };
}

export function storiesTab(env: LearnEnv): StoriesTab {
  const list = storyList(env);
  const main = h('div', { class: 'sfl-stage', id: 'sfl-story-result', tabindex: '-1' });
  const status = h('p', { class: 'sf-sr', role: 'status', 'aria-live': 'polite' });
  const el = h('div', { class: 'sfl-stories' }, list, main, status);
  let fig: Figure | null = null;
  let shown: StoryRunState | null | undefined;

  const render = (st: StoryRunState | null): void => {
    if (st === shown) return;
    shown = st;
    for (const card of list.querySelectorAll<HTMLElement>('.sfl-story')) {
      const on = st?.id === card.dataset.story;
      if (on) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
    }
    fig?.destroy();
    fig = null;
    if (!st) {
      main.replaceChildren(welcome(env));
      env.markReady();
      return;
    }
    const story = storyById(st.id);
    if (st.status === 'running') {
      main.replaceChildren(running(story));
      status.textContent = `Running ${story.title}…`;
      return;
    }
    if (st.status === 'error' || !st.run) {
      main.replaceChildren(failed(env, story, st.error ?? 'Something went wrong.'));
      status.textContent = `${story.title}: ${st.error ?? 'failed'}`;
      env.markReady();
      return;
    }
    const built = storyResult(env, st);
    fig = built.fig;
    main.replaceChildren(built.el);
    const facts = factsOf(st.run.result, st.run.truth.position);
    status.textContent = `${story.title}: ${keyNumber(story.id, st.run, facts, env.fmt()).value}, ${keyNumber(story.id, st.run, facts, env.fmt()).caption}.`;
    void built.fig?.ready.then(() => env.markReady());
    if (st.scroll) env.reveal(main);
  };

  const stop = env.state.select((s) => s.story, render, { immediate: true });
  const stopFmt = env.onFmtChange(() => {
    shown = undefined;
    render(env.state.get().story);
  });
  return {
    el,
    destroy: () => {
      stop();
      stopFmt();
      fig?.destroy();
      el.remove();
    },
  };
}

export function storyTitle(id: StoryId): string {
  return storyById(id).title;
}
