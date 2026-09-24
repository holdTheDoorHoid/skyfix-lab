/**
 * The Learn view's own state and the services its tabs share. OWNER: learn agent.
 *
 * The explorer's store (place, time, selection, settings) is read only for the person's
 * units and angle format; everything about demonstrations and the Simulator lives here,
 * in a small store of its own, and is kept for the page's lifetime so leaving Learn and
 * coming back finds the last run where it was.
 */

import type { DemoEntry, ExperimentSummary, Scenario } from '../../api/adapter.js';
import type { Ctx } from '../component.js';
import type { Store } from '../state.js';
import type { ApiHandle } from './api.js';
import type { ChartView } from './chart-model.js';
import type { Fmt } from './facts.js';
import type { FigureEnv } from './result.js';
import type { Run, SolverChoices } from './run.js';
import type { SimulatorPreset, StoryId, VariantId } from './stories.js';

export type Tab = 'primer' | 'stories' | 'simulator';
export const TABS: readonly Tab[] = ['primer', 'stories', 'simulator'];

export interface StoryRunState {
  id: StoryId;
  variant: VariantId | null;
  status: 'running' | 'done' | 'error';
  run: Run | null;
  error: string | null;
  /** Bring the result into view when it arrives (the list and the result are stacked). */
  scroll: boolean;
}

export interface SimState {
  /** The scenario being edited (a copy; the packaged demos are never changed). */
  scenario: Scenario | null;
  /** Which packaged demo it started from. */
  source: string | null;
  choices: SolverChoices;
  repetitions: number;
  runStatus: 'idle' | 'running';
  run: Run | null;
  runError: string | null;
  expStatus: 'idle' | 'running';
  summary: ExperimentSummary | null;
  /** The scenario and choices the summary was run with. */
  summaryScenario: Scenario | null;
  expError: string | null;
  /** Bumped when the editor must be rebuilt (a scenario loaded, a structural change). */
  editorVersion: number;
}

export interface LearnState {
  tab: Tab;
  story: StoryRunState | null;
  /** The last picture chosen (close-up or globe), carried from run to run. */
  chartView: ChartView | null;
  sim: SimState;
}

export interface SimulatorRequest {
  /** Start from this packaged story's scenario. */
  story?: StoryId;
  /** …or from this scenario. */
  scenario?: Scenario;
  preset?: SimulatorPreset | null;
  /** Generate and solve at once. */
  run?: boolean;
  /** Run the coverage experiment at once, with this many repetitions. */
  experiment?: number;
}

export interface LearnEnv {
  readonly ctx: Ctx;
  readonly state: Store<LearnState>;
  api(): Promise<ApiHandle>;
  demos(): Promise<readonly DemoEntry[]>;
  fmt(): Fmt;
  onFmtChange(listener: () => void): () => void;
  figureEnv(title: string): FigureEnv;
  /** "WebAssembly core" or "mock adapter", for the numbers' provenance. */
  engineLabel(): string;
  runStory(id: StoryId, variant: VariantId | null, options?: { scroll?: boolean }): Promise<void>;
  openSimulator(request: SimulatorRequest): Promise<void>;
  selectTab(tab: Tab): void;
  /** Mark the view as settled (for the developer page's screenshots). */
  markReady(): void;
  /** Scroll an element into view when the layout is stacked. */
  reveal(el: HTMLElement): void;
}

export const DEFAULT_REPETITIONS = 50;

export function initialSim(): SimState {
  return {
    scenario: null,
    source: null,
    choices: { robust: false, estimateBias: false },
    repetitions: DEFAULT_REPETITIONS,
    runStatus: 'idle',
    run: null,
    runError: null,
    expStatus: 'idle',
    summary: null,
    summaryScenario: null,
    expError: null,
    editorVersion: 0,
  };
}
