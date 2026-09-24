/**
 * The page side of the offline app (src/pwa/register.ts), with fake service-worker
 * objects: first install, a new version waiting, Reload, another tab updating, the
 * periodic checks, and above all that nothing reloads a page unless the person asks.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_EVERY_MS,
  TAKEOVER_TIMEOUT_MS,
  WAKE_CHECK_AFTER_MS,
  registerServiceWorker,
  serviceWorkerUrl,
  type ContainerLike,
  type PwaEnv,
  type PwaHooks,
  type RegistrationLike,
  type UpdateHandle,
  type WorkerLike,
} from '../src/pwa/register.ts';

class FakeWorker extends EventTarget implements WorkerLike {
  state = 'installing';
  readonly messages: unknown[] = [];
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  become(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  updates = 0;
  async update(): Promise<void> {
    this.updates += 1;
  }
  /** A new worker was found and starts installing. */
  found(worker: FakeWorker): void {
    this.installing = worker;
    this.dispatchEvent(new Event('updatefound'));
  }
  /** It finished installing and waits behind the active worker. */
  installed(worker: FakeWorker): void {
    this.installing = null;
    this.waiting = worker;
    worker.become('installed');
  }
}

class FakeContainer extends EventTarget implements ContainerLike {
  controller: FakeWorker | null = null;
  registered: { url: string; options?: RegistrationOptions } | null = null;
  constructor(readonly registration: FakeRegistration) {
    super();
  }
  async register(url: string, options?: RegistrationOptions): Promise<RegistrationLike> {
    this.registered = { url, options };
    return this.registration;
  }
  /** A worker takes control of this page. */
  control(worker: FakeWorker): void {
    this.controller = worker;
    this.dispatchEvent(new Event('controllerchange'));
  }
}

interface Harness {
  env: PwaEnv;
  container: FakeContainer;
  registration: FakeRegistration;
  reloads: () => number;
  advance(ms: number): void;
  setOnline(on: boolean): void;
  setVisible(on: boolean): void;
  wake(): void;
}

function harness(): Harness {
  const registration = new FakeRegistration();
  const container = new FakeContainer(registration);
  let time = 1_000_000;
  let reloads = 0;
  let online = true;
  let visible = true;
  let timers: { at: number; run: () => void }[] = [];
  const intervals: { every: number; next: number; run: () => void }[] = [];
  const wakers = new Set<() => void>();
  const env: PwaEnv = {
    container,
    reload: () => {
      reloads += 1;
    },
    isOnline: () => online,
    isVisible: () => visible,
    onWake(listener) {
      wakers.add(listener);
      return () => wakers.delete(listener);
    },
    now: () => time,
    setTimeout(run, ms) {
      timers.push({ at: time + ms, run });
    },
    setInterval(run, every) {
      const timer = { every, next: time + every, run };
      intervals.push(timer);
      return () => intervals.splice(intervals.indexOf(timer), 1);
    },
  };
  return {
    env,
    container,
    registration,
    reloads: () => reloads,
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers.map((t) => t.at), ...intervals.map((i) => i.next)].filter((t) => t <= end).sort((a, b) => a - b)[0];
        if (due === undefined) break;
        time = due;
        const ready = timers.filter((t) => t.at <= time);
        timers = timers.filter((t) => t.at > time);
        for (const t of ready) t.run();
        for (const i of intervals.filter((iv) => iv.next <= time)) {
          i.next += i.every;
          i.run();
        }
      }
      time = end;
    },
    setOnline(on) {
      online = on;
    },
    setVisible(on) {
      visible = on;
    },
    wake() {
      for (const w of wakers) w();
    },
  };
}

function hooks(): Required<PwaHooks> & { updates: UpdateHandle[]; elsewhere: (() => void)[]; ready: number } {
  const h = {
    updates: [] as UpdateHandle[],
    elsewhere: [] as (() => void)[],
    ready: 0,
    onUpdateReady(update: UpdateHandle) {
      h.updates.push(update);
    },
    onUpdatedElsewhere(reload: () => void) {
      h.elsewhere.push(reload);
    },
    onOfflineReady() {
      h.ready += 1;
    },
  };
  return h;
}

const SCRIPT = 'https://holdthedoorhoid.github.io/skyfix-lab/sw.js';

/** A returning visit: the page is controlled by an active worker. */
function returning(t: Harness): FakeWorker {
  const active = new FakeWorker();
  active.state = 'activated';
  t.registration.active = active;
  t.container.controller = active;
  return active;
}

describe('registerServiceWorker', () => {
  it('registers the worker with the whole site as its scope', async () => {
    const t = harness();
    await registerServiceWorker(SCRIPT, {}, t.env);
    expect(t.container.registered).toEqual({ url: SCRIPT, options: { scope: 'https://holdthedoorhoid.github.io/skyfix-lab/' } });
  });

  it('first visit: says the site now works offline, offers no update and reloads nothing', async () => {
    const t = harness();
    const h = hooks();
    const first = new FakeWorker();
    t.registration.installing = first;
    await registerServiceWorker(SCRIPT, h, t.env);
    first.become('installed');
    first.become('activating');
    t.registration.installing = null;
    t.registration.active = first;
    t.container.control(first); // clients.claim()
    first.become('activated');
    t.advance(10 * TAKEOVER_TIMEOUT_MS);
    expect(h.ready).toBe(1);
    expect(h.updates).toHaveLength(0);
    expect(h.elsewhere).toHaveLength(0);
    expect(t.reloads()).toBe(0);
  });

  it('a new version found while the page runs: offered, and nothing happens until Reload', async () => {
    const t = harness();
    const h = hooks();
    returning(t);
    await registerServiceWorker(SCRIPT, h, t.env);
    const next = new FakeWorker();
    t.registration.found(next);
    t.registration.installed(next);
    expect(h.updates).toHaveLength(1);
    expect(h.ready).toBe(0);
    // Hours pass: still no reload, no message to the worker.
    t.advance(6 * CHECK_EVERY_MS);
    expect(t.reloads()).toBe(0);
    expect(next.messages).toEqual([]);

    // The person presses Reload.
    h.updates[0]!.apply();
    expect(next.messages).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(t.reloads()).toBe(0);
    t.container.control(next);
    expect(t.reloads()).toBe(1);
  });

  it('Reload still reloads if the new version never takes over', async () => {
    const t = harness();
    const h = hooks();
    returning(t);
    await registerServiceWorker(SCRIPT, h, t.env);
    const next = new FakeWorker();
    t.registration.found(next);
    t.registration.installed(next);
    h.updates[0]!.apply();
    h.updates[0]!.apply(); // pressed twice: one message
    expect(next.messages).toHaveLength(1);
    t.advance(TAKEOVER_TIMEOUT_MS - 1);
    expect(t.reloads()).toBe(0);
    t.advance(1);
    expect(t.reloads()).toBe(1);
  });

  it('a version already waiting when the page opens is offered at once', async () => {
    const t = harness();
    const h = hooks();
    returning(t);
    const waiting = new FakeWorker();
    waiting.state = 'installed';
    t.registration.waiting = waiting;
    await registerServiceWorker(SCRIPT, h, t.env);
    expect(h.updates).toHaveLength(1);
    // The same worker is not offered twice.
    waiting.become('installed');
    expect(h.updates).toHaveLength(1);
  });

  it('a page with no worker behind it (a hard reload) is offered nothing', async () => {
    const t = harness();
    const h = hooks();
    const active = new FakeWorker();
    active.state = 'activated';
    t.registration.active = active; // the site has a worker, but this page bypassed it
    const waiting = new FakeWorker();
    waiting.state = 'installed';
    t.registration.waiting = waiting;
    await registerServiceWorker(SCRIPT, h, t.env);
    expect(h.updates).toHaveLength(0);
    expect(h.ready).toBe(0);
  });

  it('another tab applied the update: this tab is told, not reloaded', async () => {
    const t = harness();
    const h = hooks();
    returning(t);
    await registerServiceWorker(SCRIPT, h, t.env);
    const next = new FakeWorker();
    t.container.control(next);
    t.advance(10 * TAKEOVER_TIMEOUT_MS);
    expect(h.elsewhere).toHaveLength(1);
    expect(t.reloads()).toBe(0);
    h.elsewhere[0]!();
    expect(t.reloads()).toBe(1);
  });

  it('looks for a new version every hour while online and visible', async () => {
    const t = harness();
    returning(t);
    await registerServiceWorker(SCRIPT, {}, t.env);
    t.advance(CHECK_EVERY_MS);
    expect(t.registration.updates).toBe(1);
    t.setOnline(false);
    t.advance(CHECK_EVERY_MS);
    expect(t.registration.updates).toBe(1);
    t.setOnline(true);
    t.setVisible(false);
    t.advance(CHECK_EVERY_MS);
    expect(t.registration.updates).toBe(1);
    t.setVisible(true);
    t.advance(CHECK_EVERY_MS);
    expect(t.registration.updates).toBe(2);
  });

  it('looks again when the page wakes, at most every 15 minutes', async () => {
    const t = harness();
    returning(t);
    await registerServiceWorker(SCRIPT, {}, t.env);
    t.wake();
    expect(t.registration.updates).toBe(0);
    t.advance(WAKE_CHECK_AFTER_MS);
    t.wake();
    expect(t.registration.updates).toBe(1);
    t.wake();
    expect(t.registration.updates).toBe(1);
  });

  it('a failed check is ignored', async () => {
    const t = harness();
    returning(t);
    const failing = vi.fn(() => Promise.reject(new Error('offline')));
    t.registration.update = failing;
    const registered = await registerServiceWorker(SCRIPT, {}, t.env);
    registered.check(true);
    expect(failing).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it('stop() removes every listener', async () => {
    const t = harness();
    const h = hooks();
    returning(t);
    const registered = await registerServiceWorker(SCRIPT, h, t.env);
    registered.stop();
    t.container.control(new FakeWorker());
    t.registration.found(new FakeWorker());
    t.advance(2 * CHECK_EVERY_MS);
    expect(h.elsewhere).toHaveLength(0);
    expect(t.registration.updates).toBe(0);
  });
});

describe('serviceWorkerUrl', () => {
  it('is sw.js at the site root, seen from a built module in assets/', () => {
    expect(serviceWorkerUrl('https://holdthedoorhoid.github.io/skyfix-lab/assets/next-CN04RAD7.js')).toBe(
      'https://holdthedoorhoid.github.io/skyfix-lab/sw.js',
    );
    expect(serviceWorkerUrl('http://localhost:4173/assets/main-PgPQYOOc.js')).toBe('http://localhost:4173/sw.js');
  });
});
