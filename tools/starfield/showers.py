"""Check and build the meteor-shower table. Development-time only.

    python3 -m tools.starfield.showers            # check, then write
    python3 -m tools.starfield.showers --compare  # print both sources beside ours

Run from the repository root after `python3 -m tools.starfield.deepsky_fetch static`.
Needs `pdftotext` (poppler-utils) to read the IMO calendars.

The table itself is this project's own compilation, `tools/starfield/showers_table.txt`
(written by hand from the two sources below; it copies neither's table or prose). This
script cross-checks every value we compiled against:

* the IAU Meteor Data Center's list of established showers (MDC 2022, updated
  2026-09-21): the median over each shower's parameter sets of the solar longitude,
  radiant, daily drift and geocentric velocity, and the parent body;
* the International Meteor Organization's 2026 and 2027 calendars (Table 5, the working
  list of visual showers): peak solar longitude, radiant, V-infinity, r and ZHR, and the
  2026 and 2027 peak and activity dates.

It writes

* `crates/skyfix-starfield/data/showers.txt` — the shipped table (see the Rust module
  `showers.rs` for the format);
* `fixtures/reference/showers_reference.json` — the IMO dates for 2026 and 2027 and the
  MDC medians, for `crates/skyfix-starfield/tests/showers_reference.rs`;
* the `showers` section of `crates/skyfix-starfield/data/deepsky_manifest.json`.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
RAW = os.path.join(HERE, "data", "deepsky")
TABLE = os.path.join(HERE, "showers_table.txt")
OUT = os.path.join(REPO, "crates", "skyfix-starfield", "data", "showers.txt")
FIXTURE = os.path.join(REPO, "fixtures", "reference", "showers_reference.json")
MANIFEST = os.path.join(REPO, "crates", "skyfix-starfield", "data", "deepsky_manifest.json")

MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}

#: Tolerances of the cross-check, ours against each source.
TOL_PEAK_DEG = 1.5  # solar longitude of the peak
TOL_RADIANT_DEG = 3.0  # radiant at the peak, great-circle
TOL_SPEED_KMS = 3.0
TOL_DRIFT_DEG_PER_DAY = 0.25


# ---------------------------------------------------------------------------
# IMO calendar, Table 5
# ---------------------------------------------------------------------------


def pdf_text(name: str) -> str:
    return subprocess.run(["pdftotext", "-layout", os.path.join(RAW, name), "-"],
                          check=True, capture_output=True, text=True).stdout


ROW = re.compile(
    r"^\s*(?P<name>.+?)\s*\((?P<num>\d{3}) (?P<code>[A-Z]{3})\)\s+"
    r"(?P<start>[A-Z][a-z]{2} \d\d)\s*[–-]\s*(?P<end>[A-Z][a-z]{2} \d\d)\s+"
    r"\(?(?P<peak>[A-Z][a-z]{2} \d\d)\)?\s+"
    r"\(?(?P<lam>\d+)\s*◦\s*(?:\.\s*(?P<lamf>\d+))?\s*\)?\s+"
    r"(?P<ra>\d+)◦\s+(?P<dec>[+−-]\d+)◦\s+(?P<v>\d+)\s+(?P<r>\d\.\d)\s+(?P<zhr>Var|\d+\+?)\s*$")


def imo_table(name: str) -> dict:
    """{IAU code: {...}} from Table 5 of one calendar."""
    text = pdf_text(name)
    i = text.index("Table 5. Working List of Visual Meteor Showers")
    j = text.index("Table 6 (next page)", i)
    out = {}
    for line in text[i:j].split("\n"):
        m = ROW.match(line)
        if not m:
            continue
        g = m.groupdict()
        lam = float(g["lam"] + ("." + g["lamf"] if g["lamf"] else ""))
        out[g["code"]] = {
            "iau": int(g["num"]), "name": g["name"].strip(),
            "start": g["start"], "end": g["end"], "peak": g["peak"],
            "peak_lambda_deg": lam, "ra_deg": float(g["ra"]),
            "dec_deg": float(g["dec"].replace("−", "-")),
            "v_inf_kms": float(g["v"]), "r": float(g["r"]),
            "zhr": g["zhr"],
        }
    return out


# ---------------------------------------------------------------------------
# IAU MDC, established showers
# ---------------------------------------------------------------------------


#: Column positions in the MDC rows (the header's names contain spaces, so the file is
#: read by position): LP, IAUNo, AdNo, Code, s, sub.date, name, activity, LoSb, LoSe,
#: LoS, Ra, De, dRa, dDe, Vg, ..., Origin (parent body) at 31.
MDC_COLUMNS = {"iau": 1, "code": 3, "status": 4, "name": 6, "activity": 7, "LoSb": 8,
               "LoSe": 9, "LoS": 10, "Ra": 11, "De": 12, "dRa": 13, "dDe": 14, "Vg": 15,
               "origin": 31}


def mdc_table() -> dict:
    """{IAU code: {"iau", "name", "sets": [...], "median": {...}, "parents": [...]}} for
    every shower with an established (1) or to-be-established (2) parameter set."""
    path = os.path.join(RAW, "iau_mdc_established_2026.txt")
    with open(path, encoding="latin-1") as f:
        lines = [l for l in f if l.startswith('"')]
    out = {}
    for line in lines:
        cells = [c.strip().strip('"').strip() for c in line.rstrip("\n").split("|")]
        col = {k: cells[i] if i < len(cells) else "" for k, i in MDC_COLUMNS.items()}
        try:
            status = int(col["status"])
        except ValueError:
            continue
        if status not in (1, 2):
            continue
        d = out.setdefault(col["code"], {"iau": int(col["iau"]), "sets": [], "parents": set(),
                                         "name": col["name"]})

        def num(k):
            try:
                return float(col[k])
            except ValueError:
                return None
        d["sets"].append({k: num(k) for k in ("LoSb", "LoSe", "LoS", "Ra", "De", "dRa", "dDe", "Vg")})
        if col["origin"]:
            d["parents"].add(col["origin"])
    for code, d in out.items():
        med = {}
        for k in ("LoSb", "LoSe", "LoS", "Ra", "De", "dRa", "dDe", "Vg"):
            vals = [x[k] for x in d["sets"] if x[k] is not None]
            if k == "Ra" and vals:
                # Radiants near RA 0/360: unwrap around the first value.
                ref = vals[0]
                vals = [ref + ((v - ref + 180.0) % 360.0 - 180.0) for v in vals]
            med[k] = statistics.median(vals) if vals else None
        if med["Ra"] is not None:
            med["Ra"] %= 360.0
        d["median"] = med
        d["parents"] = sorted(d["parents"])
    return out


# ---------------------------------------------------------------------------
# Our table
# ---------------------------------------------------------------------------


FIELDS = ["iau", "code", "name", "lambda_start_deg", "lambda_peak_deg", "lambda_end_deg",
          "ra_deg", "dec_deg", "dra_deg_per_day", "ddec_deg_per_day", "v_inf_kms", "r",
          "zhr", "variable", "parent"]


def read_table() -> list[dict]:
    rows = []
    with open(TABLE, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            line = line.split("#", 1)[0].rstrip()
            if not line.strip():
                continue
            cells = [c.strip() for c in line.split("|")]
            if len(cells) != len(FIELDS):
                raise ValueError("showers_table.txt:%d: %d fields, expected %d" % (n, len(cells), len(FIELDS)))
            r = dict(zip(FIELDS, cells))
            for k in ("lambda_start_deg", "lambda_peak_deg", "lambda_end_deg", "ra_deg", "dec_deg",
                      "dra_deg_per_day", "ddec_deg_per_day", "v_inf_kms", "r"):
                r[k] = float(r[k])
            r["iau"] = int(r["iau"])
            r["zhr"] = int(r["zhr"])
            if r["variable"] not in ("0", "1"):
                raise ValueError("showers_table.txt:%d: variable must be 0 or 1" % n)
            rows.append(r)
    return rows


def sep_deg(ra1, dec1, ra2, dec2):
    a1, d1, a2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    c = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(a1 - a2)
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def v_inf_from_vg(vg: float) -> float:
    """Speed at the top of the atmosphere from the geocentric speed: V_inf^2 = Vg^2 +
    V_esc^2 with the escape speed at 100 km height, 11.1 km/s."""
    return math.sqrt(vg * vg + 11.1 * 11.1)


def compare() -> int:
    imo26, imo27, mdc = imo_table("imo_calendar_2026.pdf"), imo_table("imo_calendar_2027.pdf"), mdc_table()
    codes = sorted(set(imo26) | set(imo27), key=lambda c: (imo27.get(c) or imo26[c])["peak_lambda_deg"])
    for c in codes:
        a, b, m = imo26.get(c), imo27.get(c), mdc.get(c)
        print("%s %s" % (c, (a or b)["name"]))
        for tag, x in (("IMO26", a), ("IMO27", b)):
            if x:
                print("   %s act %s..%s peak %s lam %.2f rad %5.1f %+5.1f V %2.0f r %.1f ZHR %s" % (
                    tag, x["start"], x["end"], x["peak"], x["peak_lambda_deg"], x["ra_deg"],
                    x["dec_deg"], x["v_inf_kms"], x["r"], x["zhr"]))
        if m:
            md = m["median"]
            f = lambda v, p="%.2f": ("-" if v is None else p % v)
            print("   MDC   n=%d LoS %s [%s..%s] rad %s %s drift %s %s Vg %s -> Vinf %s  %s" % (
                len(m["sets"]), f(md["LoS"]), f(md["LoSb"], "%.0f"), f(md["LoSe"], "%.0f"),
                f(md["Ra"], "%.1f"), f(md["De"], "%+.1f"), f(md["dRa"]), f(md["dDe"]),
                f(md["Vg"], "%.1f"), f(md["Vg"] and v_inf_from_vg(md["Vg"]), "%.1f"),
                "; ".join(m["parents"])[:80]))
        else:
            print("   MDC   (not an established shower)")
    return 0


#: Where our table departs from a source on purpose, and why.
EXCEPTIONS = {
    ("KCG", "imo_radiant"): "Table 5 of the IMO calendars gives (286, +59); their own "
                            "Table 6 and the MDC give a radiant drifting north 0.67 deg/day "
                            "that stands at (288, +54) on the peak date, which we use",
    ("PHO", "mdc_radiant"): "the MDC's two parameter sets for the Phoenicids lie 9 deg "
                            "apart; we keep the IMO's radiant",
    ("PHO", "mdc_lambda"): "the MDC's two Phoenicid parameter sets average 251.65 deg; "
                           "we keep the IMO's peak, 249.5",
}


def date_of(year: int, mmm_dd: str) -> str:
    mon, day = mmm_dd.split()
    return "%04d-%02d-%02d" % (year, MONTHS[mon], int(day))


def imo_dates(t: dict, year: int) -> dict:
    """ISO dates of the peak and activity limits in `year`'s calendar."""
    ms, me, mp = (MONTHS[t[k].split()[0]] for k in ("start", "end", "peak"))
    ys = year - 1 if ms > me and mp <= me else year
    ye = year + 1 if ms > me and mp >= ms else year
    return {"peak": date_of(year, t["peak"]), "start": date_of(ys, t["start"]),
            "end": date_of(ye, t["end"]), "peak_lambda_deg": t["peak_lambda_deg"]}


def wrap180(x: float) -> float:
    return (x + 180.0) % 360.0 - 180.0


def build() -> int:
    ours = read_table()
    imo = {2026: imo_table("imo_calendar_2026.pdf"), 2027: imo_table("imo_calendar_2027.pdf")}
    mdc = mdc_table()
    problems, used = [], set()

    def check(ok: bool, code: str, what: str, msg: str):
        if ok:
            return
        if (code, what) in EXCEPTIONS:
            used.add((code, what))
            return
        problems.append("%s %s: %s" % (code, what, msg))

    report = []
    for r in ours:
        c = r["code"]
        span = (r["lambda_end_deg"] - r["lambda_start_deg"]) % 360.0
        check((r["lambda_peak_deg"] - r["lambda_start_deg"]) % 360.0 <= span, c, "order",
              "the peak lies outside the activity period")
        m = mdc.get(c)
        check(m is not None and m["iau"] == r["iau"], c, "mdc", "not an established MDC shower "
              "with IAU number %d" % r["iau"])
        if m is None:
            continue
        md = m["median"]
        row = {"code": c, "iau": r["iau"], "mdc_sets": len(m["sets"])}
        for year, t in imo.items():
            x = t.get(c)
            check(x is not None, c, "imo_%d" % year, "not in the IMO %d working list" % year)
            if x is None:
                continue
            check(abs(x["peak_lambda_deg"] - r["lambda_peak_deg"]) < 0.005, c, "imo_lambda",
                  "peak %.2f, the IMO %d has %.2f" % (r["lambda_peak_deg"], year, x["peak_lambda_deg"]))
            d = sep_deg(r["ra_deg"], r["dec_deg"], x["ra_deg"], x["dec_deg"])
            check(d <= 2.0, c, "imo_radiant", "%.1f deg from the IMO %d radiant" % (d, year))
            check(abs(x["v_inf_kms"] - r["v_inf_kms"]) <= 1.0, c, "imo_speed", "V_inf")
            check(abs(x["r"] - r["r"]) < 0.05, c, "imo_r", "population index")
            zhr = x["zhr"].rstrip("+")
            check((zhr == "Var" and r["variable"] == "1") or (zhr != "Var" and abs(int(zhr) - r["zhr"]) <= 10),
                  c, "imo_zhr", "ZHR %d vs %s" % (r["zhr"], x["zhr"]))
            row["imo_%d" % year] = imo_dates(x, year)
            row["imo_%d_radiant_sep_deg" % year] = round(d, 2)
        # MDC: the radiant at our peak (the MDC median moved along its drift), the speed,
        # the drift itself, and the peak against the MDC's activity-mean longitude.
        dl = wrap180(r["lambda_peak_deg"] - md["LoS"])
        ra_m = md["Ra"] + md["dRa"] * dl
        de_m = md["De"] + md["dDe"] * dl
        d = sep_deg(r["ra_deg"], r["dec_deg"], ra_m, de_m)
        check(d <= TOL_RADIANT_DEG, c, "mdc_radiant", "%.1f deg from the MDC radiant moved to our peak" % d)
        vinf = v_inf_from_vg(md["Vg"])
        check(abs(vinf - r["v_inf_kms"]) <= TOL_SPEED_KMS, c, "mdc_speed", "V_inf %.0f vs %.1f from Vg %.1f"
              % (r["v_inf_kms"], vinf, md["Vg"]))
        check(abs(r["dra_deg_per_day"] - md["dRa"]) <= 0.006 and abs(r["ddec_deg_per_day"] - md["dDe"]) <= 0.006,
              c, "mdc_drift", "drift (%.2f, %.2f) vs the MDC median (%.3f, %.3f)"
              % (r["dra_deg_per_day"], r["ddec_deg_per_day"], md["dRa"], md["dDe"]))
        tol = max(2.0, 0.25 * span)
        check(abs(dl) <= tol, c, "mdc_lambda", "peak %.2f vs the MDC's mean %.2f (tolerance %.1f)"
              % (r["lambda_peak_deg"], md["LoS"], tol))
        if r["parent"]:
            # Compare by the body's name: the part in brackets, else after the last '/',
            # else the whole designation ("289P/Blanpain" is the MDC's "D/1819 W1
            # (Blanpain)", "(3200) Phaethon" its "3200 Phaethon").
            p = r["parent"]
            key = (re.search(r"\(([^)]+)\)", p).group(1) if "(" in p and not p.startswith("(")
                   else p.split(")")[-1] if p.startswith("(") else p.split("/")[-1])
            key = re.sub(r"\W", "", key).lower()
            check(any(key in re.sub(r"\W", "", q).lower() for q in m["parents"]), c, "mdc_parent",
                  "parent %r not among the MDC's %s" % (r["parent"], m["parents"]))
        row.update({"mdc_radiant_sep_deg": round(d, 2), "mdc_lambda_diff_deg": round(dl, 2),
                    "mdc_vinf_kms": round(vinf, 1), "mdc_median": {k: md[k] for k in ("LoS", "Ra", "De", "dRa", "dDe", "Vg")}})
        report.append(row)

    unused = set(EXCEPTIONS) - used
    if unused:
        problems.append("exceptions no longer needed: %s" % sorted(unused))
    if problems:
        print("%d problem(s):" % len(problems))
        for p in problems:
            print("  " + p)
        return 1

    header = ("# tools/starfield/showers.py; iau|code|name|l_start|l_peak|l_end|ra|dec|dra|ddec|"
              "v_inf|r|zhr|var|parent (showers.rs)\n")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(header)
        for r in ours:
            f.write("%d|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%d|%s|%s\n" % (
                r["iau"], r["code"], r["name"], fmt(r["lambda_start_deg"]), fmt(r["lambda_peak_deg"]),
                fmt(r["lambda_end_deg"]), fmt(r["ra_deg"]), fmt(r["dec_deg"]), fmt(r["dra_deg_per_day"]),
                fmt(r["ddec_deg_per_day"]), fmt(r["v_inf_kms"]), fmt(r["r"]), r["zhr"], r["variable"],
                r["parent"]))
    with open(FIXTURE, "w", encoding="utf-8") as f:
        json.dump({"schema": "skyfix.reference/1", "generator": "tools/starfield/showers.py",
                   "description": "Meteor-shower cross-check: the IMO 2026 and 2027 calendars' "
                                  "peak and activity dates and the IAU MDC medians for every "
                                  "shower in SkyFix Lab's table. Display-only data.",
                   "exceptions": {"%s %s" % k: v for k, v in sorted(EXCEPTIONS.items())},
                   "showers": report}, f, indent=1, ensure_ascii=False)
        f.write("\n")
    manifest = {}
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            manifest = json.load(f)
    with open(os.path.join(RAW, "provenance.json"), encoding="utf-8") as f:
        prov = json.load(f)["files"]
    seps = [x["imo_2026_radiant_sep_deg"] for x in report]
    manifest["showers"] = {
        "generator": "tools/starfield/showers.py",
        "inputs": {k: {kk: prov[k][kk] for kk in ("url", "retrieved_utc", "size_bytes", "sha256")}
                   for k in ("iau_mdc_established_2026.txt", "imo_calendar_2026.pdf", "imo_calendar_2027.pdf")},
        "table_sha256": hashlib.sha256(open(TABLE, "rb").read()).hexdigest(),
        "showers": len(ours),
        "exceptions": {"%s %s" % k: v for k, v in sorted(EXCEPTIONS.items())},
        "max_radiant_sep_vs_mdc_deg": max(x["mdc_radiant_sep_deg"] for x in report),
        "max_radiant_sep_vs_imo_2026_deg": max(seps),
        "bytes": os.path.getsize(OUT),
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    print("%d showers written (%d bytes); exceptions used: %s" % (len(ours), os.path.getsize(OUT), sorted(used)))
    return 0


def fmt(x: float) -> str:
    s = ("%.2f" % x).rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def main(argv: list[str]) -> int:
    if "--compare" in argv:
        return compare()
    return build()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
