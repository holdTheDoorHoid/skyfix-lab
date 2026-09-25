"""Anchorage's residual at sigma1's speed: what f and u NOAA's own sigma1 term has.

First hypothesis tried (no nodal correction, f = 1, u = 0): wrong phase. Then NOAA's term
solved from the engine's and the residual: f = f(O1)^2, u = 2u(O1), i.e. the compound
2O1 - P1. Run tides_year.py 2026 and 2027 first (it writes tides_resid_<year>.json).
The derivation assumes the engine's sigma1 is Schureman's A20 (f(O1), u(O1)), as it was
before verify2's fix (b04cc32); with the fix the residual at sigma1's speed is about zero
and this script then reports NOAA's term as f(O1), u(O1) again, i.e. the engine's."""
import math, numpy as np, json
from v2 import WT
D = math.radians
def astro(jd):
    T = (jd - 2451545.0) / 36525.0
    s = 218.3164477 + 481267.88123421*T - 0.0015786*T*T
    h = 280.46646 + 36000.76983*T + 0.0003032*T*T
    p = 83.3532465 + 4069.0137287*T - 0.0103200*T*T
    N = 125.04452 - 1934.136261*T + 0.0020708*T*T
    return s % 360, h % 360, p % 360, N % 360
def nodal(N):
    om, i = D(23.452), D(5.145)
    Nr = D(N)
    I = math.acos(math.cos(om)*math.cos(i) - math.sin(om)*math.sin(i)*math.cos(Nr))
    e1 = math.atan(math.tan(Nr/2)*math.cos((om-i)/2)/math.cos((om+i)/2)) - Nr/2
    e2 = math.atan(math.tan(Nr/2)*math.sin((om-i)/2)/math.sin((om+i)/2)) - Nr/2
    nu, xi = e1 - e2, -(e1 + e2)
    return I, nu, xi
import json as _json
H, kappa, spd = 0.047, 24.4, 12.92714
# the residual at sigma1's speed, from tides_year.py (run it for 2026 and 2027 first)
RES = {y: _json.load(open(f"tides_resid_{y}.json"))["SIGMA1"] for y in (2026, 2027)}
for year, (A_r, phi_r) in RES.items():
    jd0 = 2451544.5 + (year - 2000) * 365.25 + (1 if year > 2000 else 0) * 0  # approx; fix below
    # exact JD of Jan 1 00:00 UT
    a = (14 - 1)//12; y = year + 4800 - a; m = 1 + 12*a - 3
    jd0 = 1 + (153*m+2)//5 + 365*y + y//4 - y//100 + y//400 - 32045 - 0.5
    jdm = jd0 + (365 if year % 4 else 366) / 2.0  # mid-year
    s, h, p, N0 = astro(jd0)
    V0 = (180.0 - 4*s + 3*h + 90.0) % 360
    I, nu, xi = nodal(astro(jdm)[3])
    f = math.sin(I)*math.cos(I/2)**2/0.3800
    u = math.degrees(2*xi - nu)
    E = f*H*1000*np.exp(1j*D(V0 + u - kappa))
    Nn = H*1000*np.exp(1j*D(V0 - kappa))          # hypothesis: f = 1, u = 0
    R_pred = E - Nn
    R_obs = A_r*np.exp(-1j*D(phi_r))
    print(f"{year}: f(O1)={f:.4f} u={u:+.2f} deg; predicted residual {abs(R_pred):.2f} mm at {math.degrees(np.angle(R_pred)):+.1f} deg;"
          f" observed {abs(R_obs):.2f} mm at {math.degrees(np.angle(R_obs)):+.1f} deg; |diff| {abs(R_pred-R_obs):.2f} mm")

print("\nNOAA's effective sigma1 f and u (N = E - R_obs):")
for year, (A_r, phi_r) in RES.items():
    a = (14 - 1)//12; y = year + 4800 - a; m = 1 + 12*a - 3
    jd0 = 1 + (153*m+2)//5 + 365*y + y//4 - y//100 + y//400 - 32045 - 0.5
    jdm = jd0 + (365 if year % 4 else 366) / 2.0
    s, h, p, _ = astro(jd0)
    V0 = (180.0 - 4*s + 3*h + 90.0) % 360
    I, nu, xi = nodal(astro(jdm)[3])
    f = math.sin(I)*math.cos(I/2)**2/0.3800
    u = (math.degrees(2*xi - nu) + 180) % 360 - 180
    E = f*H*1000*np.exp(1j*D(V0 + u - kappa))
    Nn = E - A_r*np.exp(-1j*D(phi_r))
    fn = abs(Nn)/(H*1000); un = (math.degrees(np.angle(Nn)) - (V0 - kappa) + 180) % 360 - 180
    # candidate: Q1 / O1 / f=1 / Doodson-style
    print(f"  {year}: engine f={f:.4f} u={u:+.2f}  ->  NOAA f={fn:.4f} u={un:+.2f}   (nu={math.degrees(nu):+.2f}, xi={math.degrees(xi):+.2f}, I={math.degrees(I):.2f})")
