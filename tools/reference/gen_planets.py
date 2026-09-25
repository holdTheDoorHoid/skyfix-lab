"""fixtures/reference/planets_<planet>.json -- apparent geocentric planets.

One file per planet, Mercury to Neptune, each with 300+ epochs over 1990-2060:

  * a regular grid across the whole window, with the time of day varying;
  * the events where a planet model is most easily wrong: inferior and superior
    conjunctions and greatest elongations of Mercury and Venus; oppositions and
    conjunctions of Mars to Neptune; stations (the planet turning retrograde or
    direct) of every planet; and, for Saturn, the instants the Earth crosses the
    ring plane (where the ring term of the magnitude switches off).

Everything comes from Skyfield with JPL DE440s, as `earth.at(t).observe(planet)
.apparent()` does it: light-time, gravitational deflection by the Sun, Jupiter and
Saturn, annual aberration from the Earth's barycentric velocity, then precession and
nutation to the true equator and equinox of date (CONVENTIONS section 7). GHA is
Skyfield's GAST minus that RA; `gha_deg_dut1_zero` removes Skyfield's DUT1, which is
the CONVENTIONS section 6 assumption and the column a DUT1 = 0 model is tested on.
DE421 is carried as a cross-check where it covers the epoch (to 2053-10-08).

Two magnitude columns, because Skyfield's `planetary_magnitude` makes one
simplification that matters for Mercury and Venus:

  * `magnitude` is `skyfield.magnitudelib.planetary_magnitude(astrometric)`, the
    public API. It places the Sun at the solar-system barycentre (its source says so),
    which is up to 0.01 au from the Sun's centre; when Mercury is a thin crescent that
    moves its phase angle by degrees and its magnitude by up to 0.2.
  * `magnitude_heliocentric` evaluates the same Mallama & Hilton (2018) formulas --
    Skyfield's own functions, not a re-implementation -- with the real Sun: r the
    Sun-planet distance at the light-time-corrected instant and the phase angle of
    `skyfield.almanac.phase_angle`. That is how Mallama & Hilton define r and alpha.

Run from the repository root:

    tools/reference/.venv/bin/python -m tools.reference.gen_planets \
        [--window 1990..2060] [--kernel de440s]

Instants are on the app's clock with SkyFix Lab's own Delta T (`common.load_timescale`:
UTC to 2035, UT after, CONVENTIONS 15.2), so a case's TT and UT1 are the Rust side's;
outside the validated tier the frame of date is the app's long-term one
(`common.use_app_frame`). Python datetime limits `--window` to years 1-9999.
"""

from __future__ import annotations

import datetime as _dt
import math
import os

import numpy as np

from . import common as c

#: Canonical name, DE440s key, DE421 key.
PLANETS = [
    ("Mercury", "mercury", "mercury"),
    ("Venus", "venus", "venus"),
    ("Mars", "mars barycenter", "mars barycenter"),
    ("Jupiter", "jupiter barycenter", "jupiter barycenter"),
    ("Saturn", "saturn barycenter", "saturn barycenter"),
    ("Uranus", "uranus barycenter", "uranus barycenter"),
    ("Neptune", "neptune barycenter", "neptune barycenter"),
]

#: IAU WGCCRE 2015 equatorial radii, km (Archinal et al. 2018, Celest. Mech. Dyn.
#: Astron. 130:22, table 1). Used for the semidiameter column.
EQUATORIAL_RADIUS_KM = {
    "Mercury": 2440.53,
    "Venus": 6051.8,
    "Mars": 3396.19,
    "Jupiter": 71492.0,
    "Saturn": 60268.0,
    "Uranus": 25559.0,
    "Neptune": 24764.0,
}
#: WGS84 equatorial radius of the Earth, km. Horizontal parallax = asin(a / distance).
EARTH_EQUATORIAL_RADIUS_KM = 6378.137
AU_KM = 149597870.700

#: The window's first and last whole seconds (set from --window by `main`).
START = (1990, 1, 1)
END = (2060, 12, 31, 23, 59, 59)


def _set_window():
    global START, END
    edges = []
    for jd in c.RUN.window:
        y = c.gregorian_from_jd(jd)[0]
        if not 1 <= y <= 9999:
            raise SystemExit("gen_planets uses Python datetime: keep --window within years 1-9999")
        edges.append(_dt.datetime(1970, 1, 1, tzinfo=_dt.timezone.utc)
                     + _dt.timedelta(seconds=round((jd - 2440587.5) * 86400.0)))
    end = edges[1] - _dt.timedelta(seconds=1)
    START = (edges[0].year, edges[0].month, edges[0].day)
    END = (end.year, end.month, end.day, end.hour, end.minute, end.second)

#: Regular-grid epochs and how densely each event list is sampled, per planet.
#: (grid, {event: keep every n-th})
PLAN = {
    "Mercury": (100, {"inferior_conjunction": 2, "superior_conjunction": 8,
                      "greatest_elongation": 10, "station": 10}),
    "Venus": (150, {"inferior_conjunction": 1, "superior_conjunction": 1,
                    "greatest_elongation": 2, "station": 2}),
    "Mars": (190, {"opposition": 1, "conjunction": 1, "station": 1}),
    "Jupiter": (130, {"opposition": 1, "conjunction": 1, "station": 2}),
    "Saturn": (120, {"opposition": 1, "conjunction": 1, "station": 2,
                     "ring_plane_crossing": 1}),
    "Uranus": (120, {"opposition": 1, "conjunction": 1, "station": 2}),
    "Neptune": (120, {"opposition": 1, "conjunction": 1, "station": 2}),
}

#: Skyfield's solar deflection exceeds the limb-grazing 1.75" only when the planet's
#: geometric direction is inside the solar disc (the planet is hidden by the Sun).
LIMB_DEFLECTION_ARCSEC = 1.76

TOLERANCE_ARCMIN = 0.1

FRAME_NOTES = {
    "definition": (
        "Apparent geocentric of date (CONVENTIONS section 7): true equator and equinox "
        "of date."
    ),
    "computed_as": (
        "earth.at(t).observe(planet).apparent().radec(epoch='date'); "
        "GHA = normalise(t.gast * 15 - RA_deg) into [0, 360)."
    ),
    "includes": [
        "light-time (Skyfield iterates to 1e-12 day)",
        "gravitational deflection of light by the Sun, Jupiter and Saturn "
        "(Skyfield's default deflectors)",
        "annual aberration from the Earth's barycentric velocity (relativistic form)",
        "frame bias, IAU 2006 precession and IAU 2000A nutation",
    ],
    "excludes": [
        "polar motion",
        "diurnal aberration and topocentric parallax (geocentric frame)",
        "atmospheric refraction",
    ],
    "target_points": (
        "Mercury and Venus are the planets themselves (DE440s 199, 299). Mars to "
        "Neptune are their system barycentres (4 to 8), which DE440s carries instead "
        "of the planets; the offset is under 0.1 arcsec (Jupiter's Galilean moons)."
    ),
    "gha_sign": "west-positive, [0, 360), as tabulated in the Nautical Almanac",
}


# ---------------------------------------------------------------------------
# Epochs
# ---------------------------------------------------------------------------


def rounded(ts, t):
    """The same instant rounded to a whole UTC second, as a new Time."""
    dt = t.utc_datetime()
    dt = (dt + _dt.timedelta(microseconds=500_000)).replace(microsecond=0)
    return ts.utc(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)


def grid_times(ts, n):
    """n instants spread evenly over the window, centred in their slots, so the
    time of day varies from one to the next."""
    t0 = _dt.datetime(*START, tzinfo=_dt.timezone.utc)
    t1 = _dt.datetime(*END, tzinfo=_dt.timezone.utc)
    span = (t1 - t0).total_seconds()
    out = []
    for i in range(n):
        dt = t0 + _dt.timedelta(seconds=round((i + 0.5) * span / n))
        out.append(ts.utc(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second))
    return out


def events(ts, eph, name, key):
    """{kind: [Time, ...]} for one planet over the window, from DE440s."""
    from skyfield import almanac
    from skyfield.functions import angle_between
    from skyfield.magnitudelib import _SATURN_POLE_2D
    from skyfield.searchlib import find_discrete, find_maxima

    earth, sun, planet = eph["earth"], eph["sun"], eph[key]
    t0 = ts.utc(*START)
    t1 = ts.utc(*END)
    out = {}

    f = almanac.oppositions_conjunctions(eph, planet)
    # Skyfield's default step is 40 days; Mercury's inferior and superior conjunctions
    # can be closer than that, so search finely enough never to step over a pair.
    f.step_days = 10.0
    times, _ = find_discrete(t0, t1, f)
    for t in times:
        e = earth.at(t)
        app = e.observe(planet).apparent()
        elong = e.observe(sun).apparent().separation_from(app).degrees
        if name in ("Mercury", "Venus"):
            kind = "inferior_conjunction" if app.distance().au < 1.0 else "superior_conjunction"
        else:
            kind = "opposition" if elong > 90.0 else "conjunction"
        out.setdefault(kind, []).append(t)

    def direct(t):
        h = 0.05
        lo = earth.at(ts.tt_jd(t.tt - h)).observe(planet).apparent().ecliptic_latlon("date")[1]
        hi = earth.at(ts.tt_jd(t.tt + h)).observe(planet).apparent().ecliptic_latlon("date")[1]
        d = (hi.radians - lo.radians + math.pi) % (2.0 * math.pi) - math.pi
        return (d > 0.0).astype(int)

    direct.step_days = 3.0 if name == "Mercury" else 5.0
    times, _ = find_discrete(t0, t1, direct)
    out["station"] = list(times)

    if name in ("Mercury", "Venus"):

        def elongation(t):
            e = earth.at(t)
            return e.observe(sun).apparent().separation_from(e.observe(planet).apparent()).degrees

        elongation.step_days = 5.0
        times, _ = find_maxima(t0, t1, elongation)
        out["greatest_elongation"] = list(times)

    if name == "Saturn":

        def ring_side(t):
            v = earth.at(t).observe(planet).position.au
            return (angle_between(_SATURN_POLE_2D, v) > math.pi / 2).astype(int)

        ring_side.step_days = 20.0
        times, _ = find_discrete(t0, t1, ring_side)
        out["ring_plane_crossing"] = list(times)

    return out


# ---------------------------------------------------------------------------
# One case
# ---------------------------------------------------------------------------


def heliocentric_magnitude(ts, eph, key, t, ast):
    """Mallama & Hilton (2018) with the real Sun, via Skyfield's own formula
    functions. Returns (magnitude or None, r_au, phase_angle_deg)."""
    from skyfield import magnitudelib as ml
    from skyfield.functions import angle_between, length_of

    target = eph[key]
    t2 = ts.tt_jd(t.tt - ast.light_time)
    sun_to_planet = -target.at(t2).observe(eph["sun"]).position.au
    observer_to_planet = ast.position.au
    r = float(length_of(sun_to_planet))
    delta = float(length_of(observer_to_planet))
    ph = float(angle_between(sun_to_planet, observer_to_planet)) * 180.0 / math.pi
    fn = ml._FUNCTIONS[target.target]
    if fn is ml._saturn_magnitude or fn is ml._uranus_magnitude:
        pole = ml._SATURN_POLE if fn is ml._saturn_magnitude else ml._URANUS_POLE
        sun_lat = float(angle_between(pole, sun_to_planet)) * 180.0 / math.pi - 90.0
        obs_lat = float(angle_between(pole, observer_to_planet)) * 180.0 / math.pi - 90.0
        m = fn(r, delta, ph, sun_lat, obs_lat)
    elif fn is ml._neptune_magnitude:
        m = fn(r, delta, ph, t.J)
    else:
        m = fn(r, delta, ph)
    m = float(m)
    return (None if math.isnan(m) else m), r, ph


def bright_limb_angle_deg(sun_ra, sun_dec, ra, dec):
    """Meeus, Astronomical Algorithms (48.5): position angle of the midpoint of the
    bright limb, from north through east, from apparent RA/Dec of the Sun and body."""
    a0, d0, a, d = map(math.radians, (sun_ra, sun_dec, ra, dec))
    y = math.cos(d0) * math.sin(a0 - a)
    x = math.sin(d0) * math.cos(d) - math.cos(d0) * math.sin(d) * math.cos(a0 - a)
    return c.norm360(math.degrees(math.atan2(y, x)))


def body_case(ts, eph, eph421, name, key, key421, t, in_421, stats):
    from skyfield import almanac
    from skyfield.magnitudelib import planetary_magnitude

    earth, sun, planet = eph["earth"], eph["sun"], eph[key]
    e = earth.at(t)
    ast = e.observe(planet)
    app = ast.apparent()
    ra, dec, _ = app.radec(epoch="date")
    ra_deg = float(ra.hours) * 15.0
    dec_deg = float(dec.degrees)
    gha = c.norm360(float(t.gast) * 15.0 - ra_deg)
    dut1 = float(t.dut1)
    dist_au = float(ast.distance().au)
    dist_km = dist_au * AU_KM

    sun_app = e.observe(sun).apparent()
    sra, sdec, _ = sun_app.radec(epoch="date")
    elong = float(sun_app.separation_from(app).degrees)

    phase = float(almanac.phase_angle(eph, key, t).degrees)
    frac = float(almanac.fraction_illuminated(eph, key, t))

    m_sky = float(planetary_magnitude(ast))
    m_sky = None if math.isnan(m_sky) else m_sky
    m_hel, r_au, _ph_hel = heliocentric_magnitude(ts, eph, key, t, ast)

    # How much Jupiter and Saturn deflect the light, which a Sun-only model omits,
    # and how much the Sun does.
    sun_only = ast.apparent(deflectors=(10,))
    undeflected = ast.apparent(deflectors=())
    js = float(sun_only.separation_from(app).arcseconds())
    sun_defl = float(sun_only.separation_from(undeflected).arcseconds())
    if sun_defl > LIMB_DEFLECTION_ARCSEC:
        stats["behind_the_sun"] += 1
    stats["jupiter_saturn_deflection_arcsec"] = max(
        stats["jupiter_saturn_deflection_arcsec"], js)
    if m_sky is not None and m_hel is not None:
        stats["barycentric_sun_magnitude_shift"] = max(
            stats["barycentric_sun_magnitude_shift"], abs(m_sky - m_hel))
    if m_sky is None:
        stats["magnitude_null"] += 1

    body = {
        "gha_deg": c.deg(gha),
        "gha_deg_dut1_zero": c.deg(c.gha_dut1_zero_deg(gha, dut1)),
        "dec_deg": c.deg(dec_deg),
        "ra_deg": c.deg(ra_deg),
        "distance_au": c.Num(dist_au, 10),
        "heliocentric_distance_au": c.Num(r_au, 10),
        "phase_angle_deg": c.Num(phase, 6),
        "illuminated_fraction": c.Num(frac, 7),
        "elongation_deg": c.Num(elong, 6),
        "bright_limb_angle_deg": c.Num(
            bright_limb_angle_deg(float(sra.hours) * 15.0, float(sdec.degrees), ra_deg, dec_deg), 5),
        "magnitude": None if m_sky is None else c.Num(m_sky, 4),
        "magnitude_heliocentric": None if m_hel is None else c.Num(m_hel, 4),
        "semidiameter_arcmin": c.Num(
            math.degrees(math.asin(EQUATORIAL_RADIUS_KM[name] / dist_km)) * 60.0, 9),
        "horizontal_parallax_arcmin": c.Num(
            math.degrees(math.asin(EARTH_EQUATORIAL_RADIUS_KM / dist_km)) * 60.0, 9),
        "sun_deflection_arcsec": c.Num(sun_defl, 4),
    }
    if sun_defl > LIMB_DEFLECTION_ARCSEC:
        ura, udec, _ = undeflected.radec(epoch="date")
        ugha = c.norm360(float(t.gast) * 15.0 - float(ura.hours) * 15.0)
        body["no_deflection"] = c.Inline({
            "gha_deg_dut1_zero": c.deg(c.gha_dut1_zero_deg(ugha, dut1)),
            "dec_deg": c.deg(float(udec.degrees)),
        })
    if in_421:
        app2 = eph421["earth"].at(t).observe(eph421[key421]).apparent()
        ra2, dec2, _ = app2.radec(epoch="date")
        gha2 = c.norm360(float(t.gast) * 15.0 - float(ra2.hours) * 15.0)
        sep = float(app2.separation_from(app).arcseconds())
        stats["de421_max_separation_arcsec"] = max(stats["de421_max_separation_arcsec"], sep)
        stats["de421_epochs"] += 1
        body["de421"] = c.Inline({
            "gha_deg_dut1_zero": c.deg(c.gha_dut1_zero_deg(gha2, dut1)),
            "dec_deg": c.deg(float(dec2.degrees)),
        })
    return body


# ---------------------------------------------------------------------------
# One file per planet
# ---------------------------------------------------------------------------


def build_planet(ts, eph, eph421, name, key, key421):
    n_grid, sampling = PLAN[name]
    ev = events(ts, eph, name, key)
    lo421 = float(eph421.spk.segments[0].start_jd)
    hi421 = float(eph421.spk.segments[0].end_jd)

    chosen = [(t, "grid") for t in grid_times(ts, n_grid)]
    event_counts = {}
    for kind, every in sampling.items():
        found = ev.get(kind, [])
        kept = found[::every]
        event_counts[kind] = {"found": len(found), "kept": len(kept), "every": every}
        chosen += [(rounded(ts, t), kind) for t in kept]
    chosen.sort(key=lambda p: float(p[0].tt))

    stats = {
        "jupiter_saturn_deflection_arcsec": 0.0,
        "barycentric_sun_magnitude_shift": 0.0,
        "magnitude_null": 0,
        "de421_max_separation_arcsec": 0.0,
        "de421_epochs": 0,
        "behind_the_sun": 0,
    }
    cases = []
    for t, tag in chosen:
        in_421 = lo421 < float(t.tt) < hi421
        cases.append(c.Inline({
            "utc": t.utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
            "jd_utc": c.jd(c.jd_utc_of(t)),
            "jd_tt": c.jd(float(t.tt)),
            "jd_ut1": c.jd(float(t.ut1)),
            "delta_t_s": c.secs(float(t.delta_t)),
            "dut1_s": c.secs(float(t.dut1)),
            "tags": [tag],
            "bodies": {name: body_case(ts, eph, eph421, name, key, key421, t, in_421, stats)},
        }))

    notes = [
        "GHA = normalise(t.gast * 15 - RA_of_date) into [0, 360), west-positive, exactly "
        "as CONVENTIONS section 2 defines it. Test a DUT1 = 0 model against "
        "`gha_deg_dut1_zero`; `gha_deg` carries the timescale's DUT1 (SkyFix Lab's IERS "
        "table, see the timescale block). Instants are on the app's clock: UTC to 2035, "
        "UT1 after it, where DUT1 is 0 and the two columns agree; jd_tt and jd_ut1 give "
        "each case's TT and UT1.",
        "distance_au is the light-time distance |planet(t - tau) - earth(t)| of the "
        "astrometric position; semidiameter_arcmin = asin(R_eq / distance) with the IAU "
        "2015 equatorial radius in `radii_km`, horizontal_parallax_arcmin = asin(a / "
        "distance) with the WGS84 equatorial radius a = 6378.137 km.",
        "phase_angle_deg and illuminated_fraction are skyfield.almanac.phase_angle and "
        "fraction_illuminated (the real Sun, with light-time); elongation_deg is the "
        "separation of the apparent Sun and the apparent planet; bright_limb_angle_deg "
        "is Meeus (48.5) applied to Skyfield's apparent RA/Dec of the Sun and planet.",
        "magnitude is skyfield.magnitudelib.planetary_magnitude on the astrometric "
        "position, which treats the solar-system barycentre as the Sun. "
        "magnitude_heliocentric is the same Mallama & Hilton (2018) formula functions "
        "with the real Sun. Over this file the two differ by up to %.4f mag. null means "
        "Skyfield returns NaN (Saturn beyond its ring-model limits, Neptune before 2000 "
        "at phase angles above 1.9 deg)." % stats["barycentric_sun_magnitude_shift"],
        "Skyfield deflects the light by the Sun, Jupiter and Saturn. Jupiter's and "
        "Saturn's share, measured as apparent(deflectors=(10,)) against the default, is "
        "at most %.6f arcsec in this file, so a model that deflects by the Sun alone is "
        "not penalised by it." % stats["jupiter_saturn_deflection_arcsec"],
        "sun_deflection_arcsec is the size of Skyfield's solar light deflection at that "
        "epoch. It exceeds the limb-grazing 1.75 arcsec only when the planet's geometric "
        "direction is inside the solar disc, i.e. the planet is hidden behind the Sun (%d "
        "epoch(s) here). There the deflection formula, which describes a ray passing "
        "outside the Sun, grows without bound toward the Sun's centre, and the apparent "
        "direction is not an observable quantity; for those epochs `no_deflection` gives "
        "the same apparent place without any deflection, so a model can be checked on "
        "everything else." % stats["behind_the_sun"],
        "DE421's SPK coverage ends 2053-10-08; the `de421` cross-check block is present "
        "on the %d epochs before that. Over those epochs DE421 and DE440s differ by at "
        "most %.4f arcsec in apparent direction."
        % (stats["de421_epochs"], stats["de421_max_separation_arcsec"]),
    ]

    doc = {
        "schema": "skyfix.reference/1",
        "name": "planets_%s" % name.lower(),
        "generator": c.generator_block(
            tool="tools/reference/gen_planets.py",
            description=(
                "Apparent geocentric of-date GHA/Dec/RA, distance, phase, elongation, "
                "bright-limb angle and magnitude of %s at %d epochs, %s, from "
                "Skyfield with JPL %s (DE421 cross-check)."
                % (name, len(cases), c.RUN.window_text, c.kernel_label())
            ),
            tolerance_arcmin=c.Num(TOLERANCE_ARCMIN, 4),
            tolerance_justification=(
                "0.1 arcmin on GHA and Dec is the CONVENTIONS 13.7 target for the planets "
                "(worst case, 1990-2060, DUT1 = 0). The reference is far inside it: DE421 "
                "and DE440s agree to %.4f arcsec on this planet."
                % stats["de421_max_separation_arcsec"]
            ),
            frame_notes=FRAME_NOTES,
            refraction="none; these are geocentric directions, not altitudes",
            timescale=c.project_timescale_facts(),
            extra={
                "run": c.RUN.facts(),
                "frame_of_date": c.app_frame_facts(),
                "ephemeris": c.run_kernel_facts(),
                "ephemeris_crosscheck": {
                    "file": c.file_facts(c.EPHEMERIS_FILE, c.EPHEMERIS_URL),
                    "coverage_utc": ["1899-07-28", "2053-10-08"],
                    "epochs_compared": stats["de421_epochs"],
                    "max_separation_arcsec": c.arcsec(stats["de421_max_separation_arcsec"]),
                },
                "body": name,
                "de440s_target": key,
                "tolerances": {
                    "gha_dec_arcmin": c.Num(TOLERANCE_ARCMIN, 4),
                    "magnitude": c.Num(0.1, 2),
                    "illuminated_fraction": c.Num(0.001, 4),
                },
                "magnitude_model": (
                    "Mallama & Hilton (2018), Astronomy and Computing 25, 10-24, as "
                    "implemented by skyfield.magnitudelib (Skyfield %s). Mars omits the "
                    "rotational and seasonal corrections L(lambda_e) and L(Ls), as "
                    "Skyfield does (up to about 0.06 mag)." % c.versions()["skyfield"]
                ),
                "max_barycentric_sun_magnitude_shift": c.Num(
                    stats["barycentric_sun_magnitude_shift"], 4),
                "magnitude_null_count": stats["magnitude_null"],
                "behind_the_sun_count": stats["behind_the_sun"],
                "max_jupiter_saturn_deflection_arcsec": c.Num(
                    stats["jupiter_saturn_deflection_arcsec"], 6),
                "radii_km": {
                    "planet_equatorial": c.Num(EQUATORIAL_RADIUS_KM[name], 2),
                    "planet_source": (
                        "IAU WGCCRE 2015, Archinal et al. (2018), Celest. Mech. Dyn. "
                        "Astron. 130:22, table 1"
                    ),
                    "earth_equatorial": c.Num(EARTH_EQUATORIAL_RADIUS_KM, 3),
                    "earth_source": "WGS84",
                },
                "epoch_count": len(cases),
                "epoch_sets": {
                    "grid": "%d instants evenly spread over the window (%s), "
                            "time of day varying" % (n_grid, c.RUN.window_text),
                    "events": event_counts,
                    "event_rounding": "event instants rounded to the nearest UTC second",
                },
            },
        ),
        "notes": notes,
        "cases": cases,
    }
    print("   %-8s %3d epochs (%d grid + events %s); DE421 max %.4f\"; J+S deflection "
          "max %.6f\"; barycentric-Sun magnitude shift max %.4f"
          % (name, len(cases), n_grid,
             ", ".join("%s %d" % (k, v["kept"]) for k, v in event_counts.items()),
             stats["de421_max_separation_arcsec"], stats["jupiter_saturn_deflection_arcsec"],
             stats["barycentric_sun_magnitude_shift"]))
    return doc


def main(argv=None):
    c.setup(argv, __doc__.splitlines()[0], "1990..2060", "de440s")
    _set_window()
    ts = c.load_timescale()
    eph = c.run_ephemeris()  # --kernel, DE440s by default
    eph421 = c.load_ephemeris(c.EPHEMERIS_FILE)
    for name, key, key421 in PLANETS:
        doc = build_planet(ts, eph, eph421, name, key, key421)
        c.write_json(os.path.join(c.FIX_REFERENCE, "planets_%s.json" % name.lower()), doc)


if __name__ == "__main__":
    np.seterr(all="ignore")
    main()
