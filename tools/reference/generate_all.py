"""Regenerate every reference fixture.

    python -m tools.reference.generate_all            # everything
    python -m tools.reference.generate_all --offline  # skip the USNO query
    python -m tools.reference.generate_all --list     # every generator; runs nothing

Every generator runs with its own default `--window` and `--kernel` (the ones its
committed file was written with). `gen_deeptime` (DE440 + DE441, about two minutes)
and `build_series` (the embedded series, about ten minutes) are separate:
`make -C tools/reference deeptime series`.

Run from the repository root with the virtualenv Python:

    tools/reference/.venv/bin/python -m tools.reference.generate_all

Nothing in tools/ is ever a runtime dependency of the Rust workspace.
"""

from __future__ import annotations

import sys
import time

from . import common as c
from . import gen_almanac, gen_eclipses, gen_events, gen_geocentric, gen_moon, gen_moon_sights, gen_nav_methods, gen_planet_events, gen_planets, gen_sessions, gen_stars, gen_sun_sextant, gen_sun_tools, gen_topocentric, gen_usno, gen_usno_sights

STEPS = [
    ("navigational_stars_hip", lambda: gen_stars.main([]), False),
    ("geocentric_sun_stars", lambda: gen_geocentric.main([]), False),
    ("topocentric_altaz", lambda: gen_topocentric.main([]), False),
    ("philadelphia star sessions", lambda: gen_sessions.main([]), False),
    ("reference-sun-sextant", lambda: gen_sun_sextant.main([]), False),
    ("moon_geocentric + moon_topocentric", lambda: gen_moon.main([]), False),
    ("planets_* (Mercury to Neptune, DE440s)", lambda: gen_planets.main([]), False),
    ("nav_methods", lambda: gen_nav_methods.main([]), False),
    ("moon and planet sights, sessions, lunar distances, twilight", lambda: gen_moon_sights.main([]), False),
    ("events: rise/set/twilight, seasons, Moon phases", lambda: gen_events.main(["--offline"]), False),
    ("usno_celnav cross-check", lambda: gen_usno.main([]), True),
    ("usno_celnav Venus phase and Moon corrections", lambda: gen_usno_sights.main([]), True),
    ("events USNO cross-check", lambda: gen_events.main(["--usno-only"]), True),
    ("almanac_days: daily almanac pages", lambda: gen_almanac.main([]), False),
    ("almanac_usno: USNO spot checks of the pages", lambda: gen_almanac.main(["--usno-only"]), True),
    ("eclipses_skyfield", lambda: gen_eclipses.main(["--offline"]), False),
    (
        "eclipses_nasa_canon + eclipses_nasa_paths + eclipses_usno_local",
        lambda: gen_eclipses.main(["--network-only"]),
        True,
    ),
    ("planet_events_skyfield", lambda: gen_planet_events.main(["--offline"]), False),
    ("planet_events_nasa_skycal", lambda: gen_planet_events.main(["--network-only"]), True),
    ("sun_tools_skyfield", lambda: gen_sun_tools.main([]), False),
]


# --- cli3 agent (expansion programme): the generators the programme added ---------------
#
# Each step below runs its module's `main` with the arguments given, as its own command
# line would. The module is imported only when the step runs, so a generator whose
# inputs or packages are missing fails as its own step and the others still run.


def _run_main(module, argv):
    """Run `module`'s main with the command line `argv`. The generators take it three
    ways, main(argv), main(argv=None) and main() reading sys.argv, so sys.argv is set too;
    a non-zero return or SystemExit is a failure."""
    import importlib
    import inspect

    mod = importlib.import_module(module)
    saved = sys.argv
    sys.argv = [module] + list(argv)
    try:
        if inspect.signature(mod.main).parameters:
            rc = mod.main(list(argv))
        else:
            rc = mod.main()
    except SystemExit as exc:
        rc = exc.code
    finally:
        sys.argv = saved
    if rc not in (None, 0):
        raise RuntimeError("%s %s: %s" % (module, " ".join(argv), rc))


def _step(module, *argv):
    return lambda: _run_main(module, argv)


def _planetdetail_network():
    # The parts whose files come from the network; the Skyfield parts are the step
    # before. Apsides and orbits recompute their Skyfield columns beside the new files.
    for part in ("horizons", "transits", "apsides", "orbits"):
        _run_main("tools.reference.gen_planetdetail", ["--part", part])


#: The Delta-T and UT1 tables first: every other generator's clock reads the
#: `crates/skyfix-core/src/deltat/data.rs` this writes (tools/timescales/skyfield_timescale.py).
STEPS.insert(
    0,
    (
        "timescales (and crates/skyfix-core/src/deltat/data.rs)",
        _step("tools.timescales.gen_timescales"),
        False,
    ),
)

STEPS += [
    (
        "almanac_tables: the almanac's tables beyond the daily pages",
        _step("tools.reference.gen_almanac_tables"),
        False,
    ),
    (
        "planetdetail_conjunctions + _galilean, the Skyfield columns of the rest",
        _step("tools.reference.gen_planetdetail", "--offline"),
        False,
    ),
    (
        "planetdetail_horizons + _transits + _apsides + _orbits: JPL, NASA, USNO, MPC",
        _planetdetail_network,
        True,
    ),
    (
        "moon_libration + moon_apsides + moon_occultations",
        _step("tools.moon.gen_reference"),
        False,
    ),
    (
        "eclipse_limb_skyfield: the lunar limb from LDEM_16 (python3 -m tools.limb.fetch)",
        _step("tools.limb.reference", "skyfield"),
        False,
    ),
    (
        "eclipse_limb_svs: NASA SVS limb-corrected contacts",
        _step("tools.limb.reference", "svs"),
        True,
    ),
    (
        "geomag_wmm2025 + geomag_igrf14: the models' published test values",
        _step("tools.geomag.gen_fixtures"),
        True,
    ),
    (
        "tides_noaa + tides_noaa_sweep: NOAA's own predictions (after make -C tools/tides fetch)",
        _step("tools.tides.fixtures"),
        True,
    ),
    # Older than the programme, and missing from this list until now.
    (
        "starfield_apparent + starfield_constellations (after python3 -m tools.starfield.fetch)",
        _step("tools.starfield.gen_fixtures"),
        False,
    ),
]

#: Generators not run here: the slow ones with their own make targets, and the
#: programme's data builders, which write shipped data (an embedded table, a pack) from
#: downloaded sources; two of them also write a fixture. `--list` prints them.
#: (command, what it writes)
SEPARATE = [
    ("make -C tools/reference deeptime", "fixtures/reference/deeptime_bodies.json (gen_deeptime.py)"),
    ("make -C tools/reference series", "crates/skyfix-ephemeris/data/series.bin (build_series.py)"),
    ("python3 -m tools.geomag.gen_coeffs", "crates/skyfix-geomag/src/coeffs.rs"),
    (
        "python3 -m tools.moon.fetch; python3 -m tools.moon.build",
        "crates/skyfix-almanac/data/lunar_features.tsv and its manifest",
    ),
    (
        "python3 -m tools.limb.fetch; tools/reference/.venv/bin/python -m tools.limb.build",
        "web/public/data/packs/lunar-limb-<rev>.bin and lunar-limb.json",
    ),
    (
        "make -C tools/tides",
        "web/public/data/packs/tides-us-<rev>.bin and tides-us.json (with the tides fixtures)",
    ),
    ("python3 -m tools.starfield.deepsky_fetch", "the inputs of the four below (git-ignored)"),
    (
        "python3 -m tools.starfield.dso",
        "crates/skyfix-starfield/data/dso.txt and fixtures/reference/dso_positions.json",
    ),
    (
        "python3 -m tools.starfield.showers",
        "crates/skyfix-starfield/data/showers.txt and fixtures/reference/showers_reference.json",
    ),
    (
        "tools/reference/.venv/bin/python -m tools.starfield.milkyway",
        "crates/skyfix-starfield/data/milkyway.bin",
    ),
    ("python3 -m tools.starfield.wgsn", "crates/skyfix-starfield/data/names_wgsn.txt"),
]


def list_generators():
    print("Run here, in this order (N: needs the network, skipped by --offline):")
    for i, (name, _fn, needs_network) in enumerate(STEPS, 1):
        print("  %2d %s %s" % (i, "N" if needs_network else " ", name))
    print("\nRun separately:")
    for command, writes in SEPARATE:
        print("  %s\n       %s" % (command, writes))
    return 0


# --- end cli3 ------------------------------------------------------------------------


def check_inputs():
    import os

    missing = []
    for path, url in (
        (c.EPHEMERIS_FILE, c.EPHEMERIS_URL),
        (c.EPHEMERIS_CROSSCHECK_FILE, c.EPHEMERIS_CROSSCHECK_URL),
        (c.HIPPARCOS_FILE, c.HIPPARCOS_URL),
    ):
        if not os.path.exists(path):
            missing.append((path, url))
    if missing:
        print("Missing input data. Fetch it with:\n")
        for path, url in missing:
            print("  curl -L -o %s \\\n       %s" % (path, url))
        print(
            "\n(These are git-ignored on purpose: see docs/THIRD_PARTY.md, "
            "'Reference data (development-time only)'.)"
        )
        sys.exit(1)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    offline = "--offline" in argv
    if "--list" in argv:  # cli3 agent: print every generator, run nothing
        return list_generators()
    check_inputs()

    versions = c.versions()
    print(
        "SkyFix Lab reference fixtures -- python %s, skyfield %s, numpy %s, "
        "pandas %s, jplephem %s"
        % (
            versions["python"],
            versions["skyfield"],
            versions["numpy"],
            versions["pandas"],
            versions["jplephem"],
        )
    )
    print("each generator's default --window/--kernel; catalogue hip_main.dat; the app's clock "
          "(tools/timescales/skyfield_timescale.py)\n")

    failures = []
    for name, fn, needs_network in STEPS:
        if offline and needs_network:
            print("-- %s: skipped (--offline)" % name)
            continue
        print("-- %s" % name)
        t0 = time.time()
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 - report and keep going
            failures.append((name, exc))
            print("   FAILED: %s: %s" % (type(exc).__name__, exc))
        else:
            print("   done in %.1f s" % (time.time() - t0))
        print()

    if failures:
        print("FAILED steps: %s" % ", ".join(n for n, _ in failures))
        return 1
    print("all reference fixtures regenerated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
