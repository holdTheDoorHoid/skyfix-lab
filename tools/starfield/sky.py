"""Constellation-boundary geometry for the build and its checks. Development-time only.

Everything here works in the mean equator and equinox of B1875.0, the frame in which
Delporte (1930) drew every boundary as an arc of an hour circle or of a parallel of
declination. The Rust implementation (`crates/skyfix-starfield/src/constellations.rs`)
is independent of this file; the two meet only through the fixtures.
"""

from __future__ import annotations

import math

from . import bsc

#: Besselian epoch 1875.0 as a TT Julian date (1900.0 + (JD - 2415020.31352) / 365.242198781).
B1875_JD_TT = 2415020.31352 + (1875.0 - 1900.0) * 365.242198781


DAY_S = 86400  # seconds of time in 24 h
HALF_DAY_S = 43200


def polygon_edges(poly):
    """Vertices as exact integers (RA seconds of time in [0, 86400), Dec arcminutes),
    with Octans' plotting detour through the south pole removed (Davenhall & Leggett
    added points at Dec -90 so the polygon can be plotted in some projections; they are
    not boundary corners)."""
    return [(ra % DAY_S, dec) for ra, dec in poly.vertices if abs(dec) != 90 * 60]


def _wrap_s(x):
    """Wrap an RA difference in seconds of time into [-43200, 43200)."""
    return (x + HALF_DAY_S) % DAY_S - HALF_DAY_S


class Region:
    """One boundary polygon with the point-in-polygon test the build relies on.

    Integer arithmetic throughout (every vertex is on the 1 s / 1' grid), so the
    half-open rules below are exact even for points on a boundary."""

    def __init__(self, poly):
        self.abbr = poly.abbr
        self.key = poly.key
        self.verts = polygon_edges(poly)
        self.parallels = []  # (dec_arcmin, lo_s, width_s) with lo_s in [0, 86400)
        winding = 0
        n = len(self.verts)
        for i in range(n):
            a1, d1 = self.verts[i]
            a2, d2 = self.verts[(i + 1) % n]
            if a1 == a2 and d1 == d2:
                continue
            if d1 == d2:
                delta = _wrap_s(a2 - a1)
                if abs(delta) == HALF_DAY_S:
                    raise ValueError("%s: parallel edge of 12 h is ambiguous" % self.key)
                lo = a1 if delta > 0 else a2
                self.parallels.append((d1, lo, abs(delta)))
                winding += delta
            elif a1 != a2:
                raise ValueError("%s: edge %r -> %r is neither a meridian nor a parallel"
                                 % (self.key, (a1, d1), (a2, d2)))
        self.winding_s = winding
        if winding not in (0, DAY_S, -DAY_S):
            raise ValueError("%s: winding %d s" % (self.key, winding))
        mean_dec = sum(d for _, d in self.verts) / len(self.verts)
        self.contains_ncp = winding != 0 and mean_dec > 0.0

    def contains(self, ra_h, dec_d):
        """Ray from the point to the north celestial pole; count crossings of parallel
        edges strictly north of the point whose RA span covers the point's meridian.
        Spans are half-open [west end, east end), so a point on a boundary belongs to
        the region east of a meridian edge and north of a parallel edge."""
        ra_s = (ra_h * 3600.0) % DAY_S
        dec_m = dec_d * 60.0
        crossings = 0
        for d, lo, width in self.parallels:
            if d > dec_m and (ra_s - lo) % DAY_S < width:
                crossings += 1
        return (crossings % 2 == 1) != self.contains_ncp

    def distance_to_boundary_deg(self, ra_h, dec_d):
        """Great-circle distance from the point to the nearest edge of this region."""
        best = 180.0
        n = len(self.verts)
        for i in range(n):
            a1, d1 = self.verts[i]
            a2, d2 = self.verts[(i + 1) % n]
            best = min(best, _distance_to_edge(ra_h, dec_d, a1 / 3600.0, d1 / 60.0,
                                               a2 / 3600.0, d2 / 60.0))
        return best


def _wrap12(x):
    """Wrap an RA difference in hours into [-12, 12)."""
    return (x + 12.0) % 24.0 - 12.0


def _sep_deg(ra1_h, d1, ra2_h, d2):
    r1, r2 = math.radians(ra1_h * 15.0), math.radians(ra2_h * 15.0)
    p1, p2 = math.radians(d1), math.radians(d2)
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(r1 - r2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def _distance_to_edge(ra_h, dec_d, a1, d1, a2, d2):
    if d1 == d2:
        delta = _wrap12(a2 - a1)
        lo = a1 if delta > 0 else a2
        x = (ra_h - lo) % 24.0
        if x <= abs(delta):
            # The nearest point on a small circle of constant declination lies on the
            # point's own meridian when the meridian crosses the edge.
            return abs(dec_d - d1)
        return min(_sep_deg(ra_h, dec_d, a1, d1), _sep_deg(ra_h, dec_d, a2, d2))
    # Meridian edge: a great-circle arc.
    lo, hi = min(d1, d2), max(d1, d2)
    dra = math.radians(_wrap12(ra_h - a1) * 15.0)
    # Foot of the perpendicular from the point onto the meridian great circle.
    p = math.radians(dec_d)
    foot = math.degrees(math.atan2(math.sin(p), math.cos(p) * math.cos(dra)))
    if abs(_wrap12(ra_h - a1)) <= 6.0 and lo <= foot <= hi:
        s = math.cos(p) * math.sin(dra)
        return math.degrees(math.asin(max(-1.0, min(1.0, abs(s)))))
    return min(_sep_deg(ra_h, dec_d, a1, d1), _sep_deg(ra_h, dec_d, a2, d2))


def load_regions():
    regions = [Region(p) for p in bsc.load_boundaries()]
    ncp = [r.key for r in regions if r.contains_ncp]
    winding = sorted(r.key for r in regions if r.winding_s != 0)
    if ncp != ["UMI"] or winding != ["OCT", "UMI"]:
        raise ValueError("pole bookkeeping: ncp=%r winding=%r" % (ncp, winding))
    return regions


def lookup_b1875(regions, ra_h, dec_d):
    """Every region containing the point (normally exactly one)."""
    return [r for r in regions if r.contains(ra_h % 24.0, dec_d)]


# ---------------------------------------------------------------------------
# Frames (Skyfield, development-time): ICRS <-> mean equator and equinox of B1875
# ---------------------------------------------------------------------------


def icrs_to_mean_b1875_matrix():
    """P(B1875) B: frame bias and IAU 2006 precession, no nutation. Skyfield's
    `Time.M` is N P B (true equinox); the mean frame is N^T M."""
    from skyfield.api import load

    ts = load.timescale(builtin=True)
    t = ts.tt_jd(B1875_JD_TT)
    import numpy as np

    return np.asarray(t.nutation_matrix()).T @ np.asarray(t.M)


def unit(ra_deg, dec_deg):
    r, d = math.radians(ra_deg), math.radians(dec_deg)
    return (math.cos(d) * math.cos(r), math.cos(d) * math.sin(r), math.sin(d))


def radec_deg(v):
    x, y, z = v
    return math.degrees(math.atan2(y, x)) % 360.0, math.degrees(
        math.asin(max(-1.0, min(1.0, z / math.sqrt(x * x + y * y + z * z))))
    )


def mat_vec(m, v):
    return tuple(sum(m[i][j] * v[j] for j in range(3)) for i in range(3))


def mat_t_vec(m, v):
    return tuple(sum(m[j][i] * v[j] for j in range(3)) for i in range(3))
