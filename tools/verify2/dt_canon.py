"""Engine Delta-T and its sigma vs the Five Millennium Canon's (Espenak & Meeus 2006 polynomials,
Morrison & Stephenson 2004 sigma = 0.8 t^2, Huber 2000 as on NASA's page)."""
import math
from v2 import cli, jd_from_greg

def canon_dt(y):
    # NASA's polynomial expressions (deltatpoly2004.html), y = decimal year
    if y < -500:
        u = (y - 1820) / 100; return -20 + 32 * u * u
    if y < 500:
        u = y / 100
        return (10583.6 - 1014.41*u + 33.78311*u**2 - 5.952053*u**3 - 0.1798452*u**4
                + 0.022174192*u**5 + 0.0090316521*u**6)
    if y < 1600:
        u = (y - 1000) / 100
        return (1574.2 - 556.01*u + 71.23472*u**2 + 0.319781*u**3 - 0.8503463*u**4
                - 0.005050998*u**5 + 0.0083572073*u**6)
    if y < 1700:
        t = y - 1600; return 120 - 0.9808*t - 0.01532*t*t + t**3/7129
    if y < 1800:
        t = y - 1700; return 8.83 + 0.1603*t - 0.0059285*t*t + 0.00013336*t**3 - t**4/1174000
    if y < 2050:
        raise ValueError
    if y < 2150:
        return -20 + 32*((y-1820)/100)**2 - 0.5628*(2150-y)
    u = (y - 1820)/100; return -20 + 32*u*u

def canon_c(y):
    # correction to the ELP/DE405 secular acceleration -25.858"/cy^2 (the Canon's own)
    return 0.0 if 1955 <= y <= 2005 else -0.000012932 * (y - 1955) ** 2

def huber(N):
    return 365.25 * N * math.sqrt((N * 0.058 / 3) * (1 + N / 2500)) / 1000

def canon_sigma(y):
    if -1000 <= y <= 1200:
        t = (y - 1820) / 100; return 0.8 * t * t, "M&S 0.8t^2"
    if y < -1000:
        return huber(-500 - y), "Huber from -500"
    if y > 2005:
        return huber(y - 2005), "Huber from 2005"
    return float('nan'), "-"

rows = []
for (y, m, d) in [(-2000,1,1),(-1999,6,15),(-1500,1,1),(-1000,1,1),(-721,1,1),(-720,1,1),(-719,1,1),(-500,1,1),
                  (0,1,1),(500,1,1),(1000,1,1),(1200,1,1),(1549,12,31),(1550,1,1),(2100,1,1),(2650,1,22),(2651,1,1),
                  (2800,1,1),(2999,1,1),(2999,7,1),(3000,12,31)]:
    ti = cli("time-info", "--jd", repr(jd_from_greg(y, m, d)), "--json")
    yy = y + (m - 0.5) / 12
    try:
        cdt = canon_dt(yy)
    except ValueError:
        cdt = float('nan')
    cs, crule = canon_sigma(yy)
    dt, sg = ti["delta_t_s"], ti["delta_t_sigma_s"]
    rows.append((y, m, d, dt, sg, ti["delta_t_source"], cdt, cdt + canon_c(yy), cs, crule, ti["tier"], ti["scale"]))
print(f"{'date':>12} {'engine dT':>11} {'sigma':>8} {'src':>10} | {'canon dT':>10} {'+c(-25.858)':>11} {'eng-canon_c':>11} {'(xsig)':>7} | {'canon sig':>9} rule")
for (y,m,d,dt,sg,src,cdt,cdtc,cs,crule,tier,scale) in rows:
    diff = dt - cdtc
    print(f"{y:5d}-{m:02d}-{d:02d} {dt:11.1f} {sg:8.1f} {src:>10} | {cdt:10.1f} {cdtc:11.1f} {diff:11.1f} {diff/sg if sg else float('nan'):7.2f} | {cs:9.1f} {crule} [{tier},{scale}]")
