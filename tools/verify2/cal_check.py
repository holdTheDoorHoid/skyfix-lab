from skyfield.api import load
from skyfield.timelib import compute_calendar_date, julian_day
from v2 import cli
cases = [2299159.5, 2299160.5, 2299150.5, 2299170.5,       # around the reform
         1721057.5, 1721058.5, 1721423.5, 1721424.5,       # years 0 and 1
         1720692.5, 1720693.5, 1720751.5,                  # year -1 (2 BC) and its Feb 29 (Julian leap)
         1507231.5, 1507290.5,                             # 585 BC
         990574.5, 2817152.5 - 1, 2451604.5, 2305506.5]    # tier edges, 2000-02-29, 1600-02-29
bad = 0
for jd in cases:
    d = cli("calendar-convert", "--jd", repr(jd), "--json")
    jul = compute_calendar_date(int(jd + 0.5), julian_before=float('inf'))  # Julian always
    greg = compute_calendar_date(int(jd + 0.5), julian_before=None)          # proleptic Gregorian
    ej = d["julian"]; eg = d["gregorian"]
    ok = (ej["year"], ej["month"], ej["day"]) == tuple(jul) and (eg["year"], eg["month"], eg["day"]) == tuple(greg)
    bad += not ok
    print(f"{jd}: engine J {ej['year']}-{ej['month']:02d}-{ej['day']:02d} G {eg['year']}-{eg['month']:02d}-{eg['day']:02d} | Skyfield J {jul} G {greg} {'OK' if ok else 'DIFF'}")
print("differences:", bad)
