"""NOAA's own tide predictions as validation fixtures. Development-time only.

    python3 -m tools.tides.fixtures            # both fixtures (resumable, cached)
    python3 -m tools.tides.fixtures --no-sweep # only the 30-day validation set

Run after `fetch.py` (it reads the cached station records). Writes, from the cache that
`noaa.py` keeps under `tools/tides/cache/pred/`:

* `fixtures/reference/tides_noaa.json`: 20 harmonic stations spread over the coasts and
  the tide types, 30 days each (high and low water, and the hourly curve), and 6
  subordinate stations, 30 days of high and low water each; every harmonic station
  carries NOAA's constants and datums as NOAA published them, so the Rust test checks
  the prediction without depending on the pack's encoding;
* `fixtures/reference/tides_noaa_sweep.json`: three days of NOAA's high and low water at
  every station of the list (about 3 500 requests the first time, 35 minutes), which
  finds the stations whose NOAA predictions the published constants cannot reproduce.

All requests: GMT, metres, MLLW (the only datum NOAA gives for subordinate stations).
Never regenerate these from Rust output (fixtures/README.md).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys

from . import noaa
from .fetch import LIST_KEY, station_key

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT_VALIDATION = os.path.join(REPO, "fixtures", "reference", "tides_noaa.json")
OUT_SWEEP = os.path.join(REPO, "fixtures", "reference", "tides_noaa_sweep.json")

#: 30-day windows, inclusive (NOAA's begin_date/end_date), chosen to cross a new year,
#: to sit at mid-year (where NOAA's node factors are exact) and at the end of a year
#: (where they are furthest from the instant), and to reach into 2027.
WINDOWS = [
    ("20251217", "20260115"),
    ("20260310", "20260408"),
    ("20260617", "20260716"),
    ("20260924", "20261023"),
    ("20271120", "20271219"),
]

#: (id, why) — five coasts, four tide types (by the form number F = (K1+O1)/(M2+S2)).
HARMONIC = [
    ("8410140", "Eastport, ME: semidiurnal, 5.5 m range"),
    ("8443970", "Boston, MA: semidiurnal"),
    ("8518750", "The Battery, NY: semidiurnal"),
    ("8638610", "Sewells Point, VA: semidiurnal"),
    ("8658120", "Wilmington, NC: semidiurnal river port, shallow-water tides"),
    ("8724580", "Key West, FL: mixed"),
    ("8729840", "Pensacola, FL: diurnal (F = 11)"),
    ("8761724", "Grand Isle, LA: diurnal"),
    ("8771450", "Galveston, TX: mixed, mainly diurnal"),
    ("9751639", "Charlotte Amalie, VI: mixed, mainly diurnal, small range"),
    ("9410170", "San Diego, CA: mixed"),
    ("9414290", "San Francisco, CA: mixed"),
    ("9439040", "Astoria, OR: mixed, Columbia River"),
    ("9447130", "Seattle, WA: mixed, large range"),
    ("9452210", "Juneau, AK: mixed, mainly semidiurnal, large range"),
    ("9455920", "Anchorage, AK: 9 m range, NOAA's 120-constituent station"),
    ("9461380", "Adak, AK: diurnal"),
    ("9462620", "Unalaska, AK: mixed, mainly diurnal"),
    ("1612340", "Honolulu, HI: mixed"),
    ("1630000", "Apra Harbor, Guam: mixed"),
]

SUBORDINATE = [
    ("8517401", "Hell Gate, NY: ratio, from The Battery, +3 h"),
    ("8518974", "Hudson, NY: ratio, from The Battery, +7 h (the largest offsets)"),
    ("8729017", "Farmdale, FL: ratio, from Pensacola (diurnal)"),
    ("1612668", "Haleiwa, HI: ratio, from Honolulu"),
    ("9450055", "Security Cove, AK: additive, from Sitka"),
    ("1814060", "Christmas Island: additive, from Honolulu, outside the U.S."),
]

SWEEP_WINDOW = ("20260201", "20260203")


def pred_key(sid: str, begin: str, end: str, interval: str) -> str:
    return "pred/%s_%s_%s_%s.json" % (sid, begin, end, interval)


def fetch_predictions(client: noaa.Client, sid: str, begin: str, end: str, interval: str):
    data = client.get_json(pred_key(sid, begin, end, interval),
                           noaa.predictions_url(sid, begin, end, interval))
    if "predictions" not in data:
        return None, (data.get("error") or {}).get("message", json.dumps(data)[:200])
    return data["predictions"], None


def minutes(t: str, begin: str) -> int:
    """Minutes from 00:00 GMT of `begin` (YYYYMMDD) to NOAA's `YYYY-MM-DD HH:MM`."""
    t0 = _dt.datetime.strptime(begin, "%Y%m%d")
    return int(round((_dt.datetime.strptime(t, "%Y-%m-%d %H:%M") - t0).total_seconds() / 60))


def hilo_rows(preds, begin: str):
    """[[minutes, height_mm, 1 high / 0 low], ...]"""
    return [[minutes(p["t"], begin), int(round(float(p["v"]) * 1000)),
             1 if p["type"] == "H" else 0] for p in preds]


def station_record(client: noaa.Client, sid: str) -> dict:
    return client.read(station_key(sid))["stations"][0]


def constants_of(rec: dict) -> dict:
    hc = (rec.get("harmonicConstituents") or {}).get("HarmonicConstituents") or []
    dat = rec.get("datums") or {}
    datums = {d["name"]: d["value"] for d in (dat.get("datums") or [])}
    return {
        "units": "metres; phases in degrees, Greenwich (phase_GMT); speeds degrees/hour",
        "constituents": [[c["name"], c["amplitude"], c["phase_GMT"], c["speed"]]
                         for c in hc if c["amplitude"] != 0],
        "datums_m_above_station_datum": {k: datums[k] for k in ("MSL", "MLLW") if k in datums},
        "datum_epoch": dat.get("epoch"),
    }


def build_validation(client: noaa.Client) -> dict:
    listing = {s["id"]: s for s in client.read(LIST_KEY)["stations"]}
    out = {
        "generator": {
            "script": "tools/tides/fixtures.py",
            "source": "NOAA CO-OPS predictions API (api.tidesandcurrents.noaa.gov/api/prod/"
                      "datagetter, product=predictions, time_zone=gmt, units=metric, "
                      "datum=MLLW) and metadata API (mdapi/prod/webapi/stations/<id>.json?"
                      "expand=harcon,datums)",
            "terms_of_use": "NOAA/NOS: public domain (U.S. Government work); NOS requests "
                            "attribution. See docs/THIRD_PARTY.md.",
            "never_a_runtime_dependency": "Development-time fixture; never regenerate from "
                                          "Rust output (fixtures/README.md).",
            "retrieved_utc": None,
            "encoding": "extremes: [minutes after 00:00 GMT of window[0], height mm above "
                        "MLLW, 1 = high / 0 = low]; hourly: heights mm above MLLW at "
                        "window[0] 00:00 GMT + k hours",
        },
        "harmonic": [],
        "subordinate": [],
    }
    retrieved = []
    for k, (sid, why) in enumerate(HARMONIC):
        begin, end = WINDOWS[k % len(WINDOWS)]
        hilo, err = fetch_predictions(client, sid, begin, end, "hilo")
        hourly, err2 = fetch_predictions(client, sid, begin, end, "h")
        if err or err2:
            raise SystemExit("NOAA refused %s: %s %s" % (sid, err, err2))
        rec = station_record(client, sid)
        retrieved += [client.manifest[pred_key(sid, begin, end, "hilo")]["retrieved_utc"],
                      client.manifest[pred_key(sid, begin, end, "h")]["retrieved_utc"],
                      client.manifest[station_key(sid)]["retrieved_utc"]]
        hours = [int(round(float(p["v"]) * 1000)) for p in hourly]
        if minutes(hourly[0]["t"], begin) != 0 or len(hourly) != 24 * 30:
            raise SystemExit("unexpected hourly series for %s" % sid)
        out["harmonic"].append({
            "id": sid, "name": listing[sid]["name"], "why": why,
            "window": [begin, end],
            "constants": constants_of(rec),
            "extremes": hilo_rows(hilo, begin),
            "hourly_mm": hours,
        })
        print("  %s %-34s %3d extremes, %d hours" % (sid, listing[sid]["name"][:34],
                                                   len(hilo), len(hours)))
    for k, (sid, why) in enumerate(SUBORDINATE):
        begin, end = WINDOWS[(k + 1) % len(WINDOWS)]
        hilo, err = fetch_predictions(client, sid, begin, end, "hilo")
        if err:
            raise SystemExit("NOAA refused %s: %s" % (sid, err))
        off = listing[sid]["tidepredoffsets"]
        retrieved.append(client.manifest[pred_key(sid, begin, end, "hilo")]["retrieved_utc"])
        ref = off["refStationId"]
        out["subordinate"].append({
            "id": sid, "name": listing[sid]["name"], "why": why,
            "window": [begin, end],
            "reference_id": ref,
            "reference_name": listing[ref]["name"],
            "reference_constants": constants_of(station_record(client, ref)),
            "offsets": {k2: off[k2] for k2 in ("heightAdjustedType", "heightOffsetHighTide",
                                               "heightOffsetLowTide", "timeOffsetHighTide",
                                               "timeOffsetLowTide")},
            "extremes": hilo_rows(hilo, begin),
        })
        print("  %s %-34s %3d extremes (subordinate)" % (sid, listing[sid]["name"][:34],
                                                         len(hilo)))
    out["generator"]["retrieved_utc"] = [min(retrieved), max(retrieved)]
    return out


def build_sweep(client: noaa.Client) -> dict:
    stations = client.read(LIST_KEY)["stations"]
    begin, end = SWEEP_WINDOW
    out = {
        "generator": {
            "script": "tools/tides/fixtures.py (sweep)",
            "source": "NOAA CO-OPS predictions API, interval=hilo, time_zone=gmt, "
                      "units=metric, datum=MLLW",
            "window": [begin, end],
            "encoding": "stations: {id: [[minutes after 00:00 GMT of window[0], height mm "
                        "above MLLW, 1 = high / 0 = low], ...]}; refused: {id: NOAA's message}",
            "terms_of_use": "NOAA/NOS: public domain (U.S. Government work). See "
                            "docs/THIRD_PARTY.md.",
            "retrieved_utc": None,
        },
        "stations": {},
        "refused": {},
    }
    retrieved = []
    for n, s in enumerate(stations, 1):
        sid = s["id"]
        try:
            preds, err = fetch_predictions(client, sid, begin, end, "hilo")
        except noaa.FetchError as e:
            print("  failed %s: %s" % (sid, e), file=sys.stderr)
            if "stopping politely" in str(e):
                raise
            continue
        retrieved.append(client.manifest[pred_key(sid, begin, end, "hilo")]["retrieved_utc"])
        if err:
            out["refused"][sid] = err
        else:
            out["stations"][sid] = hilo_rows(preds, begin)
        if n % 100 == 0:
            print("  sweep %d/%d (requests this run: %d)" % (n, len(stations),
                                                            client.requests_made))
            client.save_manifest()
    client.save_manifest()
    out["generator"]["retrieved_utc"] = [min(retrieved), max(retrieved)] if retrieved else None
    return out


def write(path: str, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), sort_keys=False)
        f.write("\n")
    print("wrote %s (%d bytes)" % (os.path.relpath(path, REPO), os.path.getsize(path)))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--no-sweep", action="store_true")
    ap.add_argument("--offline", action="store_true", help="use only the cache")
    args = ap.parse_args()
    client = noaa.Client(offline=args.offline)
    write(OUT_VALIDATION, build_validation(client))
    if not args.offline:
        client.save_manifest()
    if not args.no_sweep:
        write(OUT_SWEEP, build_sweep(client))
    return 0


if __name__ == "__main__":
    sys.exit(main())
