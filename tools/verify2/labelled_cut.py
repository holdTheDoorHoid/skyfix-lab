"""Labelled-tier spot check: engine sky_state (apparent geocentric RA/Dec of date) vs
Skyfield + JPL DE441, rotated to the true equator/equinox of date with ERFA's long-term
precession (Vondrak et al. 2011: eraLtpb/eraLtpecl/eraLtpequ) and ERFA's IAU 2000A
nutation. Independent of the project's tools/reference/ltp.py. The engine's own Delta-T
fixes TT, so Delta-T is not part of any figure."""
import sys, math, json, random
import numpy as np
import erfa
from v2 import cli, ts, kernel, jd_to_iso, jd_from_greg

BODIES = {"Sun": "sun", "Moon": "moon", "Mercury": "mercury", "Venus": "venus", "Mars": "mars barycenter",
          "Jupiter": "jupiter barycenter", "Saturn": "saturn barycenter", "Uranus": "uranus barycenter",
          "Neptune": "neptune barycenter"}

def eph_for(jd):
    return kernel("de441_part-1.bsp" if jd < 2440400.5 else "de441_part-2.bsp")

def frame_of_date(jd_tt):
    epj = 2000.0 + (jd_tt - 2451545.0) / 365.25
    rpb = erfa.ltpb(epj)
    pecl, pequ = erfa.ltpecl(epj), erfa.ltpequ(epj)
    epsa = math.atan2(np.linalg.norm(np.cross(pecl, pequ)), float(pecl @ pequ))
    d1, d2 = math.modf(jd_tt)
    dpsi, deps = erfa.nut00a(2400000.5, jd_tt - 2400000.5)
    rn = erfa.numat(epsa, dpsi, deps)
    return rn @ rpb

def ref_radec(body, jd_tt):
    eph = eph_for(jd_tt)
    t = ts().tt_jd(jd_tt)
    earth = eph["earth"]
    app = earth.at(t).observe(eph[BODIES[body]]).apparent()
    v = app.position.au
    w = frame_of_date(jd_tt) @ (v / np.linalg.norm(v))
    ra = math.degrees(math.atan2(w[1], w[0])) % 360
    dec = math.degrees(math.asin(max(-1, min(1, w[2]))))
    return ra, dec, w

def unit(ra, dec):
    r, d = math.radians(ra), math.radians(dec)
    return np.array([math.cos(d)*math.cos(r), math.cos(d)*math.sin(r), math.sin(d)])

def closest_approaches(body, y0, y1):
    eph = eph_for(jd_from_greg(y0, 1, 1))
    jd0, jd1 = jd_from_greg(y0, 1, 1), jd_from_greg(y1, 1, 1)
    jds = np.arange(jd0, jd1, 1.0)
    t = ts().tt_jd(jds)
    d = (eph[BODIES[body]].at(t) - eph["earth"].at(t)).distance().au
    out = []
    for i in range(1, len(jds) - 1):
        if d[i] < d[i-1] and d[i] <= d[i+1]:
            out.append(float(jds[i]))
    return out

def engine(jd_clock, bodies):
    iso = jd_to_iso(jd_clock)
    s = cli("sky", "--lat", "0", "--lon", "0", "--utc=" + iso, "--bodies", ",".join(bodies), "--json")
    ti = cli("time-info", "--jd", repr(s["jd_utc"]), "--json")
    return s, ti

def run(label, y0, y1, bodies, n_random, seed):
    rng = random.Random(seed)
    cases = []
    for b in bodies:
        for jd_tt in closest_approaches(b, y0, y1):
            cases.append((b, jd_tt, "closest"))
    j0, j1 = jd_from_greg(y0, 1, 1), jd_from_greg(y1, 1, 1)
    for _ in range(n_random):
        cases.append((None, rng.uniform(j0, j1), "random"))
    worst = {}
    for (b0, jd_guess, why) in cases:
        # jd_guess is TT-ish; the engine takes the clock: clock = TT - dT (iterate once)
        ti = cli("time-info", "--jd", repr(jd_guess), "--json")
        jd_clock = jd_guess - ti["delta_t_s"] / 86400.0
        bl = [b0] if b0 else bodies
        s, ti = engine(jd_clock, bl)
        jd_tt = s["jd_utc"] + ti["tt_minus_clock_s"] / 86400.0
        for st in s["bodies"]:
            b = st["body"]
            ra, dec, w = ref_radec(b, jd_tt)
            e = unit(st["ra_deg"], st["dec_deg"])
            sep = math.degrees(math.acos(max(-1, min(1, float(e @ w))))) * 3600
            dra = ((st["ra_deg"] - ra + 180) % 360 - 180) * 3600
            ddec = (st["dec_deg"] - dec) * 3600
            k = (b, why)
            if k not in worst or sep > worst[k][0]:
                worst[k] = (sep, dra, ddec, s["utc"], ti["tier"])
    print(f"== {label} ({y0}..{y1}), {len(cases)} cases")
    for (b, why), (sep, dra, ddec, utc, tier) in sorted(worst.items()):
        print(f"  {b:8s} {why:8s} worst on sky {sep:6.2f}\"  (dRA {dra:+7.2f}\", dDec {ddec:+6.2f}\")  at {utc} [{tier}]")
    return worst

if __name__ == "__main__":
    which = sys.argv[1:] or ["-1500", "2900"]
    for w in which:
        y = int(w)
        run(f"around {y}", y - 10, y + 10, ["Venus", "Mars", "Neptune"], 24, y)
