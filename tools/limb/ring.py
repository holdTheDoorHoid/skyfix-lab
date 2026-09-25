"""The lunar limb ring: LOLA heights resampled onto a grid that follows the Moon's mean
limb, and the byte code the `lunar-limb` pack stores it in. Development-time only.

Shared by `tools/limb/build.py` (which writes the pack) and `tools/limb/reference.py`
(which checks the engine against it). Needs numpy (the reference venv).

Geometry (the mean Earth/polar axis frame of LOLA and of IAU selenographic
coordinates: x toward the mean sub-Earth point, latitude 0 and longitude 0; z toward the
north pole; y toward east longitude 90 deg):

* The **mean limb** is the great circle x = 0, where the limb runs when the libration is
  zero. A ring node sits at **axis angle** `alpha` around it, measured at the Moon's
  centre from the north pole toward the side that appears on the east of the sky
  (selenographic west, -y) - the Watts angle - and at angular distance `delta` from it,
  positive toward the Earth (+x). Its unit vector is
  `(sin delta, -sin alpha cos delta, cos alpha cos delta)`.
* Nodes are pixel-registered: `alpha_j = (j + 1/2) step`, `delta_i = delta_min + (i + 1/2)
  step`, `step = 1/16 deg`, `delta` within +-12 deg (the libration moves the limb up to
  about 9 deg from the mean limb at an eclipse, and ground up to 3-4 deg behind the
  tangent can still stand out against the sky). Along alpha = 90 and 270 deg the nodes
  fall exactly on LDEM_16 pixel centres.
* Heights are LOLA's (above the 1737.4 km reference sphere, from the centre of mass),
  bilinearly interpolated from LDEM_16 and quantised to `QUANTUM_M` (5 m: at most 2.5 m of
  rounding, 0.0014" at the Moon's distance).

Byte code (the pack's payload body, `LimbRing.decode` in Rust): the quantised heights
`q[j][i]`, column by column (all `delta` of `alpha_0`, then `alpha_1`, ...), each coded
as the residual from the planar prediction
`p = q[j][i-1] + q[j-1][i] - q[j-1][i-1]` (missing neighbours count as 0, so the first
column is a plain difference down the column and the first row a difference across
columns), stored as one signed byte when it is within -127..127 and otherwise as the
byte 0x80 followed by the residual as a little-endian int16.
"""

from __future__ import annotations

import os
import re

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
IMG = os.path.join(DATA, "ldem_16.img")
LBL = os.path.join(DATA, "ldem_16.lbl")

LINES, SAMPLES, PIX_PER_DEG = 2880, 5760, 16
DN_TO_M = 0.5
REFERENCE_RADIUS_KM = 1737.4

STEP_DEG = 1.0 / 16.0
N_ALPHA = 5760
DELTA_HALF_DEG = 12.0
N_DELTA = int(round(2 * DELTA_HALF_DEG / STEP_DEG))  # 384
QUANTUM_M = 5.0
ESCAPE = 0x80


def check_label(path: str = LBL) -> dict:
    """Read the PDS3 label and refuse anything but the layout this module assumes."""
    text = open(path, encoding="ascii", errors="replace").read()

    def value(key: str) -> str:
        m = re.search(r"^\s*%s\s*=\s*(.+?)\s*$" % re.escape(key), text, flags=re.M)
        if not m:
            raise SystemExit("label: no %s" % key)
        return m.group(1).strip().strip('"')

    want = {
        "LINES": str(LINES),
        "LINE_SAMPLES": str(SAMPLES),
        "SAMPLE_TYPE": "LSB_INTEGER",
        "SAMPLE_BITS": "16",
        "SCALING_FACTOR": "0.5",
        "OFFSET": "1737400.",
        "MAP_PROJECTION_TYPE": "SIMPLE CYLINDRICAL",
        "MAP_RESOLUTION": "16 <pix/deg>",
        "POSITIVE_LONGITUDE_DIRECTION": "EAST",
        "CENTER_LATITUDE": "0 <deg>",
        "CENTER_LONGITUDE": "180 <deg>",
        "LINE_PROJECTION_OFFSET": "1439.5 <pix>",
        "SAMPLE_PROJECTION_OFFSET": "2879.5 <pix>",
        "COORDINATE_SYSTEM_NAME": "MEAN EARTH/POLAR AXIS OF DE421",
    }
    got = {k: value(k) for k in want}
    bad = {k: (got[k], v) for k, v in want.items() if got[k] != v}
    if bad:
        raise SystemExit("label differs from the layout this pipeline assumes: %r" % bad)
    got["PRODUCT_ID"] = value("PRODUCT_ID")
    got["PRODUCT_VERSION_ID"] = value("PRODUCT_VERSION_ID")
    got["DATA_SET_ID"] = value("DATA_SET_ID")
    return got


def read_dem(path: str = IMG) -> np.ndarray:
    """LDEM_16 as DN (int16), shape (lines, samples): row i at latitude
    90 - (i + 1/2)/16 deg, column j at east longitude (j + 1/2)/16 deg."""
    dem = np.fromfile(path, dtype="<i2")
    if dem.size != LINES * SAMPLES:
        raise SystemExit("%s: %d samples, expected %d" % (path, dem.size, LINES * SAMPLES))
    return dem.reshape(LINES, SAMPLES)


def dem_height_m(dem: np.ndarray, lat_deg, lon_deg) -> np.ndarray:
    """Bilinear interpolation of LDEM_16 heights (metres) at selenographic latitude and
    east longitude, degrees (arrays). Rows clamp at the poles; columns wrap."""
    fi = (90.0 - np.asarray(lat_deg, dtype=float)) * PIX_PER_DEG - 0.5
    fj = np.mod(np.asarray(lon_deg, dtype=float), 360.0) * PIX_PER_DEG - 0.5
    i0 = np.floor(fi).astype(np.int64)
    j0 = np.floor(fj).astype(np.int64)
    ti = fi - i0
    tj = fj - j0
    i0c = np.clip(i0, 0, LINES - 1)
    i1c = np.clip(i0 + 1, 0, LINES - 1)
    j0w = np.mod(j0, SAMPLES)
    j1w = np.mod(j0 + 1, SAMPLES)
    d = dem
    v = (
        d[i0c, j0w] * (1 - ti) * (1 - tj)
        + d[i0c, j1w] * (1 - ti) * tj
        + d[i1c, j0w] * ti * (1 - tj)
        + d[i1c, j1w] * ti * tj
    )
    return v * DN_TO_M


def ring_axes():
    """Axis angles and distances from the mean limb of the nodes, degrees."""
    alpha = (np.arange(N_ALPHA) + 0.5) * STEP_DEG
    delta = -DELTA_HALF_DEG + (np.arange(N_DELTA) + 0.5) * STEP_DEG
    return alpha, delta


def node_unit(alpha_deg, delta_deg):
    """Unit vectors of ring nodes in the mean Earth/polar axis frame (broadcasting)."""
    a = np.radians(alpha_deg)
    d = np.radians(delta_deg)
    return np.sin(d), -np.sin(a) * np.cos(d), np.cos(a) * np.cos(d)


def resample(dem: np.ndarray) -> np.ndarray:
    """The ring's heights in metres, shape (N_ALPHA, N_DELTA), before quantisation."""
    alpha, delta = ring_axes()
    out = np.empty((N_ALPHA, N_DELTA))
    for j0 in range(0, N_ALPHA, 720):
        a = alpha[j0 : j0 + 720, None]
        x, y, z = node_unit(a, delta[None, :])
        lat = np.degrees(np.arcsin(np.clip(z, -1.0, 1.0)))
        lon = np.degrees(np.arctan2(y, x))
        out[j0 : j0 + 720] = dem_height_m(dem, lat, lon)
    return out


def quantise(heights_m: np.ndarray) -> np.ndarray:
    return np.round(heights_m / QUANTUM_M).astype(np.int64)


def predictions(q: np.ndarray) -> np.ndarray:
    p = np.zeros_like(q)
    p[:, 1:] = q[:, :-1]
    p[1:, 0] = q[:-1, 0]
    p[1:, 1:] = q[1:, :-1] + q[:-1, 1:] - q[:-1, :-1]
    return p


def encode(q: np.ndarray) -> bytes:
    """The byte code of the module documentation."""
    res = (q - predictions(q)).ravel()
    small = np.abs(res) <= 127
    out = bytearray()
    # Vectorised in runs: bytes for the small residuals, escapes spliced in order.
    big = np.flatnonzero(~small)
    start = 0
    for k in big:
        out += (res[start:k].astype(np.int8)).tobytes()
        v = int(res[k])
        if not -32768 <= v <= 32767:
            raise SystemExit("residual %d does not fit an int16" % v)
        out.append(ESCAPE)
        out += v.to_bytes(2, "little", signed=True)
        start = k + 1
    out += (res[start:].astype(np.int8)).tobytes()
    return bytes(out)


def decode(body: bytes, n_alpha: int = N_ALPHA, n_delta: int = N_DELTA) -> np.ndarray:
    """Inverse of `encode` (slow, pure Python loop; used once to check a build)."""
    q = np.zeros((n_alpha, n_delta), dtype=np.int64)
    pos = 0
    b = body
    for j in range(n_alpha):
        for i in range(n_delta):
            v = b[pos]
            if v == ESCAPE:
                r = int.from_bytes(b[pos + 1 : pos + 3], "little", signed=True)
                pos += 3
            else:
                r = v - 256 if v > 127 else v
                pos += 1
            if j == 0 and i == 0:
                p = 0
            elif j == 0:
                p = q[0, i - 1]
            elif i == 0:
                p = q[j - 1, 0]
            else:
                p = q[j, i - 1] + q[j - 1, i] - q[j - 1, i - 1]
            q[j, i] = p + r
    if pos != len(b):
        raise SystemExit("decode: %d bytes left over" % (len(b) - pos))
    return q
