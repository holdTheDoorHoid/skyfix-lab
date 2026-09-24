"""Regenerate every reference fixture.

    python -m tools.reference.generate_all            # everything
    python -m tools.reference.generate_all --offline  # skip the USNO query

Run from the repository root with the virtualenv Python:

    tools/reference/.venv/bin/python -m tools.reference.generate_all

Nothing in tools/ is ever a runtime dependency of the Rust workspace.
"""

from __future__ import annotations

import sys
import time

from . import common as c
from . import gen_almanac, gen_eclipses, gen_events, gen_geocentric, gen_moon, gen_moon_sights, gen_nav_methods, gen_planets, gen_sessions, gen_stars, gen_sun_sextant, gen_topocentric, gen_usno, gen_usno_sights

STEPS = [
    ("navigational_stars_hip", gen_stars.main, False),
    ("geocentric_sun_stars", gen_geocentric.main, False),
    ("topocentric_altaz", gen_topocentric.main, False),
    ("philadelphia star sessions", gen_sessions.main, False),
    ("reference-sun-sextant", gen_sun_sextant.main, False),
    ("moon_geocentric + moon_topocentric", gen_moon.main, False),
    ("planets_* (Mercury to Neptune, DE440s)", gen_planets.main, False),
    ("nav_methods", gen_nav_methods.main, False),
    ("moon and planet sights, sessions, lunar distances, twilight", gen_moon_sights.main, False),
    ("events: rise/set/twilight, seasons, Moon phases", gen_events.main_offline, False),
    ("usno_celnav cross-check", gen_usno.main, True),
    ("usno_celnav Venus phase and Moon corrections", gen_usno_sights.main, True),
    ("events USNO cross-check", gen_events.main_usno_only, True),
    ("almanac_days: daily almanac pages", gen_almanac.main_offline, False),
    ("almanac_usno: USNO spot checks of the pages", gen_almanac.main_usno_only, True),
    ("eclipses_skyfield", lambda: gen_eclipses.main(["--offline"]), False),
    (
        "eclipses_nasa_canon + eclipses_nasa_paths + eclipses_usno_local",
        lambda: gen_eclipses.main(["--network-only"]),
        True,
    ),
]


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
    print("ephemeris de421.bsp, catalogue hip_main.dat, timescale builtin=True\n")

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
