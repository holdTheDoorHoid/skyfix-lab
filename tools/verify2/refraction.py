"""Rigorous astronomical refraction by ray tracing a standard atmosphere (Hohenkerk & Sinclair
style: polytropic troposphere, 6.5 K/km to 11 km, isothermal stratosphere; dry air), at the
Nautical Almanac's standard 10 C, 1010 hPa. R(apparent altitude) in arcminutes."""
import math, numpy as np
R_E = 6378120.0          # H&S's Earth radius, m
G, M, RGAS = 9.784, 28.9644, 8314.32
ALPHA = 0.0065           # K/m
HT = 11000.0             # tropopause, m
LAMBDA_UM = 0.574
# Dry air at optical wavelengths (Hohenkerk & Sinclair 1985): (n-1) 1e6 = (287.604 +
# 1.6288/l^2 + 0.0136/l^4) (P/1013.25)(273.15/T), i.e. per hPa/K:
A_REFR = (287.604 + 1.6288 / LAMBDA_UM**2 + 0.0136 / LAMBDA_UM**4) * 1e-6 * 273.15 / 1013.25
def atmosphere(T0=283.15, P0=1010.0):
    delta = G * M / (RGAS * ALPHA)
    Tt = T0 - ALPHA * HT
    Pt = P0 * (Tt / T0) ** delta
    nt1 = A_REFR * Pt / Tt
    def n_minus_1(h):
        h = np.asarray(h, float)
        tro = h < HT
        T = np.where(tro, T0 - ALPHA * h, Tt)
        P = np.where(tro, P0 * (np.clip(T, 1, None) / T0) ** delta, Pt * np.exp(-G * M * (h - HT) / (RGAS * Tt)))
        return A_REFR * P / T
    return n_minus_1
def refraction_arcmin(app_alt_deg, T0=283.15, P0=1010.0, top=120000.0, N=400000):
    nm1 = atmosphere(T0, P0)
    z0 = math.radians(90.0 - app_alt_deg)
    n0 = 1 + float(nm1(0.0))
    c = n0 * R_E * math.sin(z0)
    # substitution h = u^2 removes the horizon singularity
    u = np.linspace(0.0, math.sqrt(top), N)
    h = u * u
    r = R_E + h
    n = 1 + nm1(h)
    dh = 1e-2
    dn_dh = (nm1(h + dh) - nm1(np.maximum(h - dh, 0))) / (np.where(h > dh, 2 * dh, dh + np.minimum(h, dh)))
    s = c / (n * r)
    s = np.clip(s, -1, 1 - 1e-16)
    tanz = s / np.sqrt(1 - s * s)
    f = tanz * (-dn_dh) / n * 2 * u      # dR/du
    Rrad = np.trapezoid(f, u)
    return math.degrees(Rrad) * 60.0
if __name__ == "__main__":
    import erfa
    refa, refb = erfa.refco(1010.0, 10.0, 0.0, 0.574)
    print(" alt   ray-trace  ERFA A tanz+B tan^3z   Bennett")
    for a in [0.0, 1/3, 1.0, 2.0, 2.5, 3 + 50/60, 4 + 2.1/60, 5.0, 6 + 29.7/60, 10.0, 18.0, 20.0, 27 + 48.1/60, 45.0, 66 + 40/60]:
        z = math.radians(90 - a)
        erfa_r = math.degrees(refa * math.tan(z) + refb * math.tan(z) ** 3) * 60 if a >= 10 else float('nan')
        ben = 1 / math.tan(math.radians(a + 7.31 / (a + 4.4)))
        print(f"{a:6.3f}  {refraction_arcmin(a):8.3f}   {erfa_r:8.3f}            {ben:8.3f}")
