"""Read the USGS/IAU Gazetteer search pages that `tools/moon/fetch.py` saved.

Development-time only. The pages hold every column in the HTML table the site's "CSV"
button exports in the browser; this module reads the same cells, one row per feature.
"""

from __future__ import annotations

import glob
import html
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

#: Table cells by the class the page gives them, in page order.
COLUMNS = [
    "featureIDColumn",
    "featureNameColumn",
    "cleanFeatureNameColumn",
    "targetColumn",
    "diameterColumn",
    "centerLatLonColumn",  # latitude
    "centerLatLonColumn",  # longitude
    "latLonColumn",  # northernmost
    "latLonColumn",  # southernmost
    "latLonColumn",  # easternmost
    "latLonColumn",  # westernmost
    "coordSystemColumn",
    "continentColumn",
    "ethnicityColumn",
    "featureTypeColumn",
    "featureTypeCodeColumn",
    "quadColumn",
    "approvalStatusColumn",
    "approvalDateColumn",
    "referenceColumn",
    "originColumn",
    "additionalInfoColumn",
    "lastUpdatedColumn",
]

_ROW = re.compile(r'<tr\s+class="hover-highlight[^"]*">(.*?)</tr>', re.S)
_CELL = re.compile(r'<td class="([A-Za-z]+Column)[^"]*"[^>]*>(.*?)</td>', re.S)


def _text(cell: str) -> str:
    t = re.sub(r"<[^>]+>", " ", cell)
    return re.sub(r"\s+", " ", html.unescape(t)).strip()


def _num(s: str) -> float | None:
    """A numeric cell; the page writes a missing value as empty or "-"."""
    return None if s in ("", "-") else float(s)


def parse_page(raw: str) -> list[dict]:
    """Every feature row of one search result page."""
    out = []
    for row in _ROW.findall(raw):
        cells = _CELL.findall(row)
        classes = [c for c, _ in cells]
        if classes != COLUMNS:
            raise ValueError("unexpected table layout: %r" % classes)
        v = [_text(x) for _, x in cells]
        coord = v[11]
        if coord != "Planetographic, +East, -180 - 180":
            raise ValueError("unexpected coordinate system %r" % coord)
        out.append(
            {
                "id": int(v[0]),
                "name": v[1],
                "clean_name": v[2],
                "target": v[3],
                "diameter_km": _num(v[4]),
                "lat_deg": float(v[5]),
                "lon_deg": float(v[6]),
                "north_deg": _num(v[7]),
                "south_deg": _num(v[8]),
                "east_deg": _num(v[9]),
                "west_deg": _num(v[10]),
                "coordinate_system": coord,
                "type": v[14],
                "type_code": v[15],
                "approval": v[17],
                "approval_date": v[18],
                "origin": v[20],
                "last_updated": v[22],
            }
        )
    return out


def _page_text(raw: str) -> str:
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", raw, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t)))


def parse_detail_page(raw: str) -> list[dict]:
    """A search with exactly one hit answers with that feature's own page, not a table.

    The page lists the current control network first (the one the table pages give);
    the first occurrence of each field is therefore the one used.
    """
    t = _page_text(raw)

    def field(label: str, pattern: str) -> str:
        m = re.search(re.escape(label) + r" " + pattern, t)
        if not m:
            raise ValueError("feature page without %r" % label)
        return m.group(1).strip()

    coord = field("Coordinate System", r"(Planetographic, \+East, -180 - 180)")
    num = r"(-?\d+(?:\.\d+)?)"
    return [
        {
            "id": int(field("Feature ID", r"(\d+)")),
            "name": field("Feature Name", r"(.+?) Clean Name"),
            "clean_name": field("Clean Name", r"(.+?) Feature ID"),
            "target": field("Target", r"(\w+) Feature Type"),
            "diameter_km": float(field("Diameter", num + r" km")),
            "lat_deg": float(field("Center Latitude", num + r" °")),
            "lon_deg": float(field("Center Longitude", num + r" °")),
            "north_deg": float(field("Northmost Latitude", num + r" °")),
            "south_deg": float(field("Southmost Latitude", num + r" °")),
            "east_deg": float(field("Eastmost Longitude", num + r" °")),
            "west_deg": float(field("Westmost Longitude", num + r" °")),
            "coordinate_system": coord,
            "type": field("Feature Type", r"(.+?) Location"),
            "type_code": "",
            "approval": "Approved"
            if field("Approval Status", r"(Adopted by IAU)") == "Adopted by IAU"
            else "?",
            "approval_date": field("Approval Date", r"(\d{4})"),
            "origin": field("Origin", r"(.+?) Reference"),
            "last_updated": field("Updated", r"(\w{3} \d{1,2}, \d{4})"),
        }
    ]


def load_all() -> list[dict]:
    """Every row of every saved page, sorted by feature id; ids are unique."""
    rows = {}
    for path in sorted(glob.glob(os.path.join(DATA, "usgs_*.html"))):
        if path.endswith("usgs_copyrights.html"):
            continue
        with open(path, encoding="utf-8") as f:
            raw = f.read()
        found = parse_page(raw) if "results_body" in raw else parse_detail_page(raw)
        if not found:
            raise ValueError("%s: no features" % os.path.basename(path))
        for r in found:
            if r["target"] != "Moon" or r["approval"] != "Approved":
                raise ValueError("row %d is %s/%s" % (r["id"], r["target"], r["approval"]))
            rows[r["id"]] = r
    return [rows[k] for k in sorted(rows)]
