"""Reference fixtures for the star field. Development-time only.

    tools/reference/.venv/bin/python -m tools.starfield.gen_fixtures

Run from the repository root after `fetch` and `build`. Writes

* `fixtures/reference/starfield_apparent.json` — Skyfield apparent geocentric places
  of date for several hundred catalogue stars at nine epochs, 1990-2060;
* `fixtures/reference/starfield_constellations.json` — Skyfield's constellation for
  25 000 pseudo-random apparent-of-date directions and dates, 1990-2060.

Independence (CONVENTIONS section 11): the star values fed to Skyfield are parsed here,
from the raw HEASARC table, by code written separately from `bsc.py` and from the Rust
decoder, so an encoding mistake in `stars.bin` shows up as a test failure instead of
being copied into the reference. The build's outputs are read only to *choose* which
stars to include (the 58 navigational stars by name), never for a value.
"""

from __future__ import annotations

import math
import os
import random

import numpy as np

from ..reference import common as c

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "data", "bsc5p.txt")
REPO = c.REPO
NAMES_OUT = os.path.join(REPO, "crates", "skyfix-starfield", "data", "names.txt")
NAV_FILE = os.path.join(c.FIX_REFERENCE, "navigational_stars_hip.json")

#: Leave out exactly what the display catalogue leaves out (see build.py).
EXCLUDED_HR = {5958}

EPOCHS = [
    (1990, 1, 1, 0, 0, 0),
    (1997, 7, 15, 6, 0, 0),
    (2004, 3, 20, 12, 0, 0),
    (2012, 11, 5, 18, 0, 0),
    (2020, 6, 21, 3, 30, 0),
    (2026, 9, 24, 12, 0, 0),
    (2041, 2, 14, 9, 0, 0),
    (2053, 8, 30, 21, 0, 0),
    (2060, 12, 31, 23, 0, 0),
]

N_DIRECTIONS = 25_000
SEED = 20260924
JD_1990 = 2447892.5  # 1990-01-01T00:00:00Z
JD_2061 = 2473459.5  # 2061-01-01T00:00:00Z


# ---------------------------------------------------------------------------
# Raw table, parsed independently of bsc.py
# ---------------------------------------------------------------------------


def _cell(v):
    v = v.strip()
    return None if v in ("", "null") else v


def read_raw():
    with open(RAW, encoding="utf-8") as f:
        text = f.read().splitlines()
    cols = [x.strip() for x in text[0].split("|")]
    out = []
    for line in text[1:]:
        if "|" not in line:
            continue
        row = dict(zip(cols, (_cell(x) for x in line.split("|"))))
        if row["vmag"] is None or row["pmra"] is None or row["cra"] in (None, "000000.0"):
            continue  # the 14 non-stellar entries
        hr = int(row["hr"])
        if hr in EXCLUDED_HR:
            continue
        cra, cdec = row["cra"], row["cdec"]
        ra_deg = (int(cra[0:2]) + int(cra[2:4]) / 60.0 + float(cra[4:]) / 3600.0) * 15.0
        sign = -1.0 if cdec[0] == "-" else 1.0
        dec_deg = sign * (int(cdec[1:3]) + int(cdec[3:5]) / 60.0 + int(cdec[5:7]) / 3600.0)
        # HEASARC's decimal copy, rounded to 1e-4 deg in this output format.
        assert abs(ra_deg - float(row["ra"])) < 6e-5 or abs(abs(ra_deg - float(row["ra"])) - 360) < 6e-5, hr
        assert abs(dec_deg - float(row["dec"])) < 6e-5, hr
        plx = 0.0 if row["parallax"] is None else float(row["parallax"]) * 1000.0
        out.append({
            "hr": hr,
            "ra_deg": ra_deg,
            "dec_deg": dec_deg,
            "pm_ra_cosdec_mas_yr": round(float(row["pmra"]) * 1000.0),
            "pm_dec_mas_yr": round(float(row["pmdec"]) * 1000.0),
            "parallax_mas": max(round(plx), 0),
            "radial_velocity_km_s": 0 if row["radvel"] is None else int(row["radvel"]),
            "vmag": float(row["vmag"]),
        })
    return out


# ---------------------------------------------------------------------------
# starfield_apparent.json
# ---------------------------------------------------------------------------


def choose_stars(rows, ts, eph):
    by_hr = {r["hr"]: r for r in rows}
    chosen = {}

    def take(r, why):
        chosen.setdefault(r["hr"], set()).add(why)

    # The 58 navigational stars (their HR numbers from the build's name list).
    import json

    nav = [x["name"] for x in json.load(open(NAV_FILE, encoding="utf-8"))["cases"]]
    hr_of = {}
    for line in open(NAMES_OUT, encoding="utf-8"):
        if line.startswith("#") or "|" not in line:
            continue
        hr, name = line.rstrip("\n").split("|", 1)
        hr_of[name] = int(hr)
    for n in nav:
        take(by_hr[hr_of[n]], "navigational")
    # Largest proper motions (the proper-motion and parallax terms at their biggest).
    for r in sorted(rows, key=lambda r: -math.hypot(r["pm_ra_cosdec_mas_yr"], r["pm_dec_mas_yr"]))[:25]:
        take(r, "high proper motion")
    # Nearest the poles (aberration and precession in RA are largest there).
    for r in sorted(rows, key=lambda r: -r["dec_deg"])[:12]:
        take(r, "north polar")
    for r in sorted(rows, key=lambda r: r["dec_deg"])[:12]:
        take(r, "south polar")
    # Straddling 0h of RA.
    for r in sorted(rows, key=lambda r: min(r["ra_deg"], 360.0 - r["ra_deg"]))[:10]:
        take(r, "near 0h")
    # Close to the Sun at each epoch (light deflection at its largest), at least 1 deg away.
    earth, sun = eph["earth"], eph["sun"]
    for ymdhms in EPOCHS:
        t = ts.utc(*ymdhms)
        ra_s, dec_s, _ = earth.at(t).observe(sun).radec()
        su = np.array([math.cos(dec_s.radians) * math.cos(ra_s.radians),
                       math.cos(dec_s.radians) * math.sin(ra_s.radians), math.sin(dec_s.radians)])
        def elong(r):
            a, d = math.radians(r["ra_deg"]), math.radians(r["dec_deg"])
            v = np.array([math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d)])
            return math.degrees(math.acos(max(-1.0, min(1.0, float(v @ su)))))
        near = sorted((r for r in rows if elong(r) >= 1.0), key=elong)[:3]
        for r in near:
            take(r, "near the Sun")
    # A seeded random sample for the rest.
    rng = random.Random(SEED)
    pool = [r for r in rows if r["hr"] not in chosen]
    for r in rng.sample(pool, 420 - len(chosen)):
        take(r, "random")
    return [(by_hr[hr], sorted(chosen[hr])) for hr in sorted(chosen)]


def skyfield_star(r, with_rv=True):
    from skyfield.api import Star

    return Star(
        ra_hours=r["ra_deg"] / 15.0,
        dec_degrees=r["dec_deg"],
        ra_mas_per_year=float(r["pm_ra_cosdec_mas_yr"]),
        dec_mas_per_year=float(r["pm_dec_mas_yr"]),
        parallax_mas=float(r["parallax_mas"]),
        radial_km_per_s=float(r["radial_velocity_km_s"]) if with_rv else 0.0,
    )


def sep_arcsec(ra1, d1, ra2, d2):
    r1, r2, p1, p2 = map(math.radians, (ra1, ra2, d1, d2))
    x = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(r1 - r2)
    return math.degrees(math.acos(max(-1.0, min(1.0, x)))) * 3600.0


def gen_apparent(ts, eph, eph_x):
    rows = read_raw()
    stars = choose_stars(rows, ts, eph)
    earth, earth_x = eph["earth"], eph_x["earth"]
    lo, hi = eph_x.spk.segments[0].start_jd, eph_x.spk.segments[0].end_jd
    epochs_out = []
    worst_rv = worst_eph = 0.0
    for ymdhms in EPOCHS:
        t = ts.utc(*ymdhms)
        places = []
        for r, _ in stars:
            app = earth.at(t).observe(skyfield_star(r)).apparent()
            ra, dec, _ = app.radec(epoch="date")
            ra_deg, dec_deg = float(ra._degrees), float(dec.degrees)
            places.append(c.Inline([r["hr"], c.deg(ra_deg), c.deg(dec_deg)]))
            # Diagnostics recorded in the file: the size of the radial-velocity term
            # (which the Rust pipeline does not model) and of the ephemeris choice.
            ra0, dec0, _ = earth.at(t).observe(skyfield_star(r, False)).apparent().radec(epoch="date")
            worst_rv = max(worst_rv, sep_arcsec(ra_deg, dec_deg, float(ra0._degrees), float(dec0.degrees)))
            if lo < float(t.tt) < hi:
                rx, dx, _ = earth_x.at(t).observe(skyfield_star(r)).apparent().radec(epoch="date")
                worst_eph = max(worst_eph, sep_arcsec(ra_deg, dec_deg, float(rx._degrees), float(dx.degrees)))
        epochs_out.append({
            "utc": t.utc_strftime("%Y-%m-%dT%H:%M:%SZ"),
            "jd_utc": c.jd(c.jd_utc_of(t)),
            "jd_tt": c.jd(float(t.tt)),
            "places": places,
        })
        print("  %s: %d stars" % (epochs_out[-1]["utc"], len(places)))

    doc = {
        "schema": "skyfix.reference/1",
        "name": "starfield_apparent",
        "generator": c.generator_block(
            tool="tools/starfield/gen_fixtures.py",
            description=(
                "Apparent geocentric places of date (CONVENTIONS section 7) of %d stars from "
                "the display catalogue (NASA HEASARC bsc5p) at %d epochs 1990-2060, computed "
                "by Skyfield from the catalogue's own J2000 position, proper motion, "
                "parallax and radial velocity." % (len(stars), len(EPOCHS))
            ),
            tolerance_arcmin=c.Num(0.1, 4),
            tolerance_justification=(
                "CONVENTIONS 13.7: star-field apparent places within 0.1 arcmin. The star "
                "field is display-only; the test also reports the measured worst case, "
                "which is limited by the terms the Rust pipeline deliberately shares with "
                "skyfix-ephemeris (no radial velocity, a Keplerian Earth for aberration)."
            ),
            frame_notes=c.GEOCENTRIC_FRAME_NOTES,
            extra={
                "ephemeris": c.file_facts(c.EPHEMERIS_CROSSCHECK_FILE, c.EPHEMERIS_CROSSCHECK_URL),
                "ephemeris_crosscheck": {
                    "file": "de421.bsp",
                    "max_difference_arcsec": c.arcsec(worst_eph),
                    "note": "same stars and epochs with DE421 where it covers them",
                },
                "radial_velocity_term": {
                    "max_effect_arcsec": c.arcsec(worst_rv),
                    "note": (
                        "Skyfield is given the catalogue radial velocity; the Rust pipeline, "
                        "like skyfix-ephemeris::frames, has no radial-velocity term. This is "
                        "the largest difference that makes, over every star and epoch here."
                    ),
                },
                "star_inputs": (
                    "ra_deg/dec_deg are the catalogue's sexagesimal J2000 position (cra, cdec: "
                    "RA to 0.1 s of time, Dec to 1 arcsec) converted to degrees; proper "
                    "motions are mu_alpha*cos(delta) and mu_delta in mas/yr; parallax in mas "
                    "with negative published values taken as 0, as Skyfield itself treats "
                    "them; epoch J2000.0 (TT). Parsed from the raw HEASARC table by this "
                    "script, independently of tools/starfield/bsc.py and of stars.bin."
                ),
                "selection": "the 58 navigational stars, the 25 largest proper motions, the 12 "
                             "nearest each pole, 10 nearest 0h RA, the 3 nearest the Sun "
                             "(>= 1 deg) at each epoch, and a seeded random sample; 420 total",
            },
        ),
        "stars": [
            c.Inline({
                "hr": r["hr"],
                "ra_deg": c.deg(r["ra_deg"]),
                "dec_deg": c.deg(r["dec_deg"]),
                "pm_ra_cosdec_mas_yr": r["pm_ra_cosdec_mas_yr"],
                "pm_dec_mas_yr": r["pm_dec_mas_yr"],
                "parallax_mas": r["parallax_mas"],
                "radial_velocity_km_s": r["radial_velocity_km_s"],
                "vmag": c.Num(r["vmag"], 2),
                "why": ", ".join(why),
            })
            for r, why in stars
        ],
        "epochs": epochs_out,
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, "starfield_apparent.json"), doc)
    print("  radial-velocity term up to %.3f\"; DE421 vs DE440s up to %.4f\"" % (worst_rv, worst_eph))


# ---------------------------------------------------------------------------
# starfield_constellations.json
# ---------------------------------------------------------------------------

MASK = (1 << 64) - 1


def splitmix64(state):
    state = (state + 0x9E3779B97F4A7C15) & MASK
    z = state
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
    return state, z ^ (z >> 31)


def samples(n, seed):
    state = seed
    out = []
    for _ in range(n):
        u = []
        for _ in range(3):
            state, z = splitmix64(state)
            u.append((z >> 11) * 2.0 ** -53)
        ra = 360.0 * u[0]
        dec = math.degrees(math.asin(2.0 * u[1] - 1.0))
        jd = JD_1990 + u[2] * (JD_2061 - JD_1990)
        out.append((ra, dec, jd))
    return out


def gen_constellations(ts):
    from skyfield.api import load_constellation_map, position_of_radec
    from skyfield.functions import load_bundled_npy
    from skyfield.timelib import julian_date_of_besselian_epoch

    pts = samples(N_DIRECTIONS, SEED)
    ra = np.array([p[0] for p in pts])
    dec = np.array([p[1] for p in pts])
    jd = np.array([p[2] for p in pts])
    t = ts.utc(1990, 1, 1.0 + (jd - JD_1990))
    pos = position_of_radec(ra / 15.0, dec, epoch=t)

    shipped = load_constellation_map()(pos)

    t1875 = ts.tt_jd(julian_date_of_besselian_epoch(1875))
    mean = np.asarray(t1875.nutation_matrix()).T @ np.asarray(t1875.M)
    xyz = mean @ pos.xyz.au
    ra_b = (np.degrees(np.arctan2(xyz[1], xyz[0])) % 360.0) / 15.0
    dec_b = np.degrees(np.arcsin(xyz[2] / np.sqrt((xyz ** 2).sum(axis=0))))
    arrays = load_bundled_npy("constellations.npz")
    i = np.searchsorted(arrays["sorted_ra"], ra_b)
    j = np.searchsorted(arrays["sorted_dec"], dec_b, side="right")
    mean_answer = arrays["indexed_abbreviations"][arrays["radec_to_index"][i, j]]

    dpsi, deps = t1875._nutation_angles_radians
    differs = [[k, str(shipped[k])] for k in range(len(pts)) if shipped[k] != mean_answer[k]]
    doc = {
        "schema": "skyfix.reference/1",
        "name": "starfield_constellations",
        "generator": c.generator_block(
            tool="tools/starfield/gen_fixtures.py",
            description=(
                "The IAU constellation containing %d pseudo-random apparent-of-date "
                "directions at pseudo-random instants 1990-2060, from Skyfield's "
                "constellation map (built from Roman 1987, an independent digitisation of "
                "Delporte 1930)." % len(pts)
            ),
            tolerance_arcmin=c.Num(1.0 / 60.0, 4),
            tolerance_justification=(
                "The two digitisations of the boundaries agree exactly (checked cell by "
                "cell in tools/starfield/build.py), so any disagreement must come from the "
                "frame transformation and may only occur within 1 arcsec of a boundary."
            ),
            extra={
                "sampling": {
                    "prng": "splitmix64 (Steele, Lea & Flood 2014), state += 0x9E3779B97F4A7C15; "
                            "z = (z ^ z>>30) * 0xBF58476D1CE4E5B9; z = (z ^ z>>27) * "
                            "0x94D049BB133111EB; z ^ z>>31; all mod 2^64",
                    "seed": SEED,
                    "uniform": "(z >> 11) * 2^-53, three per sample in the order u1, u2, u3",
                    "ra_deg": "360 * u1 (apparent right ascension of date)",
                    "dec_deg": "degrees(asin(2 * u2 - 1)) (uniform on the sphere)",
                    "jd_utc": "%.1f + u3 * (%.1f - %.1f)" % (JD_1990, JD_2061, JD_1990),
                    "count": len(pts),
                    "first_samples": [c.Inline([c.Num(p[0], 12), c.Num(p[1], 12), c.Num(p[2], 9)])
                                      for p in pts[:5]],
                },
                "frame": (
                    "The direction is taken as an apparent place of date (true equator and "
                    "equinox of date, the explorer's frame) and turned into ICRS by "
                    "position_of_radec(ra/15, dec, epoch=t), which applies Skyfield's "
                    "bias-precession-nutation matrix M(t) transposed. Nothing is done about "
                    "aberration: the question is which region of the sky the direction "
                    "points into."
                ),
                "answers_mean_b1875_definition": (
                    "Skyfield's own grid (constellations.npz) indexed with the direction "
                    "rotated into the MEAN equator and equinox of B1875.0 (N(1875)^T M(1875) "
                    "= frame bias and IAU 2006 precession), which is the frame the IAU "
                    "boundaries are defined in."
                ),
                "answers_skyfield_as_shipped_definition": (
                    "skyfield.api.load_constellation_map() unchanged. It calls "
                    "position.radec(epoch=B1875), and Time.M includes nutation, so it "
                    "looks the direction up in the TRUE equator and equinox of B1875.0. "
                    "That moves every direction by the 1875 nutation (below), so it may "
                    "disagree with the mean-frame answer within that distance of a boundary."
                ),
                "nutation_b1875_arcsec": {
                    "dpsi": c.arcsec(dpsi / math.pi * 648000.0),
                    "deps": c.arcsec(deps / math.pi * 648000.0),
                },
            },
        ),
        "answers_mean_b1875": " ".join(str(x) for x in mean_answer),
        "answers_skyfield_as_shipped_where_different": [c.Inline(d) for d in differs],
    }
    c.write_json(os.path.join(c.FIX_REFERENCE, "starfield_constellations.json"), doc)
    print("  %d directions; Skyfield as shipped differs from the mean-B1875 answer at %d"
          % (len(pts), len(differs)))


def main():
    from skyfield.api import load_file

    ts = c.load_timescale()
    eph = load_file(c.EPHEMERIS_CROSSCHECK_FILE)  # DE440s: covers the whole 1990-2060 window
    eph_x = load_file(c.EPHEMERIS_FILE)  # DE421, cross-check where it covers
    gen_apparent(ts, eph, eph_x)
    gen_constellations(ts)


if __name__ == "__main__":
    main()
