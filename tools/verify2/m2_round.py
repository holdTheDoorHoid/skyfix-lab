"""Is the remaining M2 residual at Anchorage NOAA's rounding of V0+u (0.1 deg) or of f?"""
import math, numpy as np, json
from sigma1 import astro, nodal, D
H, kappa = 3.505, 105.2
for year, (A_r, phi_r) in {y: json.load(open(f"tides_resid_{y}.json"))["M2"] for y in (2026, 2027)}.items():
    year = int(year)
    a = (14 - 1)//12; y = year + 4800 - a; m = 1 + 12*a - 3
    jd0 = 1 + (153*m+2)//5 + 365*y + y//4 - y//100 + y//400 - 32045 - 0.5
    jdm = jd0 + (365 if year % 4 else 366) / 2.0
    s, h, p, _ = astro(jd0)
    V0 = (2*180.0 - 2*s + 2*h) % 360
    I, nu, xi = nodal(astro(jdm)[3])
    f = math.cos(I/2)**4/0.9154
    u = math.degrees(2*xi - 2*nu)
    vu = (V0 + u) % 360
    E = f*H*1000*np.exp(1j*D(vu - kappa))
    Nn = E - A_r*np.exp(-1j*D(phi_r))
    fn = abs(Nn)/(H*1000); vun = (math.degrees(np.angle(Nn)) + kappa) % 360
    print(f"{year}: engine f={f:.5f} V0+u={vu:.4f}  NOAA-implied f={fn:.5f} V0+u={vun:.4f}  (V0+u rounded to 0.1: {round(vu,1):.1f}; f to 3 dp {round(f,3):.3f})")
