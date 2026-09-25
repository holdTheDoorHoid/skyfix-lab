"""alpha Centauri A about the A-B barycentre, for the reference fixtures.

Development-time only (CONVENTIONS section 11). The Nautical Almanac's Rigil Kentaurus
is alpha Centauri A (HIP 71683). Its Hipparcos proper motion is A's instantaneous one,
which includes A's orbital motion about the barycentre (0.22"/yr in 1991); extrapolating
it linearly, as the catalogue and USNO's celnav do, leaves A's real path by 5.8" in
2026, 17" in 2060, 111" in 1550 and 890" at 2000 BC. This module follows the path:

* the relative orbit of B about A from the USNO Sixth Catalog of Orbits of Visual
  Binary Stars (ORB6: WDS 14396-6050 RHD 1AB, Akeson et al. 2021, grade 2), with
  Thiele-Innes constants, `relative_offset(year)` in (north, east) arcseconds;
* A about the barycentre is `-f_B` times that, `f_B = M_B / (M_A + M_B)` from the same
  paper's masses;
* the barycentre moves by rigorous linear space motion from the catalogue position of
  A at J1991.25 with A's catalogue proper motion minus A's orbital velocity then, and
  the system's radial velocity: at J1991.25 the model *is* the catalogue.

`OrbitingStar` is a Skyfield `Star` that applies the orbital offset inside Skyfield's
own observation chain, so parallax, aberration, deflection and the frame of date stay
Skyfield's. `self_test()` reproduces ORB6's published ephemeris for 2025-2029.

    tools/reference/.venv/bin/python -m tools.reference.acen_orbit
"""

from __future__ import annotations

import math

import numpy as np

#: ORB6, retrieved 2026-09-25 from
#: https://crf.usno.navy.mil/data_products/WDS/orb6/orb6orbits.txt (line for
#: 14396-6050 RHD 1AB): P (yr), a ("), i, Omega (deg), T (yr), e, omega (deg).
ELEMENTS = dict(P=79.762, a=17.4930, i=79.2430, Om=205.073, T=1955.564, e=0.51947, om=231.519)
#: Akeson et al. 2021: M_A = 1.0788, M_B = 0.9092 solar masses.
F_B = 0.9092 / (1.0788 + 0.9092)
#: ORB6's ephemeris (orb6ephem.txt, same retrieval): year -> (theta deg, rho ").
#: Its position angles are referred to the equinox of date (ours are J2000; the
#: difference is 0.0073 deg/yr of precession at alpha Cen), its separations are exact.
PUBLISHED = {2025.0: (9.2, 8.737), 2026.0: (11.9, 9.294), 2027.0: (14.3, 9.765),
             2028.0: (16.5, 10.121), 2029.0: (18.6, 10.329)}
EPOCH_YEAR = 1991.25
HIP = 71683


def relative_offset(year, el=ELEMENTS):
    """B relative to A, (north, east) arcseconds, at Julian year `year`."""
    P, a, e = el["P"], el["a"], el["e"]
    M = 2.0 * math.pi * (year - el["T"]) / P
    E = M
    for _ in range(60):
        E -= (E - e * math.sin(E) - M) / (1.0 - e * math.cos(E))
    X = math.cos(E) - e
    Y = math.sqrt(1.0 - e * e) * math.sin(E)
    i, Om, om = (math.radians(el[k]) for k in ("i", "Om", "om"))
    A = a * (math.cos(om) * math.cos(Om) - math.sin(om) * math.sin(Om) * math.cos(i))
    B = a * (math.cos(om) * math.sin(Om) + math.sin(om) * math.cos(Om) * math.cos(i))
    F = a * (-math.sin(om) * math.cos(Om) - math.cos(om) * math.sin(Om) * math.cos(i))
    G = a * (-math.sin(om) * math.sin(Om) + math.cos(om) * math.cos(Om) * math.cos(i))
    return np.array([A * X + F * Y, B * X + G * Y])


def primary_offset(year):
    """A relative to the barycentre, (north, east) arcseconds."""
    return -F_B * relative_offset(year)


def primary_velocity(year, h=1e-3):
    """A's orbital velocity, (north, east) arcseconds per Julian year."""
    return (primary_offset(year + h) - primary_offset(year - h)) / (2.0 * h)


def departure_from_tangent(year):
    """How far A's real path is from the catalogue's straight line, (north, east) "."""
    return primary_offset(year) - primary_offset(EPOCH_YEAR) - primary_velocity(EPOCH_YEAR) * (year - EPOCH_YEAR)


def self_test():
    worst_rho = 0.0
    worst_theta = 0.0
    for year, (theta, rho) in PUBLISHED.items():
        n, e = relative_offset(year)
        precession = -0.0073 * (year - 2000.0)
        th = (math.degrees(math.atan2(e, n)) + precession) % 360.0
        worst_rho = max(worst_rho, abs(math.hypot(n, e) - rho))
        worst_theta = max(worst_theta, abs(th - theta))
    return worst_rho, worst_theta


def orbiting_star(row, rv_km_s):
    """A Skyfield Star for alpha Cen A that follows the orbit (see OrbitingStar)."""
    from skyfield.api import Star  # noqa: F401

    vel = primary_velocity(EPOCH_YEAR)  # (north, east) "/yr
    base = Star.from_dataframe(row)
    return orbiting_star_class()(
        ra_hours=base.ra.hours,
        dec_degrees=base.dec.degrees,
        ra_mas_per_year=base.ra_mas_per_year - vel[1] * 1000.0,
        dec_mas_per_year=base.dec_mas_per_year - vel[0] * 1000.0,
        parallax_mas=base.parallax_mas,
        radial_km_per_s=rv_km_s,
        epoch=base.epoch,
    )


def _make_class():
    from skyfield.api import Star

    class OrbitingStar(Star):
        """A Star whose catalogue proper motion is the barycentre's, plus A's orbital
        offset from its J1991.25 value added in the tangent plane inside Skyfield's own
        `_observe_from_bcrs` (so every later step is Skyfield's)."""

        def _observe_from_bcrs(self, observer):
            vector, vel, t, light_time = super()._observe_from_bcrs(observer)
            tt = np.atleast_1d(t.tt)
            years = 2000.0 + (tt - 2451545.0) / 365.25
            pos = (np.asarray(vector).T + np.asarray(observer.xyz.au).T).T  # barycentric
            pos2 = pos.reshape(3, -1)
            out = np.array(vector, dtype=float).reshape(3, -1)
            for k in range(pos2.shape[1]):
                y = years[k] if years.size > 1 else years[0]
                dn, de = (primary_offset(y) - primary_offset(EPOCH_YEAR)) * (math.pi / 648000.0)
                p = pos2[:, k]
                d = np.linalg.norm(p)
                u = p / d
                ra = math.atan2(u[1], u[0])
                dec = math.asin(u[2])
                e_ra = np.array([-math.sin(ra), math.cos(ra), 0.0])
                e_dec = np.array([-math.sin(dec) * math.cos(ra), -math.sin(dec) * math.sin(ra), math.cos(dec)])
                out[:, k] += d * (de * e_ra + dn * e_dec)
            out = out.reshape(np.shape(vector))
            return out, vel, t, light_time

    return OrbitingStar


_CLASS = []


def orbiting_star_class():
    """The `OrbitingStar` class (built on first use, so importing this module does not
    import Skyfield)."""
    if not _CLASS:
        _CLASS.append(_make_class())
    return _CLASS[0]


if __name__ == "__main__":
    rho, theta = self_test()
    print("ORB6 ephemeris 2025-2029: worst separation %.4f\", position angle %.3f deg" % (rho, theta))
    for y in (1550, 1800, 1991.25, 2000, 2026, 2060, 2650, -2000):
        d = departure_from_tangent(y)
        print("  %8.2f: A leaves the tangent line by %.2f\" (north %+.2f, east %+.2f)"
              % (y, float(np.hypot(*d)), d[0], d[1]))
