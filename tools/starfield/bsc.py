"""Parsing helpers for the star field's raw inputs. Development-time only.

Pure standard library. The fixture generator (`gen_fixtures.py`) deliberately does NOT
use the star parsing here: it parses the raw HEASARC table again with its own code, so
an encoding mistake in the embedded data cannot be copied into the fixture that is
meant to catch it.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DATA = os.path.join(HERE, "data")
BSC5P_FILE = os.path.join(DATA, "bsc5p.txt")
BOUNDARIES_FILE = os.path.join(DATA, "bound_18.dat")

# ---------------------------------------------------------------------------
# The 88 constellations: IAU abbreviation, name. Order = the index stored in the data.
# ---------------------------------------------------------------------------

CONSTELLATIONS = [
    ("And", "Andromeda"), ("Ant", "Antlia"), ("Aps", "Apus"), ("Aqr", "Aquarius"),
    ("Aql", "Aquila"), ("Ara", "Ara"), ("Ari", "Aries"), ("Aur", "Auriga"),
    ("Boo", "Boötes"), ("Cae", "Caelum"), ("Cam", "Camelopardalis"), ("Cnc", "Cancer"),
    ("CVn", "Canes Venatici"), ("CMa", "Canis Major"), ("CMi", "Canis Minor"),
    ("Cap", "Capricornus"), ("Car", "Carina"), ("Cas", "Cassiopeia"), ("Cen", "Centaurus"),
    ("Cep", "Cepheus"), ("Cet", "Cetus"), ("Cha", "Chamaeleon"), ("Cir", "Circinus"),
    ("Col", "Columba"), ("Com", "Coma Berenices"), ("CrA", "Corona Australis"),
    ("CrB", "Corona Borealis"), ("Crv", "Corvus"), ("Crt", "Crater"), ("Cru", "Crux"),
    ("Cyg", "Cygnus"), ("Del", "Delphinus"), ("Dor", "Dorado"), ("Dra", "Draco"),
    ("Equ", "Equuleus"), ("Eri", "Eridanus"), ("For", "Fornax"), ("Gem", "Gemini"),
    ("Gru", "Grus"), ("Her", "Hercules"), ("Hor", "Horologium"), ("Hya", "Hydra"),
    ("Hyi", "Hydrus"), ("Ind", "Indus"), ("Lac", "Lacerta"), ("Leo", "Leo"),
    ("LMi", "Leo Minor"), ("Lep", "Lepus"), ("Lib", "Libra"), ("Lup", "Lupus"),
    ("Lyn", "Lynx"), ("Lyr", "Lyra"), ("Men", "Mensa"), ("Mic", "Microscopium"),
    ("Mon", "Monoceros"), ("Mus", "Musca"), ("Nor", "Norma"), ("Oct", "Octans"),
    ("Oph", "Ophiuchus"), ("Ori", "Orion"), ("Pav", "Pavo"), ("Peg", "Pegasus"),
    ("Per", "Perseus"), ("Phe", "Phoenix"), ("Pic", "Pictor"), ("Psc", "Pisces"),
    ("PsA", "Piscis Austrinus"), ("Pup", "Puppis"), ("Pyx", "Pyxis"), ("Ret", "Reticulum"),
    ("Sge", "Sagitta"), ("Sgr", "Sagittarius"), ("Sco", "Scorpius"), ("Scl", "Sculptor"),
    ("Sct", "Scutum"), ("Ser", "Serpens"), ("Sex", "Sextans"), ("Tau", "Taurus"),
    ("Tel", "Telescopium"), ("Tri", "Triangulum"), ("TrA", "Triangulum Australe"),
    ("Tuc", "Tucana"), ("UMa", "Ursa Major"), ("UMi", "Ursa Minor"), ("Vel", "Vela"),
    ("Vir", "Virgo"), ("Vol", "Volans"), ("Vul", "Vulpecula"),
]
assert len(CONSTELLATIONS) == 88
ABBR_INDEX = {a: i for i, (a, _) in enumerate(CONSTELLATIONS)}
ABBR_BY_UPPER = {a.upper(): a for a, _ in CONSTELLATIONS}

#: BSC5 three-letter Greek abbreviations, in alphabet order. Index + 1 is the code
#: stored in the embedded data (0 = no Bayer letter).
GREEK = [
    ("Alp", "α"), ("Bet", "β"), ("Gam", "γ"), ("Del", "δ"), ("Eps", "ε"), ("Zet", "ζ"),
    ("Eta", "η"), ("The", "θ"), ("Iot", "ι"), ("Kap", "κ"), ("Lam", "λ"), ("Mu", "μ"),
    ("Nu", "ν"), ("Xi", "ξ"), ("Omi", "ο"), ("Pi", "π"), ("Rho", "ρ"), ("Sig", "σ"),
    ("Tau", "τ"), ("Ups", "υ"), ("Phi", "φ"), ("Chi", "χ"), ("Psi", "ψ"), ("Ome", "ω"),
]
GREEK_CODE = {abbr: i + 1 for i, (abbr, _) in enumerate(GREEK)}
GREEK_LETTER = {i + 1: letter for i, (_, letter) in enumerate(GREEK)}
SUPERSCRIPT = {1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹"}


@dataclass
class Star:
    hr: int
    ra_tenth_s: int  # J2000 RA, units of 0.1 s of time
    dec_arcsec: int  # J2000 Dec, arcseconds (signed)
    pm_ra_mas: int  # mu_alpha * cos(delta), mas/yr
    pm_dec_mas: int
    parallax_mas: int  # >= 0 (negative published values clamped to 0)
    parallax_published_mas: int | None
    vmag_centi: int
    bv_centi: int | None
    bayer: int  # 0 none, 1..24
    bayer_sup: int  # 0 none, 1..9
    flamsteed: int  # 0 none
    const: int  # 0..87, 255 none
    radvel_km_s: int | None
    raw: dict = field(repr=False, default_factory=dict)

    @property
    def ra_deg(self) -> float:
        return self.ra_tenth_s / 10.0 / 240.0

    @property
    def dec_deg(self) -> float:
        return self.dec_arcsec / 3600.0

    @property
    def vmag(self) -> float:
        return self.vmag_centi / 100.0

    def designation(self) -> str:
        """`α¹ Cru`, `58 Ori`, or `` when the catalogue gives neither."""
        if self.const == 255:
            return ""
        c = CONSTELLATIONS[self.const][0]
        if self.bayer:
            return GREEK_LETTER[self.bayer] + SUPERSCRIPT.get(self.bayer_sup, "") + " " + c
        if self.flamsteed:
            return "%d %s" % (self.flamsteed, c)
        return ""

    def ascii_designation(self) -> str:
        if self.const == 255:
            return "HR %d" % self.hr
        c = CONSTELLATIONS[self.const][0]
        if self.bayer:
            g = GREEK[self.bayer - 1][0]
            return "%s%s %s" % (g, self.bayer_sup or "", c)
        if self.flamsteed:
            return "%d %s" % (self.flamsteed, c)
        return "HR %d" % self.hr


def _null(v: str) -> bool:
    v = v.strip()
    return v == "" or v == "null"


def read_table(path: str = BSC5P_FILE):
    """Rows of the HEASARC text/plain table as dicts of raw strings."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    header = [h.strip() for h in lines[0].split("|")]
    rows = []
    declared = None
    for line in lines[1:]:
        if line.startswith("Number of rows:"):
            declared = int(line.split(":")[1])
            continue
        if not line.strip() or line.startswith("Number of"):
            continue
        parts = line.split("|")
        if len(parts) != len(header):
            raise ValueError("malformed row: %r" % line)
        rows.append(dict(zip(header, parts)))
    if declared is None or declared != len(rows):
        raise ValueError("row count %d does not match the declared %r" % (len(rows), declared))
    return header, rows


def parse_ra(cra: str) -> int:
    """`HHMMSS.S` -> tenths of a second of time."""
    s = cra.strip()
    m = re.fullmatch(r"(\d\d)(\d\d)(\d\d)\.(\d)", s)
    if not m:
        raise ValueError("bad RA %r" % cra)
    h, mi, se, t = (int(x) for x in m.groups())
    if not (h < 24 and mi < 60 and se < 60):
        raise ValueError("bad RA %r" % cra)
    return ((h * 60 + mi) * 60 + se) * 10 + t


def parse_dec(cdec: str) -> int:
    """`+DDMMSS` -> signed arcseconds. The sign is its own character, so `-003011`
    (minus zero degrees) stays negative."""
    s = cdec.strip()
    m = re.fullmatch(r"([+-])(\d\d)(\d\d)(\d\d)", s)
    if not m:
        raise ValueError("bad Dec %r" % cdec)
    sign = -1 if m.group(1) == "-" else 1
    d, mi, se = (int(x) for x in m.groups()[1:])
    if not (d <= 90 and mi < 60 and se < 60):
        raise ValueError("bad Dec %r" % cdec)
    return sign * ((d * 60 + mi) * 60 + se)


def parse_designation(alt_name: str):
    """BSC5 `Name` field (bytes 5-14: Flamsteed I3, Bayer A3, superscript A1,
    constellation A3), as HEASARC serves it with the leading blanks stripped.

    Returns (bayer_code, superscript, flamsteed, constellation_index)."""
    if _null(alt_name):
        return 0, 0, 0, 255
    f = alt_name.rstrip().rjust(10)
    if len(f) != 10:
        raise ValueError("bad designation %r" % alt_name)
    fl, gr, sup, con = f[0:3], f[3:6].strip(), f[6], f[7:10]
    if con not in ABBR_INDEX:
        raise ValueError("unknown constellation in %r" % alt_name)
    flam = int(fl) if fl.strip() else 0
    bayer = GREEK_CODE[gr] if gr else 0
    if gr and not bayer:
        raise ValueError("unknown Greek letter in %r" % alt_name)
    s = int(sup) if sup.strip() else 0
    return bayer, s, flam, ABBR_INDEX[con]


def load_stars(path: str = BSC5P_FILE):
    """Every stellar entry, and the entries skipped with the reason."""
    _, rows = read_table(path)
    stars, skipped = [], []
    for r in rows:
        hr = int(r["hr"])
        # The 14 non-stellar objects that received HR numbers (novae, clusters, and
        # the galaxy M31's supernova S And) have no catalogue position (HEASARC added
        # one), no magnitude and no proper motion. They are not stars; skip them.
        if _null(r["vmag"]) or _null(r["cra"]) or r["cra"].strip() == "000000.0" or _null(r["pmra"]):
            skipped.append((hr, r["alt_name"].strip(), "non-stellar object: no catalogue "
                            "position, magnitude or proper motion"))
            continue
        ra = parse_ra(r["cra"])
        dec = parse_dec(r["cdec"])
        # Cross-check against HEASARC's decimal copy (rounded to 1e-4 deg on output).
        if abs(ra / 10.0 / 240.0 - float(r["ra"])) > 6e-5 and abs(
            abs(ra / 10.0 / 240.0 - float(r["ra"])) - 360.0
        ) > 6e-5:
            raise ValueError("HR %d: RA %r disagrees with %r" % (hr, r["cra"], r["ra"]))
        if abs(dec / 3600.0 - float(r["dec"])) > 6e-5:
            raise ValueError("HR %d: Dec %r disagrees with %r" % (hr, r["cdec"], r["dec"]))
        pm_ra = round(float(r["pmra"]) * 1000.0)
        pm_dec = round(float(r["pmdec"]) * 1000.0)
        plx_pub = None if _null(r["parallax"]) else round(float(r["parallax"]) * 1000.0)
        plx = max(plx_pub or 0, 0)
        vm = round(float(r["vmag"]) * 100.0)
        bv = None if _null(r["bv_color"]) else round(float(r["bv_color"]) * 100.0)
        bayer, sup, flam, con = parse_designation(r["alt_name"])
        rv = None if _null(r["radvel"]) else int(r["radvel"])
        stars.append(
            Star(hr, ra, dec, pm_ra, pm_dec, plx, plx_pub, vm, bv, bayer, sup, flam, con, rv, r)
        )
    return stars, skipped


# ---------------------------------------------------------------------------
# Boundaries (Delporte 1930, B1875.0, via Davenhall & Leggett 1989)
# ---------------------------------------------------------------------------


@dataclass
class Polygon:
    key: str  # file label: "AND", "SER1", ...
    abbr: str  # IAU abbreviation: "And", "Ser"
    vertices: list  # [(ra_seconds_of_time, dec_arcmin)]


def load_boundaries(path: str = BOUNDARIES_FILE):
    """Polygons in file order. RA snapped to whole seconds of time and Dec to whole
    arcminutes: every vertex in Delporte's lists is on that grid, and the file's
    5-decimal rendering (worst residual 0.012 s and 0.024") is undone exactly."""
    polys: dict[str, Polygon] = {}
    order = []
    with open(path, encoding="ascii") as f:
        for line in f:
            if not line.strip():
                continue
            ra_h = float(line[0:8])
            dec_d = float(line[9:18])
            key = line[19:23].strip()
            kind = line[24:25]
            if kind != "O":
                raise ValueError("unexpected point type %r" % line)
            ra_s = round(ra_h * 3600.0)
            dec_m = round(dec_d * 60.0)
            if abs(ra_s - ra_h * 3600.0) > 0.05 or abs(dec_m - dec_d * 60.0) > 0.01:
                raise ValueError("vertex off the 1 s / 1' grid: %r" % line)
            abbr = ABBR_BY_UPPER.get(key[:3]) if key.startswith("SER") else ABBR_BY_UPPER.get(key)
            if abbr is None:
                raise ValueError("unknown constellation %r" % key)
            if key not in polys:
                polys[key] = Polygon(key, abbr, [])
                order.append(key)
            polys[key].vertices.append((ra_s, dec_m))
    return [polys[k] for k in order]
