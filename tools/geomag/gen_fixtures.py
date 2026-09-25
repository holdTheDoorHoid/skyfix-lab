"""Reference fixtures for skyfix-geomag (development-time only; never a runtime dependency).

Writes, from the published sources below and nothing computed by this project:

  fixtures/reference/geomag_wmm2025.json
      NOAA NCEI / BGS official WMM2025 test values: the 100 rows of
      WMM2025_TestValues.txt (in WMM2025COF.zip), Table 6 of the WMM2025 technical
      report (12 rows, main field and secular variation) and the report's
      high-precision numerical example (Tables 3a and 3b).
  fixtures/reference/geomag_igrf14.json
      IGRF-14: the twelve test values of IAGA's own pyIGRF14 package (geocentric
      X, Y, Z, 1900-2030), the British Geological Survey's IGRF-14 calculator at 25
      points spread over 1900-2030 (its JSON web service), and the two rows of NOAA's
      Geomag 7.0 sample output at 2015.0, where IGRF-13 and IGRF-14 are the same model.

Usage, from the repository root (standard-library Python 3 only):

  python3 -m tools.geomag.gen_fixtures            # uses tools/geomag/data/ (downloads what is missing)
  python3 -m tools.geomag.gen_fixtures --offline  # fails if a download would be needed

Every download is checked against the SHA-256 recorded below (retrieved 2026-09-24). The
BGS responses are cached as returned in tools/geomag/data/bgs/ and their SHA-256 is written
into the fixture. CONVENTIONS section 11: never regenerate these from Rust output.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / "data"
OUT = ROOT / "fixtures" / "reference"
RETRIEVED = "2026-09-24"

SOURCES = {
    "wmm_zip": {
        "url": "https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip",
        "sha256": "2e76569370d081f2cd7919490218bd094ca9afde347b198eff5621e0af460d03",
        "file": "WMM2025COF.zip",
    },
    "wmm_report": {
        "url": "https://repository.library.noaa.gov/view/noaa/71569/noaa_71569_DS1.pdf",
        "doi": "10.25923/prbc-s316",
        "sha256": "3bed06a4381b06caa0ca04296aa428a6647974bbc06ec936cf744876e4fc0f28",
        "file": "WMM2025_Report.pdf",
    },
    "pyigrf14": {
        "url": "https://www.ngdc.noaa.gov/IAGA/vmod/pyIGRF14.zip",
        "sha256": "82202de7057e9525509b4b288b1e52d2c272543b5dedf89f2bbbddb83b1352f2",
        "file": "pyIGRF14.zip",
    },
    "geomag70": {
        "url": "https://www.ngdc.noaa.gov/IAGA/vmod/geomag70_linux.tar.gz",
        "sha256": "c65f65a4b38f75785d29ce36501e9d4a03626257d9a339dfb09e35d7ef5f4709",
        "file": "geomag70_linux.tar.gz",
    },
}

BGS_URL = (
    "https://geomag.bgs.ac.uk/web_service/GMModels/igrf/14/"
    "?latitude={lat}&longitude={lon}&altitude={alt_km}&date={date}&format=json"
)

# Dates, places and heights chosen to spread over 1900-2030, both hemispheres, the
# South Atlantic anomaly, both polar regions, the 1995-2000 change of degree (10 to 13),
# an aircraft height, and IGRF-14's predictive secular variation after 2025.
BGS_POINTS = [
    ("1900-01-01", 51.5, -0.1, 0.0),
    ("1903-01-01", 40.0, -75.0, 0.0),
    ("1911-07-01", -33.9, 18.4, 0.0),
    ("1918-01-01", 35.7, 139.7, 0.0),
    ("1925-01-01", -34.6, -58.4, 0.0),
    ("1932-01-01", 61.2, -149.9, 0.0),
    ("1940-01-01", 64.1, -21.9, 0.0),
    ("1947-01-01", 21.3, -157.9, 0.0),
    ("1953-07-01", 1.3, 103.8, 0.0),
    ("1962-01-01", 78.2, 15.6, 0.0),
    ("1968-01-01", -77.8, 166.7, 0.0),
    ("1975-01-01", 19.1, 72.9, 0.0),
    ("1983-07-01", 55.8, 37.6, 0.0),
    ("1991-01-01", -12.0, -77.0, 0.0),
    ("1997-01-01", -1.3, 36.8, 1.7),
    ("1998-07-01", 45.0, -63.0, 0.0),
    ("2004-01-01", -45.0, 170.0, 0.0),
    ("2008-07-01", 70.0, -100.0, 0.0),
    ("2013-01-01", 30.0, -90.0, 0.0),
    ("2017-01-01", -60.0, -60.0, 0.0),
    ("2019-07-01", 48.9, 2.35, 0.0),
    ("2022-07-01", 39.95, -75.17, 0.0),
    ("2024-12-31", -20.0, 57.5, 0.0),
    ("2027-01-01", 10.0, -30.0, 10.0),
    ("2029-12-31", 85.0, 120.0, 0.0),
]

# WMM2025 technical report, Table 6 (main field; GV only where defined) and its
# secular-variation half, typed from the report (DOI 10.25923/prbc-s316, pages 27-28).
TABLE6 = [
    # year, h_km, lat, lon, X, Y, Z, H, F, I, D, GV
    (2025.0, 0, 80, 0, 6521.6, 145.9, 54791.5, 6523.2, 55178.5, 83.21, 1.28, 1.28),
    (2025.0, 0, 0, 120, 39677.8, -109.6, -10580.2, 39677.9, 41064.3, -14.93, -0.16, None),
    (2025.0, 0, -80, 240, 6117.5, 15751.9, -52022.5, 16898.1, 54698.2, -72.00, 68.78, -51.22),
    (2025.0, 100, 80, 0, 6216.0, 92.4, 52598.8, 6216.7, 52964.9, 83.26, 0.85, 0.85),
    (2025.0, 100, 0, 120, 37688.6, -96.2, -10152.1, 37688.7, 39032.1, -15.08, -0.15, None),
    (2025.0, 100, -80, 240, 5907.6, 14780.3, -49540.7, 15917.1, 52035.0, -72.19, 68.21, -51.79),
    (2027.5, 0, 80, 0, 6500.8, 294.5, 54869.4, 6507.5, 55253.9, 83.24, 2.59, 2.59),
    (2027.5, 0, 0, 120, 39701.6, -167.4, -10381.8, 39702.0, 41036.9, -14.65, -0.24, None),
    (2027.5, 0, -80, 240, 6200.7, 15730.3, -51783.7, 16908.3, 54474.2, -71.92, 68.49, -51.51),
    (2027.5, 100, 80, 0, 6196.7, 233.8, 52670.5, 6201.1, 53034.3, 83.29, 2.16, 2.16),
    (2027.5, 100, 0, 120, 37711.5, -148.7, -9969.8, 37711.8, 39007.4, -14.81, -0.23, None),
    (2027.5, 100, -80, 240, 5984.0, 14760.1, -49317.7, 15927.0, 51825.7, -72.10, 67.93, -52.07),
]
TABLE6_SV = [
    # Xdot, Ydot, Zdot, Hdot, Fdot (nT/yr), Idot, Ddot (deg/yr); same rows as TABLE6
    (-8.3, 59.5, 31.1, -7.0, 30.1, 0.01, 0.52),
    (9.5, -23.1, 79.4, 9.6, -11.2, 0.11, -0.03),
    (33.3, -8.6, 95.5, 4.0, -89.6, 0.03, -0.12),
    (-7.7, 56.5, 28.7, -6.9, 27.6, 0.01, 0.52),
    (9.2, -21.0, 72.9, 9.2, -10.0, 0.11, -0.03),
    (30.6, -8.0, 89.2, 3.9, -83.8, 0.03, -0.11),
    (-8.3, 59.5, 31.1, -5.6, 30.3, 0.01, 0.53),
    (9.5, -23.1, 79.4, 9.6, -10.7, 0.11, -0.03),
    (33.3, -8.6, 95.5, 4.2, -89.5, 0.04, -0.12),
    (-7.7, 56.5, 28.7, -5.6, 27.8, 0.01, 0.52),
    (9.2, -21.0, 72.9, 9.3, -9.7, 0.11, -0.03),
    (30.6, -8.0, 89.2, 4.0, -83.7, 0.03, -0.11),
]

# Tables 3a and 3b of the report: the high-precision numerical example for WMM2025.
NUMERICAL_EXAMPLE = {
    "year": 2027.5,
    "height_km": 100.0,
    "lat_deg": -80.0,
    "lon_deg": 240.0,
    "lambda_rad": 4.1887902048,
    "phi_rad": -1.3962634016,
    "phi_prime_rad": -1.3951289589,
    "r_m": 6457402.3484473705,
    "g10_nt": -29321.8,
    "g11_nt": -1386.55,
    "g20_nt": -2585.6,
    "g21_nt": 2938.1,
    "g22_nt": 1629.3,
    "h11_nt": 4491.65,
    "h21_nt": -3202.85,
    "h22_nt": -845.35,
    "xprime_nt": 5928.0241392588,
    "yprime_nt": 14760.1359757868,
    "zprime_nt": -49324.4273570284,
    "xprime_dot_nt_per_year": 30.6565457063,
    "yprime_dot_nt_per_year": -8.0494228995,
    "zprime_dot_nt_per_year": 89.1826862382,
    "x_nt": 5983.9760496518,
    "y_nt": 14760.1359757868,
    "z_nt": -49317.6706154255,
    "x_dot_nt_per_year": 30.5553533530,
    "y_dot_nt_per_year": -8.0494228995,
    "z_dot_nt_per_year": 89.2174069382,
    "f_nt": 51825.6907172314,
    "h_nt": 15927.0079860130,
    "d_rad": 1.1856308407,
    "i_rad": -1.2584221541,
    "f_dot_nt_per_year": -83.6643506802,
    "h_dot_nt_per_year": 4.0203361601,
    "d_dot_rad_per_year": -0.0019677910,
    "i_dot_rad_per_year": 0.0006028663,
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(url: str, dest: Path, offline: bool, expected: str | None) -> bytes:
    if dest.exists():
        data = dest.read_bytes()
    else:
        if offline:
            sys.exit(f"missing {dest} and --offline was given")
        req = urllib.request.Request(url, headers={"User-Agent": "skyfix-lab fixture generator"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    if expected and sha256(data) != expected:
        sys.exit(f"{dest}: SHA-256 {sha256(data)} is not the recorded {expected}")
    return data


def source(key: str, offline: bool) -> bytes:
    s = SOURCES[key]
    return fetch(s["url"], DATA / s["file"], offline, s["sha256"])


def meta(key: str, **extra) -> dict:
    s = SOURCES[key]
    out = {"url": s["url"], "sha256": s["sha256"], "retrieved": RETRIEVED}
    if "doi" in s:
        out["doi"] = s["doi"]
    out.update(extra)
    return out


def wmm_fixture(offline: bool) -> dict:
    z = zipfile.ZipFile(io.BytesIO(source("wmm_zip", offline)))
    name = "WMM2025COF/WMM2025_TestValues.txt"
    text = z.read(name)
    source("wmm_report", offline)  # checked, so the typed tables have a verified origin
    keys = [
        "year", "height_km", "lat_deg", "lon_deg", "d_deg", "i_deg", "h_nt", "x_nt",
        "y_nt", "z_nt", "f_nt", "d_dot_deg_per_year", "i_dot_deg_per_year",
        "h_dot_nt_per_year", "x_dot_nt_per_year", "y_dot_nt_per_year",
        "z_dot_nt_per_year", "f_dot_nt_per_year",
    ]
    rows = []
    for line in text.decode().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        vals = [float(v) for v in line.split()]
        assert len(vals) == 18, line
        rows.append(dict(zip(keys, vals)))
    assert len(rows) == 100, len(rows)
    t6 = []
    for main, sv in zip(TABLE6, TABLE6_SV):
        y, hk, lat, lon, x, yy, zz, h, f, i, d, gv = main
        xd, yd, zd, hd, fd, idot, ddot = sv
        t6.append({
            "year": y, "height_km": hk, "lat_deg": lat, "lon_deg": lon,
            "x_nt": x, "y_nt": yy, "z_nt": zz, "h_nt": h, "f_nt": f, "i_deg": i,
            "d_deg": d, "gv_deg": gv,
            "x_dot_nt_per_year": xd, "y_dot_nt_per_year": yd, "z_dot_nt_per_year": zd,
            "h_dot_nt_per_year": hd, "f_dot_nt_per_year": fd,
            "i_dot_deg_per_year": idot, "d_dot_deg_per_year": ddot,
        })
    return {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": "tools/geomag/gen_fixtures.py",
            "model": "WMM2025 (NOAA NCEI and BGS), WMM2025.COF header '2025.0 WMM-2025 11/13/2024'",
            "sources": {
                "test_values": meta("wmm_zip", member=name, member_sha256=sha256(text)),
                "technical_report": meta(
                    "wmm_report",
                    citation=(
                        "Chulliat, A., W. Brown, M. Nair, N. Gomez Perez, L.-Y. Young, C. Watson, "
                        "N. Boneh, C. Beggan, B. Meyer and M. Paniccia, 2025. The US/UK World Magnetic "
                        "Model for 2025-2030: Technical Report, NCEI, NOAA."
                    ),
                    tables="3a and 3b (numerical example), 6 (test values), typed",
                ),
            },
            "licence": "U.S. Government work (NOAA NCEI); the WMM page: 'The WMM source code is in the "
            "public domain and not licensed or under copyright.'",
            "conventions": "heights above the WGS84 ellipsoid; decimal years; D east positive, I down "
            "positive; X north, Y east, Z down",
            "tolerances": {
                "policy": "WMM2025 technical report 1.10: nT within 0.1 nT, nT/yr within 0.1 nT/yr",
                "angles": "d_deg and i_deg are printed to 0.01 deg",
            },
        },
        "test_values": rows,
        "table6": t6,
        "numerical_example": NUMERICAL_EXAMPLE,
    }


def pyigrf_cases(offline: bool) -> tuple[list, str]:
    z = zipfile.ZipFile(io.BytesIO(source("pyigrf14", offline)))
    name = "pyIGRF14/tests/tests_igrf14.py"
    text = z.read(name).decode()
    pat = re.compile(
        r"\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*np\.array\(\[\s*"
        r"(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]\)"
    )
    cases = []
    for m in pat.finditer(text):
        date, colat, lon, radius, x, y, zz = m.groups()
        cases.append({
            "year": float(date), "colatitude_deg": float(colat), "lon_deg": float(lon),
            "radius_km": float(radius), "x_nt": float(x), "y_nt": float(y), "z_nt": float(zz),
        })
    assert len(cases) == 12, len(cases)
    return cases, sha256(text.encode())


def noaa_sample(offline: bool) -> tuple[list, str]:
    t = tarfile.open(fileobj=io.BytesIO(source("geomag70", offline)), mode="r:gz")
    name = "geomag70_linux/sample_out_IGRF13.txt"
    text = t.extractfile(name).read()
    out = []
    for line in text.decode().splitlines():
        if not line.startswith("2015,1,1 "):
            continue
        f = line.split()
        date, coord, alt, lat, lon = f[:5]
        assert coord == "D"
        rest = " ".join(f[5:])
        m = re.match(
            r"(-?\d+)d\s*(-?\d+)m\s+(-?\d+)d\s*(-?\d+)m\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)", rest
        )
        assert m, line
        dd, dm, idg, im = (int(v) for v in m.groups()[:4])
        h, x, y, zz, ff = (float(v) for v in m.groups()[4:])

        def dms(s: str) -> float:
            parts = [p for p in s.split(",")]
            if len(parts) == 1:
                return float(parts[0])
            d = int(parts[0]); mi = int(parts[1] or 0); se = int(parts[2] or 0) if len(parts) > 2 else 0
            v = abs(d) + mi / 60 + se / 3600
            return -v if d < 0 else v

        def signed(d: int, mm: int) -> float:
            # geomag70 prints "0d -48m" for -0.8 deg: the sign is on the first non-zero field.
            neg = d < 0 or (d == 0 and mm < 0)
            v = abs(d) + abs(mm) / 60
            return -v if neg else v

        units = alt[0]
        value = float(alt[1:])
        alt_km = {"K": value, "M": value / 1000.0, "F": value * 0.0003048}[units]
        out.append({
            "date": "2015-01-01",
            "year": 2015.0 + 1.0 / 365.0,
            "year_note": "Geomag 7.0's julday() counts 1 January as day 1: 2015 + 1/365",
            "lat_deg": dms(lat), "lon_deg": dms(lon), "height_km": alt_km,
            "d_deg": signed(dd, dm), "i_deg": signed(idg, im),
            "h_nt": h, "x_nt": x, "y_nt": y, "z_nt": zz, "f_nt": ff,
        })
    assert len(out) == 2, out
    return out, sha256(text)


def bgs_cases(offline: bool) -> list:
    out = []
    for i, (date, lat, lon, alt_km) in enumerate(BGS_POINTS):
        url = BGS_URL.format(lat=lat, lon=lon, alt_km=alt_km, date=date)
        dest = DATA / "bgs" / f"{i:02d}_{date}.json"
        fresh = not dest.exists()
        raw = fetch(url, dest, offline, None)
        if fresh:
            time.sleep(1.0)  # be polite to the service
        body = raw.decode()
        # The service prefixes out-of-range warnings as plain text; none is expected here.
        assert body.lstrip().startswith("{"), f"{dest}: unexpected text before the JSON: {body[:200]!r}"
        r = json.loads(body)["geomagnetic-field-model-result"]
        assert r["model"] == "igrf" and str(r["model_revision"]) == "14", r
        fv, sv = r["field-value"], r["secular-variation"]
        out.append({
            "date": date, "lat_deg": lat, "lon_deg": lon, "height_km": alt_km, "url": url,
            "response_sha256": sha256(raw),
            "d_deg": fv["declination"]["value"], "i_deg": fv["inclination"]["value"],
            "f_nt": fv["total-intensity"]["value"], "h_nt": fv["horizontal-intensity"]["value"],
            "x_nt": fv["north-intensity"]["value"], "y_nt": fv["east-intensity"]["value"],
            "z_nt": fv["vertical-intensity"]["value"],
            "d_dot_arcmin_per_year": sv["declination"]["value"],
            "i_dot_arcmin_per_year": sv["inclination"]["value"],
            "f_dot_nt_per_year": sv["total-intensity"]["value"],
            "x_dot_nt_per_year": sv["north-intensity"]["value"],
            "y_dot_nt_per_year": sv["east-intensity"]["value"],
            "z_dot_nt_per_year": sv["vertical-intensity"]["value"],
            "h_dot_nt_per_year": sv["horizontal-intensity"]["value"],
        })
    return out


def igrf_fixture(offline: bool) -> dict:
    iaga, iaga_sha = pyigrf_cases(offline)
    noaa, noaa_sha = noaa_sample(offline)
    bgs = bgs_cases(offline)
    return {
        "schema": "skyfix.reference/1",
        "generator": {
            "tool": "tools/geomag/gen_fixtures.py",
            "model": "IGRF-14 (IAGA, 2024), coefficients igrf14coeffs.txt, SHA-256 "
            "8f8d88403028fc4ee92c4f38d97b46e0a87e2cfc496045b43c9e26c1d6b0903c",
            "sources": {
                "iaga_pyigrf14_tests": meta(
                    "pyigrf14", member="pyIGRF14/tests/tests_igrf14.py", member_sha256=iaga_sha,
                    note="IAGA V-MOD's own test values (MIT-licensed package by C. Beggan, BGS). "
                    "Geocentric: colatitude, longitude, radius in km; X = -B_theta, Y = B_phi, "
                    "Z = -B_r. Checked by its authors against igrf.f.",
                ),
                "noaa_geomag70_sample": meta(
                    "geomag70", member="geomag70_linux/sample_out_IGRF13.txt", member_sha256=noaa_sha,
                    note="NOAA's Geomag 7.0 sample output with IGRF-13; only the rows at 2015-01-01 "
                    "are used, where IGRF-13 and IGRF-14 share the definitive DGRF 2015 field (the "
                    "rate after 2015 differs by about 1 nT/yr, 0.003 nT at 2015 + 1/365). Heights "
                    "above the WGS84 ellipsoid (geomag70.c header). D and I printed to 1 arcmin.",
                ),
                "bgs_calculator": {
                    "service": BGS_URL,
                    "page": "https://geomag.bgs.ac.uk/data_service/models_compass/igrf_calc.html",
                    "retrieved": RETRIEVED,
                    "note": "British Geological Survey IGRF-14 calculator (the page invites HTTP GET "
                    "requests for XML/JSON). Heights km above the WGS84 ellipsoid, geodetic "
                    "latitude. A date is read as its middle: the service reports 2030-01-01 as "
                    "2030.001, i.e. year + (day of year - 0.5)/days in year, so each case is compared "
                    "at 12:00 UTC of its date. NOAA's calculator needs a registered key and was not used.",
                },
            },
            "licence": "IGRF-14 coefficients: IAGA, CC BY 4.0 (Zenodo 10.5281/zenodo.14012302). "
            "Calculator outputs are model values recorded as test data only.",
            "tolerances": {"brief": "declination within 0.1 deg of an IGRF-14 calculator"},
        },
        "iaga_pyigrf14": iaga,
        "noaa_geomag70_2015": noaa,
        "bgs_calculator": bgs,
    }


def write(path: Path, doc: dict) -> None:
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    stamp = time.gmtime(int(epoch)) if epoch else time.gmtime()
    doc["generator"]["generated_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", stamp)
    path.write_text(json.dumps(doc, indent=1, sort_keys=True, ensure_ascii=False) + "\n")
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="never download; fail if a file is missing")
    args = ap.parse_args()
    write(OUT / "geomag_wmm2025.json", wmm_fixture(args.offline))
    write(OUT / "geomag_igrf14.json", igrf_fixture(args.offline))


if __name__ == "__main__":
    main()
