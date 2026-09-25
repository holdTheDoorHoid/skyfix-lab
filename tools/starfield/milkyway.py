"""Build the Milky Way outline. Development-time only.

    tools/reference/.venv/bin/python -m tools.starfield.milkyway [--png DIR]

Run from the repository root after `python3 -m tools.starfield.deepsky_fetch static`.
Needs numpy (the reference virtualenv has it); nothing else.

This project's own isophotes of the Milky Way, derived from NASA's COBE/DIRBE
Zodi-Subtracted Mission Average maps (LAMBDA): the 1.25 um map (band 1A) for the
starlight and the 100 um map (band 8) as a proxy for the dust that hides it from the
eye. The pixel centres come from NASA's DIRBE sky-map information file, so no
quadrilateralized-cube projection code is needed. The steps:

1. every DIRBE pixel to galactic (l, b) from its J2000 RA/Dec (the standard ICRS to
   galactic rotation), binned onto a 0.5-degree grid;
2. bright point sources (single stars) masked: a pixel more than 4 robust sigma above
   the median of the 3.5-degree box around it takes that median;
3. both maps smoothed with a 1.5-degree Gaussian (normalised convolution, so empty cells
   and the poles need no special case);
4. the starlight weakened by the dust in front of it, as the eye sees it: half of the
   dust column is taken to lie in front of the light as a screen, and the extinction
   the 1.25 um light itself suffered is given back:
   I_vis = I_1.25 exp(-f (tau_V - tau_J)), f = 0.5, tau_J = 0.28 tau_V, with
   A_V = 0.05 mag per MJy/sr of 100 um emission (the scale of Schlegel, Finkbeiner &
   Davis 1998: E(B-V) of about 0.016 per MJy/sr, R_V = 3.1), tau_V capped at 30.
   Near-infrared light passes through most of the Galaxy's dust; this is what brings
   back the dark lane along the plane from Cygnus to Centaurus (the Great Rift) that
   the eye sees. The model and its constants were chosen by comparing quick-look
   images, not fitted: it is a picture, not a measurement;
5. the Magellanic Clouds masked (they are listed as objects instead);
6. contours at four levels, by oriented marching squares: every ring keeps the
   brighter side on its left in (l, b), so a renderer can fill it. The faintest level
   is drawn on the starlight *before* the dust weighting, so it outlines the whole band,
   the Great Rift included; the three brighter levels on the weighted map, where the
   rift and the star clouds show. The weighting only ever dims, so every brighter
   region lies inside the faintest;
7. each ring to J2000 RA/Dec and simplified by Douglas-Peucker on the sphere to 0.2
   degrees; rings shorter than 3 degrees are dropped.

Output: `crates/skyfix-starfield/data/milkyway.bin` (format in the Rust module
`milkyway.rs`) and the `milkyway` section of `deepsky_manifest.json`. With `--png DIR`
it also writes quick-look images of each step.

The outline is a display product, not a measurement: it says where the Milky Way's
glow is, in four steps of brightness, as a smooth-edged picture of the sky.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import struct
import sys
import zlib

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
RAW = os.path.join(HERE, "data", "deepsky")
OUT = os.path.join(REPO, "crates", "skyfix-starfield", "data", "milkyway.bin")
MANIFEST = os.path.join(REPO, "crates", "skyfix-starfield", "data", "deepsky_manifest.json")

STEP_DEG = 0.5
SMOOTH_SIGMA_DEG = 1.5
MASK_BOX = 7  # cells, 3.5 degrees
MASK_SIGMA = 4.0
AV_PER_MJY_SR = 0.05
TAU_J_OVER_TAU_V = 0.28
SCREEN_FRACTION = 0.5
TAU_V_CAP = 30.0
LEVELS_MJY_SR = [0.32, 0.50, 0.80, 1.30]
SIMPLIFY_DEG = 0.2
MIN_RING_DEG = 3.0
#: The Magellanic Clouds (galactic l, b, radius in degrees).
MASKED = [(280.47, -32.89, 6.0), (302.81, -44.33, 3.5)]

#: ICRS to galactic (the Hipparcos definition, ESA 1997, vol. 1, section 1.5.3).
ICRS_TO_GAL = np.array([
    [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
    [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
    [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669],
])

MAGIC = b"SKYFIXMW"
VERSION = 1
#: Coordinates are stored in units of 0.01 degree.
UNIT_DEG = 0.01


# ---------------------------------------------------------------------------
# FITS binary tables (enough of the standard for these three files)
# ---------------------------------------------------------------------------


def read_bintable(path: str) -> np.ndarray:
    data = open(path, "rb").read()
    pos, hdus = 0, []
    while pos < len(data):
        kv = {}
        while True:
            block = data[pos:pos + 2880]
            pos += 2880
            end = False
            for i in range(36):
                card = block[i * 80:(i + 1) * 80].decode("ascii", "replace")
                if card.startswith("END"):
                    end = True
                    break
                if card[8:10] == "= ":
                    kv[card[:8].strip()] = card[10:].split("/")[0].strip().strip("'").strip()
            if end:
                break
        n = 0
        if int(kv.get("NAXIS", 0)):
            n = abs(int(kv["BITPIX"])) // 8
            for k in range(1, int(kv["NAXIS"]) + 1):
                n *= int(kv["NAXIS%d" % k])
            n += int(kv.get("PCOUNT", 0))
        hdus.append((kv, data[pos:pos + n]))
        pos += (n + 2879) // 2880 * 2880
    kv, raw = next(h for h in hdus if h[0].get("XTENSION") == "BINTABLE")
    types = {"J": ">i4", "E": ">f4", "B": "u1", "I": ">i2", "D": ">f8"}
    dt = [(kv["TTYPE%d" % i].strip(), types[kv["TFORM%d" % i].strip()[-1]])
          for i in range(1, int(kv["TFIELDS"]) + 1)]
    rows = int(kv["NAXIS2"])
    table = np.frombuffer(raw[:rows * int(kv["NAXIS1"])], dtype=np.dtype(dt))
    return table


# ---------------------------------------------------------------------------
# Grid, masking, smoothing
# ---------------------------------------------------------------------------


NL = int(round(360 / STEP_DEG))
NB = int(round(180 / STEP_DEG)) + 1


def radec_to_lb(ra_deg: np.ndarray, dec_deg: np.ndarray):
    a, d = np.radians(ra_deg), np.radians(dec_deg)
    v = np.stack([np.cos(d) * np.cos(a), np.cos(d) * np.sin(a), np.sin(d)])
    g = ICRS_TO_GAL @ v
    return (np.degrees(np.arctan2(g[1], g[0])) % 360.0,
            np.degrees(np.arcsin(np.clip(g[2], -1.0, 1.0))))


def binned(il, ib, val):
    s = np.zeros((NB, NL))
    c = np.zeros((NB, NL))
    np.add.at(s, (ib, il), val)
    np.add.at(c, (ib, il), 1.0)
    return s, c


def gauss(sigma_cells: float) -> np.ndarray:
    n = int(4 * sigma_cells) + 1
    x = np.arange(-n, n + 1)
    k = np.exp(-0.5 * (x / sigma_cells) ** 2)
    return k / k.sum()


def smooth(s, c, sigma_deg):
    """Normalised convolution: smooth the sums and the counts, divide. In latitude a
    plain Gaussian; in longitude a circular one widened by 1/cos b, so the kernel has
    the same width on the sky at every latitude (a whole row near the poles)."""
    kb = gauss(sigma_deg / STEP_DEG)
    S = np.apply_along_axis(lambda x: np.convolve(x, kb, mode="same"), 0, s)
    C = np.apply_along_axis(lambda x: np.convolve(x, kb, mode="same"), 0, c)
    for j in range(NB):
        cb = math.cos(math.radians(-90.0 + j * STEP_DEG))
        sl = sigma_deg / STEP_DEG / max(cb, 1e-3)
        if 8 * sl > NL:
            S[j, :] = S[j, :].mean()
            C[j, :] = C[j, :].mean()
            continue
        kl = gauss(sl)
        n = len(kl) // 2
        S[j, :] = np.convolve(np.concatenate([S[j, -n:], S[j, :], S[j, :n]]), kl, mode="valid")
        C[j, :] = np.convolve(np.concatenate([C[j, -n:], C[j, :], C[j, :n]]), kl, mode="valid")
    return S / np.maximum(C, 1e-12)


def mask_point_sources(I, il, ib):
    from numpy.lib.stride_tricks import sliding_window_view as windows

    s, c = binned(il, ib, I)
    raw = np.where(c > 0, s / np.maximum(c, 1e-12), np.nan)
    ref = smooth(s, c, STEP_DEG * 1.5)
    filled = np.where(np.isnan(raw), ref, raw)
    p = MASK_BOX // 2
    padded = np.pad(filled, ((p, p), (0, 0)), mode="edge")
    padded = np.concatenate([padded[:, -p:], padded, padded[:, :p]], axis=1)
    w = windows(padded, (MASK_BOX, MASK_BOX))
    med = np.median(w, axis=(2, 3))
    mad = np.median(np.abs(w - med[:, :, None, None]), axis=(2, 3))
    threshold = med[ib, il] + MASK_SIGMA * 1.4826 * mad[ib, il] + 0.05
    hit = I > threshold
    return np.where(hit, med[ib, il], I), int(hit.sum())


# ---------------------------------------------------------------------------
# Oriented marching squares on a grid periodic in longitude
# ---------------------------------------------------------------------------


def contour_rings(V: np.ndarray, level: float):
    """Closed rings of V = level, as lists of (x, y) in cell units (x = l / STEP,
    y = (b + 90) / STEP), each with V > level on its left."""
    nb, nl = V.shape
    hi = V > level

    def crossing(edge):
        kind, i, j = edge
        if kind == "h":  # between (i, j) and (i + 1, j)
            a, b = V[j, i], V[j, (i + 1) % nl]
            t = (level - a) / (b - a)
            return (i + t, j)
        a, b = V[j, i], V[j + 1, i]  # "v": between (i, j) and (i, j + 1)
        t = (level - a) / (b - a)
        return (i, j + t)

    nxt = {}
    for j in range(nb - 1):
        for i in range(nl):
            i1 = (i + 1) % nl
            corners = [(i, j), (i1, j), (i1, j + 1), (i, j + 1)]  # counter-clockwise
            h = [hi[cj, ci] for ci, cj in corners]
            if all(h) or not any(h):
                continue
            edges = [("h", i, j), ("v", i1, j), ("h", i, j + 1), ("v", i, j)]
            starts, ends = [], []
            for k in range(4):
                if h[k] and not h[(k + 1) % 4]:
                    starts.append(k)
                elif not h[k] and h[(k + 1) % 4]:
                    ends.append(k)
            if len(starts) == 1:
                pairs = [(starts[0], ends[0])]
            else:
                centre = V[j, i] + V[j, i1] + V[j + 1, i1] + V[j + 1, i]
                # Saddle: joined high corners when the centre is high.
                s0, s1 = starts
                e_after = lambda s: next(e for e in [(s + d) % 4 for d in (1, 2, 3)] if e in ends)
                if centre / 4.0 > level:
                    pairs = [(s0, e_after(s0)), (s1, e_after(s1))]
                else:
                    e_before = lambda s: next(e for e in [(s - d) % 4 for d in (1, 2, 3)] if e in ends)
                    pairs = [(s0, e_before(s0)), (s1, e_before(s1))]
            for s, e in pairs:
                nxt[edges[s]] = edges[e]
    rings = []
    seen = set()
    for start in list(nxt):
        if start in seen:
            continue
        ring, e = [], start
        while e not in seen:
            seen.add(e)
            ring.append(crossing(e))
            e = nxt[e]
        if e != start:
            raise ValueError("an open contour: the grid must be below every level at the poles")
        rings.append(ring)
    return rings


# ---------------------------------------------------------------------------
# Sphere helpers, simplification, encoding
# ---------------------------------------------------------------------------


def lb_to_radec_unit(l_deg, b_deg):
    lr, br = math.radians(l_deg), math.radians(b_deg)
    g = np.array([math.cos(br) * math.cos(lr), math.cos(br) * math.sin(lr), math.sin(br)])
    return ICRS_TO_GAL.T @ g


def angle(u, v):
    return math.atan2(np.linalg.norm(np.cross(u, v)), float(np.dot(u, v)))


def seg_distance(p, a, b):
    """Angular distance from p to the great-circle arc a-b, radians."""
    n = np.cross(a, b)
    nn = np.linalg.norm(n)
    if nn < 1e-15:
        return angle(p, a)
    n /= nn
    d = abs(math.asin(max(-1.0, min(1.0, float(np.dot(p, n))))))
    # The foot of the perpendicular must lie on the arc; otherwise the nearer end.
    q = p - np.dot(p, n) * n
    if np.dot(np.cross(a, q), n) >= 0 and np.dot(np.cross(q, b), n) >= 0:
        return d
    return min(angle(p, a), angle(p, b))


def dp(points, tol_rad):
    """Douglas-Peucker on a list of unit vectors (open polyline, ends kept)."""
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = points[i], points[j]
        dmax, kmax = -1.0, -1
        for k in range(i + 1, j):
            d = seg_distance(points[k], a, b)
            if d > dmax:
                dmax, kmax = d, k
        if dmax > tol_rad:
            keep[kmax] = True
            stack.append((i, kmax))
            stack.append((kmax, j))
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(points, tol_rad):
    """A closed ring: split at the first point and the point farthest from it, simplify
    both halves, join (the ring's last point is not repeated)."""
    far = max(range(len(points)), key=lambda k: angle(points[0], points[k]))
    first = dp(points[:far + 1], tol_rad)
    second = dp(points[far:] + [points[0]], tol_rad)
    return first[:-1] + second[:-1]


def to_radec(u):
    ra = math.degrees(math.atan2(u[1], u[0])) % 360.0
    dec = math.degrees(math.asin(max(-1.0, min(1.0, float(u[2])))))
    return ra, dec


def zigzag(n: int) -> int:
    return (n << 1) ^ (n >> 63)


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def encode(rings_by_level) -> bytes:
    """Header: magic, u16 version, u16 level count, per level f32 MJy/sr; u32 ring count.
    Per ring: u8 level index, u32 point count, first point as u16 RA and i16 Dec (units
    of 0.01 deg), then zigzag varint deltas (RA wrapped to (-180, 180] deg)."""
    out = bytearray(MAGIC)
    out += struct.pack("<HH", VERSION, len(LEVELS_MJY_SR))
    for lv in LEVELS_MJY_SR:
        out += struct.pack("<f", lv)
    rings = [(k, r) for k, rs in enumerate(rings_by_level) for r in rs]
    out += struct.pack("<I", len(rings))
    full = round(360.0 / UNIT_DEG)
    for k, ring in rings:
        q = [(round(ra / UNIT_DEG) % full, round(dec / UNIT_DEG)) for ra, dec in ring]
        out += struct.pack("<BI", k, len(q))
        out += struct.pack("<Hh", q[0][0], q[0][1])
        for (a0, d0), (a1, d1) in zip(q, q[1:]):
            da = (a1 - a0 + full // 2) % full - full // 2
            out += varint(zigzag(da)) + varint(zigzag(d1 - d0))
    return bytes(out)


# ---------------------------------------------------------------------------
# Quick-look images
# ---------------------------------------------------------------------------


def png(path, img):
    h, w = img.shape
    raw = b"".join(b"\x00" + bytes(row) for row in np.clip(img, 0, 255).astype(np.uint8))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def sky_image(m):
    """Galactic map, l = 0 at the centre and increasing to the left, b up."""
    return np.roll(m[::-1, ::-1], NL // 2, axis=1)


def main(argv) -> int:
    pngdir = argv[argv.index("--png") + 1] if "--png" in argv else None
    b1 = read_bintable(os.path.join(RAW, "DIRBE_BAND1A_ZSMA.FITS"))
    b8 = read_bintable(os.path.join(RAW, "DIRBE_BAND08_ZSMA.FITS"))
    info = read_bintable(os.path.join(RAW, "DIRBE_SKYMAP_INFO.FITS"))
    n = len(info)
    for t in (b1, b8):
        if len(t) != n or not (t["Pixel_no"] == info["QSPIXEL"]).all():
            raise ValueError("the maps and the pixel file disagree on pixel numbers")
    l, b = radec_to_lb(info["RA---CSC"].astype(float), info["DEC--CSC"].astype(float))
    # The pixel file's own galactic columns agree (they are float32).
    dl = (l - info["GLON-CSC"].astype(float) + 180.0) % 360.0 - 180.0
    worst = float(np.max(np.hypot(dl * np.cos(np.radians(b)), b - info["GLAT-CSC"].astype(float))))
    if worst > 0.01:
        raise ValueError("galactic coordinates disagree with the pixel file by %.4f deg" % worst)
    il = np.floor(l / STEP_DEG + 0.5).astype(int) % NL
    ib = np.clip(np.floor((b + 90.0) / STEP_DEG + 0.5).astype(int), 0, NB - 1)

    I1, masked = mask_point_sources(b1["Resid"].astype(float), il, ib)
    m1 = smooth(*binned(il, ib, I1), SMOOTH_SIGMA_DEG)
    m8 = smooth(*binned(il, ib, b8["Resid"].astype(float)), SMOOTH_SIGMA_DEG)
    tau_v = np.minimum(AV_PER_MJY_SR * np.maximum(m8, 0.0) / 1.086, TAU_V_CAP)
    vis = m1 * np.exp(-SCREEN_FRACTION * (1.0 - TAU_J_OVER_TAU_V) * tau_v)
    # The Magellanic Clouds: set to the background level.
    gl = np.arange(NL) * STEP_DEG
    gb = -90.0 + np.arange(NB) * STEP_DEG
    L, B = np.meshgrid(gl, gb)
    for l0, b0, r in MASKED:
        c = (np.sin(np.radians(B)) * math.sin(math.radians(b0))
             + np.cos(np.radians(B)) * math.cos(math.radians(b0)) * np.cos(np.radians(L - l0)))
        vis = np.where(c > math.cos(math.radians(r)), min(LEVELS_MJY_SR) * 0.5, vis)

    # The faintest level on the unweighted starlight (Clouds masked the same way).
    band = m1.copy()
    for l0, b0, r in MASKED:
        c = (np.sin(np.radians(B)) * math.sin(math.radians(b0))
             + np.cos(np.radians(B)) * math.cos(math.radians(b0)) * np.cos(np.radians(L - l0)))
        band = np.where(c > math.cos(math.radians(r)), min(LEVELS_MJY_SR) * 0.5, band)

    rings_by_level, stats = [], []
    tol = math.radians(SIMPLIFY_DEG)
    for k, level in enumerate(LEVELS_MJY_SR):
        kept, points_in, dropped = [], 0, 0
        for ring in contour_rings(band if k == 0 else vis, level):
            pts = [lb_to_radec_unit(x * STEP_DEG, -90.0 + y * STEP_DEG) for x, y in ring]
            length = sum(angle(pts[k], pts[(k + 1) % len(pts)]) for k in range(len(pts)))
            if math.degrees(length) < MIN_RING_DEG:
                dropped += 1
                continue
            points_in += len(pts)
            simple = simplify_ring(pts, tol)
            kept.append([to_radec(u) for u in simple])
        rings_by_level.append(kept)
        stats.append({"level_mjy_sr": level, "rings": len(kept), "rings_dropped_small": dropped,
                      "points_before": points_in, "points": sum(len(r) for r in kept)})

    blob = encode(rings_by_level)
    with open(OUT, "wb") as f:
        f.write(blob)

    if pngdir:
        os.makedirs(pngdir, exist_ok=True)
        lg = np.log10(np.maximum(vis, 1e-3))
        lo, hi = np.percentile(lg, 5), np.percentile(lg, 99.7)
        png(os.path.join(pngdir, "milkyway_vis.png"), sky_image((lg - lo) / (hi - lo) * 255))
        lv = np.zeros_like(vis)
        for k, level in enumerate(LEVELS_MJY_SR):
            lv[(band if k == 0 else vis) > level] = (k + 1) * 255 / len(LEVELS_MJY_SR)
        png(os.path.join(pngdir, "milkyway_levels.png"), sky_image(lv))

    with open(os.path.join(RAW, "provenance.json"), encoding="utf-8") as f:
        prov = json.load(f)["files"]
    manifest = {}
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            manifest = json.load(f)
    manifest["milkyway"] = {
        "generator": "tools/starfield/milkyway.py",
        "inputs": {k: {kk: prov[k][kk] for kk in ("url", "retrieved_utc", "size_bytes", "sha256")}
                   for k in ("DIRBE_BAND1A_ZSMA.FITS", "DIRBE_BAND08_ZSMA.FITS", "DIRBE_SKYMAP_INFO.FITS")},
        "parameters": {"grid_deg": STEP_DEG, "smooth_sigma_deg": SMOOTH_SIGMA_DEG,
                       "point_source_box_deg": MASK_BOX * STEP_DEG, "point_source_sigma": MASK_SIGMA,
                       "av_per_mjy_sr_100um": AV_PER_MJY_SR, "tau_j_over_tau_v": TAU_J_OVER_TAU_V,
                       "screen_fraction": SCREEN_FRACTION, "tau_v_cap": TAU_V_CAP,
                       "levels_mjy_sr": LEVELS_MJY_SR, "simplify_deg": SIMPLIFY_DEG,
                       "min_ring_deg": MIN_RING_DEG, "masked_l_b_radius_deg": MASKED,
                       "unit_deg": UNIT_DEG},
        "checks": {"pixels_masked_as_point_sources": masked,
                   "galactic_vs_pixel_file_max_deg": round(worst, 6)},
        "levels": stats,
        "bytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    print(json.dumps(stats, indent=1))
    print("milkyway.bin: %d bytes, %d rings, %d points" % (
        len(blob), sum(s["rings"] for s in stats), sum(s["points"] for s in stats)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
