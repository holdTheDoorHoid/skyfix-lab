/**
 * DEVELOPER HARNESS for `/next/` — a plain page that exercises the engine, the store and
 * the clock until the real shell (EXPLORER_PLAN work package E2) replaces it. Keep it
 * small and self-contained: nothing outside `harness/` may import from here.
 */

import './harness.css';
import { h } from '../../dom.js';
import { degMin } from '../../format.js';
import { norm180Deg } from '../../geometry.js';
import { disposer, watch, type Component, type Ctx } from '../component.js';
import type { BodyState, DayEvents, SkyState } from '../engine/types.js';
import { goNow, PLAYBACK_SPEEDS, setPlaying, setSpeed, setTime, stepTime, type TimeStep } from '../playback.js';
import {
  currentDayWindow,
  displayZone,
  engineObserver,
  eventOptions,
  shallowEqual,
  shareUrl,
  type AngleFormat,
  type ExplorerState,
  type Theme,
} from '../state.js';
import {
  browserZone,
  formatDateTime,
  formatHours,
  formatTime,
  formatWithUtc,
  isValidIanaZone,
  jdFromWallClock,
  periodWindow,
  wallClock,
  zoneLabel,
  type ZoneChoice,
} from '../time.js';

const BANNER = 'Simulation and analysis workbench. Not a navigation instrument.';

const PLACES: { label: string; lat: number; lon: number; zone: string }[] = [
  { label: 'Philadelphia City Hall', lat: 39.9526, lon: -75.1652, zone: 'America/New_York' },
  { label: 'Greenwich', lat: 51.4779, lon: -0.0015, zone: 'Europe/London' },
  { label: 'Sydney', lat: -33.8568, lon: 151.2153, zone: 'Australia/Sydney' },
  { label: 'Quito', lat: -0.1807, lon: -78.4678, zone: 'America/Guayaquil' },
  { label: 'Tromsø (midnight Sun, polar night)', lat: 69.6492, lon: 18.9553, zone: 'Europe/Oslo' },
];

const STEPS: { label: string; step: TimeStep }[] = [
  { label: '−1 day', step: { unit: 'day', count: -1 } },
  { label: '−1 h', step: { unit: 'hour', count: -1 } },
  { label: '−10 min', step: { unit: 'minute', count: -10 } },
  { label: '+10 min', step: { unit: 'minute', count: 10 } },
  { label: '+1 h', step: { unit: 'hour', count: 1 } },
  { label: '+1 day', step: { unit: 'day', count: 1 } },
];

function angle(value: number | null | undefined, format: AngleFormat, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return format === 'decimal' ? `${value.toFixed(digits + 1)}°` : degMin(value, digits);
}

/** A direction in [0, 360) that never rounds up to 360 on screen. */
function direction(value: number, format: AngleFormat): string {
  const half = format === 'decimal' ? 0.005 : 0.05 / 60;
  return angle(value >= 360 - half ? 0 : value, format);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Engine call with the failure shown as one keyed notice instead of an exception. */
function attempt<T>(ctx: Ctx, key: string, what: string, fn: () => T): T | null {
  try {
    const value = fn();
    ctx.notices.dismissKey(key);
    return value;
  } catch (error) {
    ctx.notices.push('error', `${what}: ${errorText(error)}`, { key });
    return null;
  }
}

function section(title: string, ...children: (Node | string)[]): HTMLElement {
  return h('section', { class: 'hx-section' }, h('h2', {}, title), ...children);
}

export const harness: Component = (host, ctx) => {
  const { store, engine, notices } = ctx;
  const d = disposer();
  const root = h('div', { class: 'hx' });
  host.replaceChildren(root);
  d.add(() => root.remove());

  // --- header: honesty banner, engine, notices -------------------------------------
  const noticeList = h('ul', { class: 'hx-notices', 'aria-live': 'polite' });
  root.append(
    h('p', { class: 'hx-banner', role: 'note' }, BANNER),
    h('h1', {}, 'SkyFix Lab explorer · developer harness'),
    h(
      'p',
      { class: `hx-engine hx-engine-${engine.kind}` },
      h('strong', {}, engine.kind === 'mock' ? '△ MOCK engine' : '■ WASM core'),
      ' ',
      engine.description,
    ),
    noticeList,
  );
  const renderNotices = (): void => {
    noticeList.replaceChildren(
      ...notices.list().map((n) =>
        h(
          'li',
          { class: `hx-notice hx-${n.level}` },
          h('span', {}, n.text),
          n.persistent
            ? null
            : (() => {
                const b = h('button', { type: 'button' }, 'Dismiss');
                b.addEventListener('click', () => notices.dismiss(n.id));
                return b;
              })(),
        ),
      ),
    );
  };
  renderNotices();
  d.add(notices.subscribe(renderNotices));

  // --- place -------------------------------------------------------------------------
  const lat = h('input', { type: 'number', step: 'any', min: -90, max: 90, id: 'hx-lat' });
  const lon = h('input', { type: 'number', step: 'any', min: -180, max: 180, id: 'hx-lon' });
  const height = h('input', { type: 'number', step: 'any', id: 'hx-height' });
  const label = h('input', { type: 'text', id: 'hx-label' });
  const zone = h('select', { id: 'hx-zone' });
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [browserZone()];
  zone.append(
    h('option', { value: 'nautical' }, 'Nautical zone time (from longitude)'),
    h('option', { value: 'utc' }, 'UTC'),
    ...zones.map((z) => h('option', { value: `iana:${z}` }, z)),
  );
  const applyPlace = (): void => {
    const la = Number(lat.value);
    const lo = Number(lon.value);
    if (!Number.isFinite(la) || la < -90 || la > 90 || !Number.isFinite(lo)) {
      notices.push('caution', 'Latitude must be between -90 and 90 and longitude a number.', { key: 'hx-place' });
      return;
    }
    notices.dismissKey('hx-place');
    const hm = Number(height.value);
    store.patch({
      observer: {
        lat_deg: la,
        lon_deg: norm180Deg(lo),
        height_m: Number.isFinite(hm) ? hm : 0,
        label: label.value.trim(),
      },
    });
  };
  for (const input of [lat, lon, height, label]) input.addEventListener('change', applyPlace);
  zone.addEventListener('change', () => {
    const v = zone.value;
    const choice: ZoneChoice =
      v === 'utc' ? { kind: 'utc' } : v === 'nautical' ? { kind: 'nautical' } : { kind: 'iana', zone: v.slice(5) };
    store.patch({ observer: { zone: choice } });
  });
  const presets = h('p', { class: 'hx-row' }, 'Quick places: ');
  for (const p of PLACES) {
    const b = h('button', { type: 'button' }, p.label);
    b.addEventListener('click', () =>
      store.patch({
        observer: { lat_deg: p.lat, lon_deg: p.lon, height_m: 0, label: p.label, zone: { kind: 'iana', zone: p.zone } },
      }),
    );
    presets.append(b);
  }
  const field = (text: string, control: HTMLElement): HTMLElement =>
    h('label', { class: 'hx-field' }, h('span', {}, text), control);
  root.append(
    section(
      'Place',
      h(
        'div',
        { class: 'hx-grid' },
        field('Latitude (°, north +)', lat),
        field('Longitude (°, east +)', lon),
        field('Height above the ellipsoid (m)', height),
        field('Name', label),
        field('Time zone', zone),
      ),
      presets,
      h('p', { class: 'hx-note' }, 'The place is never saved or put in the address bar. Only “Make a share link” writes it into a link.'),
    ),
  );
  d.add(
    watch(ctx, (s) => s.observer, (o) => {
      if (document.activeElement !== lat) lat.value = String(o.lat_deg);
      if (document.activeElement !== lon) lon.value = String(o.lon_deg);
      if (document.activeElement !== height) height.value = String(o.height_m);
      if (document.activeElement !== label) label.value = o.label;
      const wanted = o.zone.kind === 'iana' ? `iana:${o.zone.zone}` : o.zone.kind;
      // Browsers list some zones under older names (Asia/Calcutta for Asia/Kolkata).
      if (o.zone.kind === 'iana' && isValidIanaZone(o.zone.zone) && ![...zone.options].some((x) => x.value === wanted)) {
        zone.append(h('option', { value: wanted }, o.zone.zone));
      }
      zone.value = wanted;
      if (o.zone.kind === 'iana' && !isValidIanaZone(o.zone.zone)) zone.value = 'utc';
    }),
  );

  // --- time ---------------------------------------------------------------------------
  const when = h('input', { type: 'datetime-local', step: 1, id: 'hx-when' });
  const clock = h('output', { class: 'hx-clock', for: 'hx-when' });
  const play = h('button', { type: 'button', class: 'hx-play' }, 'Play');
  const speed = h('select', { id: 'hx-speed' });
  speed.append(...PLAYBACK_SPEEDS.map((s) => h('option', { value: s.speed }, s.label)));
  const primary = h('select', { id: 'hx-primary' });
  primary.append(h('option', { value: 'local' }, 'Local time first'), h('option', { value: 'utc' }, 'UTC first'));
  const horizon = h('select', { id: 'hx-horizon' });
  horizon.append(
    h('option', { value: 'standard' }, 'Sea-level horizon'),
    h('option', { value: 'dip' }, 'Dipped horizon (height of eye)'),
  );
  const eye = h('input', { type: 'number', step: 'any', min: 0, id: 'hx-eye' });
  const theme = h('select', { id: 'hx-theme' });
  theme.append(
    h('option', { value: 'light' }, 'Light'),
    h('option', { value: 'dark' }, 'Dark'),
    h('option', { value: 'night' }, 'Red night vision'),
  );
  const angles = h('select', { id: 'hx-angles' });
  angles.append(h('option', { value: 'dm' }, '39° 57.2′'), h('option', { value: 'decimal' }, '39.95°'));

  when.addEventListener('change', () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(when.value);
    if (!m) return;
    const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(m[i])) as [number, number, number, number, number];
    const zoneNow = displayZone(store.get());
    setTime(store, jdFromWallClock({ year, month, day, hour, minute, second: Number(m[6] ?? 0) }, zoneNow));
  });
  play.addEventListener('click', () => setPlaying(store, !store.get().time.playing));
  speed.addEventListener('change', () => setSpeed(store, Number(speed.value)));
  primary.addEventListener('change', () =>
    store.patch({ settings: { timeDisplay: primary.value === 'utc' ? 'utc' : 'local' } }),
  );
  horizon.addEventListener('change', () =>
    store.patch({ settings: { horizon: horizon.value === 'dip' ? 'dip' : 'standard' } }),
  );
  eye.addEventListener('change', () => {
    const v = Number(eye.value);
    if (Number.isFinite(v) && v >= 0) store.patch({ settings: { height_of_eye_m: v } });
  });
  theme.addEventListener('change', () => store.patch({ settings: { theme: theme.value as Theme } }));
  angles.addEventListener('change', () =>
    store.patch({ settings: { angleFormat: angles.value === 'decimal' ? 'decimal' : 'dm' } }),
  );

  const nowButton = h('button', { type: 'button' }, 'Now');
  nowButton.addEventListener('click', () => goNow(store));
  const stepButtons = STEPS.map(({ label: text, step }) => {
    const b = h('button', { type: 'button' }, text);
    b.addEventListener('click', () => stepTime(store, step));
    return b;
  });
  root.append(
    section(
      'Time',
      h('div', { class: 'hx-grid' }, field('Date and time (display zone)', when), field('Speed', speed), field('Show', primary)),
      h('p', { class: 'hx-row' }, ...stepButtons.slice(0, 3), nowButton, ...stepButtons.slice(3), play),
      clock,
      h(
        'p',
        { class: 'hx-note' },
        'Keys: ←/→ 10 min · Shift ±1 h · Alt ±1 day · PgUp/PgDn ±1 month (Shift: year) · Space play/pause · N now.',
      ),
      h(
        'div',
        { class: 'hx-grid' },
        field('Rise/set horizon', horizon),
        field('Height of eye (m)', eye),
        field('Theme', theme),
        field('Angles', angles),
      ),
    ),
  );
  d.add(
    watch(
      ctx,
      (s) => [s.time, s.settings, s.observer.zone, s.observer.lon_deg] as const,
      ([time, settings]) => {
        const state = store.get();
        const z = displayZone(state);
        const w = wallClock(time.jd_utc, z);
        const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
        if (document.activeElement !== when && w.year >= 1 && w.year <= 9999) {
          when.value = `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
        }
        clock.textContent = `${formatWithUtc(time.jd_utc, z, { seconds: true })} · ${zoneLabel(time.jd_utc, z)}${
          time.live ? ' · following the clock' : ''
        }`;
        play.textContent = time.playing ? 'Pause' : 'Play';
        play.setAttribute('aria-pressed', String(time.playing));
        speed.value = String(time.speed);
        primary.value = settings.timeDisplay;
        horizon.value = settings.horizon;
        if (document.activeElement !== eye) eye.value = String(settings.height_of_eye_m);
        theme.value = settings.theme;
        angles.value = settings.angleFormat === 'decimal' ? 'decimal' : 'dm';
        document.documentElement.dataset.theme = settings.theme;
      },
      { equals: shallowEqual },
    ),
  );

  // --- the sky now --------------------------------------------------------------------
  const skySummary = h('p', { class: 'hx-summary' });
  const skyBody = h('tbody');
  root.append(
    section(
      'The sky now',
      skySummary,
      h(
        'div',
        { class: 'hx-scroll' },
        h(
          'table',
          { class: 'hx-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ...[
                'Body',
                'Up?',
                'Height above horizon',
                'Direction (true)',
                'GHA',
                'Declination',
                'Magnitude',
                'Lit',
                'Constellation',
              ].map((t) => h('th', { scope: 'col' }, t)),
            ),
          ),
          skyBody,
        ),
      ),
      h('p', { class: 'hx-note' }, 'Height and direction are what the eye sees (topocentric, with refraction). Click a body to select it.'),
    ),
  );
  const row = (b: BodyState, s: ExplorerState): HTMLTableRowElement => {
    const f = s.settings.angleFormat;
    const pick = h('button', { type: 'button', class: 'hx-pick', 'aria-pressed': String(s.selection.body === b.body) }, b.body);
    pick.addEventListener('click', () => store.patch({ selection: { body: b.body } }));
    return h(
      'tr',
      { class: `${b.above_horizon ? 'hx-up' : 'hx-down'}${s.selection.body === b.body ? ' hx-selected' : ''}` },
      h('th', { scope: 'row' }, pick, h('span', { class: 'hx-kind' }, ` ${b.kind}`)),
      h('td', {}, b.above_horizon ? 'up' : 'down'),
      h('td', { class: 'hx-num' }, angle(b.alt_apparent_deg, f)),
      h('td', { class: 'hx-num' }, direction(b.az_deg, f)),
      h('td', { class: 'hx-num' }, angle(b.gha_deg, f)),
      h('td', { class: 'hx-num' }, angle(b.dec_deg, f)),
      h('td', { class: 'hx-num' }, b.magnitude === null ? '—' : b.magnitude.toFixed(1)),
      h('td', { class: 'hx-num' }, b.illuminated_fraction === null ? '—' : `${Math.round(b.illuminated_fraction * 100)} %`),
      h('td', {}, b.constellation ?? '—'),
    );
  };
  d.add(
    watch(
      ctx,
      (s) => [s.observer, s.time.jd_utc, s.selection.body, s.settings.angleFormat] as const,
      () => {
        const s = store.get();
        const sky: SkyState | null = attempt(ctx, 'hx-sky', 'sky_state', () =>
          engine.skyState(engineObserver(s), s.time.jd_utc, 'all'),
        );
        if (!sky) return;
        skySummary.textContent =
          `Sky: ${sky.sky_phase} · Sun ${angle(sky.sun_altitude_deg, s.settings.angleFormat)} above the horizon · ` +
          `GHA Aries ${angle(sky.gha_aries_deg, s.settings.angleFormat)}` +
          (sky.errors.length ? ` · not computed: ${sky.errors.map((e) => `${e.body} (${e.message})`).join('; ')}` : '');
        skyBody.replaceChildren(...sky.bodies.map((b) => row(b, s)));
      },
      { equals: shallowEqual },
    ),
  );

  // --- today at this place --------------------------------------------------------------
  const today = h('div', { class: 'hx-today' });
  root.append(section('Today at this place', today));
  d.add(
    watch(
      ctx,
      (s) => {
        const [a, b] = currentDayWindow(s);
        return [s.observer, a, b, s.selection.body, s.settings.horizon, s.settings.height_of_eye_m, s.settings.timeDisplay] as const;
      },
      () => {
        const s = store.get();
        const z = displayZone(s);
        const [a, b] = currentDayWindow(s);
        const bodies = [...new Set(['Sun', 'Moon', s.selection.body ?? 'Sun'])];
        const day: DayEvents | null = attempt(ctx, 'hx-day', 'day_events', () =>
          engine.dayEvents(engineObserver(s), a, b, bodies, eventOptions(s)),
        );
        if (!day) return;
        const phaseList = h(
          'ol',
          { class: 'hx-list' },
          ...day.phases.map((p) =>
            h(
              'li',
              {},
              `${formatTime(p.jd_start, z)}–${p.jd_end === day.jd_end ? '24:00' : formatTime(p.jd_end, z)} `,
              h('strong', {}, p.phase),
            ),
          ),
        );
        const bodyBlocks = day.bodies.map((be) =>
          h(
            'div',
            { class: 'hx-events' },
            h(
              'h3',
              {},
              be.body,
              be.always_above ? ' · above the horizon all day' : '',
              be.always_below ? ' · below the horizon all day' : '',
              be.day_length_h !== null ? ` · daylight ${formatHours(be.day_length_h)}` : '',
            ),
            h(
              'ul',
              { class: 'hx-list' },
              ...be.events.map((e) =>
                h(
                  'li',
                  {},
                  h('strong', {}, e.kind.replaceAll('_', ' ')),
                  ` ${formatWithUtc(e.jd_utc, z)} · direction ${direction(e.az_deg, s.settings.angleFormat)}`,
                ),
              ),
            ),
          ),
        );
        const errors = day.errors.map((e) => h('p', { class: 'hx-note' }, `${e.body}: ${e.message}`));
        today.replaceChildren(
          h('p', { class: 'hx-note' }, `${formatDateTime(a, z)} to ${formatDateTime(b, z)} (${zoneLabel(a, z)})`),
          h('h3', {}, 'Sky phases'),
          phaseList,
          ...bodyBlocks,
          ...errors,
        );
      },
      { equals: shallowEqual },
    ),
  );

  // --- the Moon's month and the year's seasons ----------------------------------------
  const calendar = h('div', { class: 'hx-today' });
  root.append(section('This month’s Moon phases and this year’s seasons', calendar));
  d.add(
    watch(
      ctx,
      (s) => {
        const [a, b] = periodWindow(s.time.jd_utc, displayZone(s), 'month');
        return [a, b, wallClock(s.time.jd_utc, displayZone(s)).year, s.settings.timeDisplay] as const;
      },
      ([a, b, year]) => {
        const z = displayZone(store.get());
        const phases = attempt(ctx, 'hx-moon', 'moon_phases', () => engine.moonPhases(a, b)) ?? [];
        const seasons = attempt(ctx, 'hx-seasons', 'seasons', () => engine.seasons(year)) ?? [];
        calendar.replaceChildren(
          h('ul', { class: 'hx-list' }, ...phases.map((p) => h('li', {}, h('strong', {}, p.kind.replaceAll('_', ' ')), ` ${formatWithUtc(p.jd_utc, z)}`))),
          h('ul', { class: 'hx-list' }, ...seasons.map((p) => h('li', {}, h('strong', {}, p.kind.replaceAll('_', ' ')), ` ${formatWithUtc(p.jd_utc, z)}`))),
        );
      },
      { equals: shallowEqual },
    ),
  );

  // --- engine coverage ----------------------------------------------------------------
  const coverage = attempt(ctx, 'hx-coverage', 'explorer_coverage', () => engine.coverage());
  if (coverage) {
    root.append(
      section(
        'Engine coverage',
        h('p', { class: 'hx-note' }, `${coverage.start_utc} to ${coverage.end_utc}`),
        h(
          'table',
          { class: 'hx-table' },
          h('thead', {}, h('tr', {}, ...['Group', 'Provider', 'Accuracy', 'Validated', 'Notes'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            {},
            ...coverage.groups.map((g) =>
              h(
                'tr',
                {},
                h('th', { scope: 'row' }, g.name),
                h('td', {}, g.provider),
                h('td', { class: 'hx-num' }, g.accuracy_arcmin === null ? '—' : `${g.accuracy_arcmin}′`),
                h('td', {}, g.validated ? 'yes' : 'no'),
                h('td', {}, g.notes),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // --- share (explicit action only) ------------------------------------------------------
  const includePlace = h('input', { type: 'checkbox', checked: true, id: 'hx-share-place' });
  const shareOut = h('input', { type: 'text', readonly: true, class: 'hx-share', 'aria-label': 'Share link' });
  const shareButton = h('button', { type: 'button' }, 'Make a share link');
  shareButton.addEventListener('click', () => {
    shareOut.value = shareUrl(store.get(), globalThis.location.href, { place: includePlace.checked });
    shareOut.focus();
    shareOut.select();
  });
  root.append(
    section(
      'Share',
      h('p', { class: 'hx-row' }, shareButton, h('label', { class: 'hx-check' }, includePlace, ' include the place')),
      shareOut,
      h('p', { class: 'hx-note' }, 'The link is only shown here; the address bar is not changed and nothing is sent anywhere.'),
    ),
  );

  return { destroy: () => d.dispose() };
};
