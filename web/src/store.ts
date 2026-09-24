/** Application state and a minimal subscribe/notify store. No framework. */

import type { EphemerisMode, ReduceEntry, Scenario, SkyfixApi } from './api/adapter.js';
import { defaultScenario } from './api/adapter.js';
import { emptySession } from './api/mock.js';
import type { FixResult, Session, SolveOptions, Truth } from './types.js';
import { defaultSolveOptions } from './types.js';

export type ViewId = 'observations' | 'corrections' | 'fix' | 'simulator' | 'planner' | 'about';

export const VIEWS: readonly { id: ViewId; label: string }[] = [
  { id: 'observations', label: 'Observations' },
  { id: 'corrections', label: 'Corrections' },
  { id: 'fix', label: 'Fix' },
  { id: 'simulator', label: 'Simulator' },
  { id: 'planner', label: 'Planner' },
  { id: 'about', label: 'About' },
];

export interface Notice {
  level: 'info' | 'caution' | 'error';
  text: string;
}

export interface SimulationState {
  scenario: Scenario;
  session: Session | null;
  truth: Truth | null;
  fix: FixResult | null;
  error: string | null;
  /** Set when the demo/simulator fell back to the mock generator. */
  usedMock: boolean;
}

export interface AppState {
  view: ViewId;
  session: Session;
  /** Bumped whenever the session is replaced or structurally edited. */
  sessionRevision: number;
  reduced: ReduceEntry[] | null;
  reduceError: string | null;
  /** Which direction source `reduce` and `solve` are told to use. */
  ephemerisMode: EphemerisMode;
  fix: FixResult | null;
  fixError: string | null;
  solveOptions: SolveOptions;
  bodyCatalog: string[];
  coreVersion: string;
  apiNotice: string | null;
  simulation: SimulationState;
  notices: Notice[];
  /** Which demo variant produced the current session, if any. */
  loadedDemo: string | null;
}

export class Store {
  readonly api: SkyfixApi;
  state: AppState;
  private listeners = new Set<() => void>();

  constructor(api: SkyfixApi, initial: Partial<AppState> = {}) {
    this.api = api;
    this.state = {
      view: 'observations',
      session: emptySession('New session'),
      sessionRevision: 0,
      reduced: null,
      reduceError: null,
      ephemerisMode: 'supplied',
      fix: null,
      fixError: null,
      solveOptions: defaultSolveOptions(),
      bodyCatalog: [],
      coreVersion: 'unknown',
      apiNotice: null,
      simulation: {
        scenario: defaultScenario(),
        session: null,
        truth: null,
        fix: null,
        error: null,
        usedMock: false,
      },
      notices: [],
      loadedDemo: null,
      ...initial,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  set(patch: Partial<AppState>, options: { quiet?: boolean } = {}): void {
    this.state = { ...this.state, ...patch };
    if (!options.quiet) this.notify();
  }

  /** Edit the session in place. `quiet` keeps focus in the cell being typed into. */
  editSession(mutate: (session: Session) => void, options: { quiet?: boolean } = {}): void {
    mutate(this.state.session);
    // Any edit invalidates the derived results; never show a fix for a stale session.
    this.state.reduced = null;
    this.state.fix = null;
    this.state.reduceError = null;
    this.state.fixError = null;
    if (!options.quiet) {
      this.state.sessionRevision += 1;
      this.notify();
    }
  }

  replaceSession(session: Session, options: { demo?: string | null } = {}): void {
    this.state.session = session;
    this.state.sessionRevision += 1;
    this.state.reduced = null;
    this.state.fix = null;
    this.state.reduceError = null;
    this.state.fixError = null;
    this.state.loadedDemo = options.demo ?? null;
    this.notify();
  }

  notice(level: Notice['level'], text: string): void {
    this.state.notices = [...this.state.notices.slice(-4), { level, text }];
    this.notify();
  }

  dismissNotices(): void {
    this.state.notices = [];
    this.notify();
  }
}
