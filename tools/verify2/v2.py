"""verify2 helpers (development time only; nothing here ships).

The scripts in this directory re-derive the figures of docs/VERIFICATION_2.md. They call
the release CLI (`cargo build --release -p skyfix-cli`) and read the reference kernels in
tools/reference/data/ (DE440s, DE440, DE441, NAIF's lunar kernels). Run them with the
shared venv from a scratch directory, where they write their outputs, e.g.

    cd SCRATCH && REPO/tools/reference/.venv/bin/python REPO/tools/verify2/dt_canon.py

Some need pyerfa (ERFA, BSD-3-Clause), installed apart from the shared venv:
`tools/reference/.venv/bin/python -m pip install --target DIR --no-deps pyerfa`, then
`VERIFY2_PYLIB=DIR`. A few need the network (NOAA's and NASA's services), as their
docstrings say.
"""
import json, subprocess, functools, os, sys
WT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CLI = os.path.join(WT, "target/release/skyfix")
DATA = os.path.join(WT, "tools/reference/data")
REF = os.environ.get("VERIFY2_REF", ".")  # saved downloads (NOAA predictions)
if os.environ.get("VERIFY2_PYLIB"):
    sys.path.insert(0, os.environ["VERIFY2_PYLIB"])

def cli(*args, calendar="gregorian", packs=()):
    cmd = [CLI, "--calendar", calendar]
    for p in packs:
        cmd += ["--pack", p]
    cmd += list(args)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{r.stderr}")
    return json.loads(r.stdout)

def cli_text(*args, calendar="gregorian", packs=()):
    cmd = [CLI, "--calendar", calendar]
    for p in packs:
        cmd += ["--pack", p]
    cmd += list(args)
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr

@functools.lru_cache(None)
def ts():
    from skyfield.api import load
    return load.timescale(builtin=True)

@functools.lru_cache(None)
def kernel(name):
    from skyfield.api import load_file
    return load_file(os.path.join(DATA, name))

def jd_to_iso(jd):
    """Proleptic Gregorian wire string (Z) for a JD, expanded years, ms precision."""
    import math
    z = jd + 0.5
    Z = math.floor(z); F = z - Z
    # Gregorian from JDN (Fliegel-Van Flandern style, valid for negative years with floor)
    a = Z + 32044
    b = (4 * a + 3) // 146097
    c = a - 146097 * b // 4
    d = (4 * c + 3) // 1461
    e = c - 1461 * d // 4
    m = (5 * e + 2) // 153
    day = e - (153 * m + 2) // 5 + 1
    month = m + 3 - 12 * (m // 10)
    year = 100 * b + d - 4800 + m // 10
    ms = round(F * 86400000)
    if ms >= 86400000:
        return jd_to_iso(Z - 0.5 + 1.0)
    hh, rem = divmod(ms, 3600000); mi, rem = divmod(rem, 60000); ss, mss = divmod(rem, 1000)
    ys = f"{year:04d}" if 0 <= year <= 9999 else (f"-{-year:04d}" if year < 0 else f"+{year}")
    return f"{ys}-{month:02d}-{day:02d}T{hh:02d}:{mi:02d}:{ss:02d}.{mss:03d}Z"

def jd_from_greg(y, m, d, frac=0.0):
    a = (14 - m) // 12
    yy = y + 4800 - a
    mm = m + 12 * a - 3
    jdn = d + (153 * mm + 2) // 5 + 365 * yy + yy // 4 - yy // 100 + yy // 400 - 32045
    return jdn - 0.5 + frac
