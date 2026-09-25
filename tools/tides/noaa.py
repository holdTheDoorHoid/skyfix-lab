"""A polite, caching client for NOAA CO-OPS web services. Development-time only.

Every response is stored byte-for-byte under `tools/tides/cache/` (git-ignored) with its
URL, retrieval time, size and SHA-256 in `cache/manifest.json`, so a re-run never asks
NOAA twice for the same thing and every derived file can say exactly what it came from.

Politeness rules (NOAA publishes no hard limit; these are ours):

* one request at a time, never in parallel;
* at least `MIN_INTERVAL_S` seconds between the starts of two requests;
* a descriptive User-Agent, and `application=` on the data API as NOAA asks;
* on HTTP 429, 5xx or a network error: back off 10, 20, 40, 80 s, then give up (the run
  is resumable: whatever was fetched stays cached);
* abort the whole run after `MAX_CONSECUTIVE_FAILURES` failures in a row.

Uses only the Python standard library.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
MANIFEST = os.path.join(CACHE, "manifest.json")

MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi"
DATAAPI = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"

USER_AGENT = (
    "skyfix-lab-tides/1 (development-time data pipeline; "
    "https://github.com/holdTheDoorHoid/skyfix-lab)"
)
#: NOAA's data API asks callers to name their application.
APPLICATION = "skyfix-lab-tides"

MIN_INTERVAL_S = 0.6
BACKOFF_S = (10, 20, 40, 80)
MAX_CONSECUTIVE_FAILURES = 5


class FetchError(RuntimeError):
    pass


def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Client:
    def __init__(self, cache_dir: str = CACHE, min_interval_s: float = MIN_INTERVAL_S,
                 offline: bool = False) -> None:
        self.cache_dir = cache_dir
        self.min_interval_s = min_interval_s
        self.offline = offline
        self._last_start = 0.0
        self._consecutive_failures = 0
        self.requests_made = 0
        os.makedirs(cache_dir, exist_ok=True)
        self.manifest: dict = {}
        path = os.path.join(cache_dir, "manifest.json")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                self.manifest = json.load(f)

    # -- cache ------------------------------------------------------------------------

    def path(self, key: str) -> str:
        return os.path.join(self.cache_dir, key)

    def has(self, key: str) -> bool:
        return os.path.exists(self.path(key)) and key in self.manifest

    def save_manifest(self) -> None:
        tmp = os.path.join(self.cache_dir, "manifest.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.manifest, f, indent=1, sort_keys=True)
            f.write("\n")
        os.replace(tmp, os.path.join(self.cache_dir, "manifest.json"))

    def read(self, key: str):
        with open(self.path(key), "rb") as f:
            return json.loads(f.read())

    # -- network ----------------------------------------------------------------------

    def _wait_turn(self) -> None:
        now = time.monotonic()
        wait = self._last_start + self.min_interval_s - now
        if wait > 0:
            time.sleep(wait)
        self._last_start = time.monotonic()

    def _get(self, url: str) -> bytes:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                   "Accept": "application/json"})
        attempt = 0
        while True:
            self._wait_turn()
            self.requests_made += 1
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = r.read()
                self._consecutive_failures = 0
                return data
            except urllib.error.HTTPError as e:
                retryable = e.code == 429 or e.code >= 500
                why = "HTTP %d" % e.code
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                retryable = True
                why = str(e)
            if not retryable or attempt >= len(BACKOFF_S):
                self._consecutive_failures += 1
                if self._consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    raise FetchError("%d failures in a row, last: %s (%s); stopping "
                                     "politely" % (self._consecutive_failures, url, why))
                raise FetchError("%s: %s" % (url, why))
            delay = BACKOFF_S[attempt]
            attempt += 1
            print("  %s for %s; backing off %d s" % (why, url, delay), file=sys.stderr)
            time.sleep(delay)

    def get_json(self, key: str, url: str, refresh: bool = False):
        """The JSON at `url`, from the cache under `key` when present."""
        if self.has(key) and not refresh:
            return self.read(key)
        if self.offline:
            raise FetchError("offline and not cached: %s" % key)
        data = self._get(url)
        # Validate before caching: a half-written or HTML error page must not be kept.
        parsed = json.loads(data)
        full = self.path(key)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full + ".tmp", "wb") as f:
            f.write(data)
        os.replace(full + ".tmp", full)
        self.manifest[key] = {
            "url": url,
            "retrieved_utc": utc_now(),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        # Keep the manifest current so an interrupted run loses nothing.
        if self.requests_made % 25 == 0:
            self.save_manifest()
        return parsed


# -- URLs -------------------------------------------------------------------------------

def station_list_url() -> str:
    """Every tide-prediction station, with the subordinate offsets expanded in place."""
    return MDAPI + "/stations.json?" + urllib.parse.urlencode(
        {"type": "tidepredictions", "expand": "tidepredoffsets"})


def station_url(station_id: str) -> str:
    """One station with its harmonic constants, datums, disclaimers and notices."""
    return (MDAPI + "/stations/%s.json?" % urllib.parse.quote(station_id)
            + urllib.parse.urlencode({"expand": "harcon,datums,disclaimers,notices",
                                      "units": "metric"}))


def predictions_url(station_id: str, begin: str, end: str, interval: str,
                    datum: str = "MLLW") -> str:
    """NOAA's own predictions (GMT, metres). `begin`/`end` are YYYYMMDD, inclusive."""
    return DATAAPI + "?" + urllib.parse.urlencode({
        "product": "predictions",
        "application": APPLICATION,
        "begin_date": begin,
        "end_date": end,
        "datum": datum,
        "station": station_id,
        "time_zone": "gmt",
        "units": "metric",
        "interval": interval,
        "format": "json",
    })
