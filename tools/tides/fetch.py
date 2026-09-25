"""Download NOAA's tide-prediction stations and harmonic constants. Development-time only.

    python3 -m tools.tides.fetch            # from the repository root; resumable
    python3 -m tools.tides.fetch --refresh  # ask NOAA again for everything

Writes into `tools/tides/cache/` (git-ignored), through the polite client in `noaa.py`:

* `list/tidepredictions.json`: every station NOAA predicts tides for (harmonic "R" and
  subordinate "S"), with the subordinate time and height offsets expanded in place
  (one request);
* `station/<id>.json`: for every harmonic station, and for any station a subordinate
  station names as its reference, the harmonic constants (37 constituents, metres,
  phases on GMT), the tidal datums, and NOAA's disclaimers and notices (one request each).

About 1 260 requests, 13 minutes at the client's pace. `build.py` turns the cache into the
`tides-us` pack; `fixtures.py` fetches NOAA's own predictions for the validation.
"""

from __future__ import annotations

import argparse
import sys

from . import noaa

LIST_KEY = "list/tidepredictions.json"


def station_key(station_id: str) -> str:
    return "station/%s.json" % station_id


def fetch_all(client: noaa.Client, refresh: bool = False) -> int:
    listing = client.get_json(LIST_KEY, noaa.station_list_url(), refresh=refresh)
    stations = listing["stations"]
    harmonic = [s["id"] for s in stations if s["type"] == "R"]
    refs = sorted({(s.get("tidepredoffsets") or {}).get("refStationId") or s.get("reference_id")
                   for s in stations if s["type"] == "S"} - {None, ""})
    wanted = list(dict.fromkeys(harmonic + [r for r in refs if r not in set(harmonic)]))
    print("stations: %d (%d harmonic, %d subordinate); fetching %d harmonic records"
          % (len(stations), len(harmonic), len(stations) - len(harmonic), len(wanted)))
    failed = []
    for n, sid in enumerate(wanted, 1):
        key = station_key(sid)
        if client.has(key) and not refresh:
            continue
        try:
            client.get_json(key, noaa.station_url(sid), refresh=refresh)
        except noaa.FetchError as e:
            print("  failed %s: %s" % (sid, e), file=sys.stderr)
            failed.append(sid)
            if "stopping politely" in str(e):
                break
        if n % 50 == 0:
            print("  %d/%d (requests this run: %d)" % (n, len(wanted), client.requests_made))
            client.save_manifest()
    client.save_manifest()
    print("done: %d requests this run, %d failed %s" % (client.requests_made, len(failed),
                                                        failed[:10]))
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--refresh", action="store_true", help="ignore the cache")
    args = ap.parse_args()
    return fetch_all(noaa.Client(), refresh=args.refresh)


if __name__ == "__main__":
    sys.exit(main())
