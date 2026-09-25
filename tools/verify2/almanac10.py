"""The ten Bowditch entries that differ by 0.1': the project's chain (Bennett) vs the same chain
with a rigorous refraction (ray-traced standard atmosphere, 10 C, 1010 hPa)."""
import math
from refraction import refraction_arcmin
D, R2D = math.radians, math.degrees
def bennett(ha): return 1.0 / math.tan(D(ha + 7.31 / (ha + 4.4)))
_cache = {}
def rigorous(ha):
    k = round(ha, 6)
    if k not in _cache: _cache[k] = refraction_arcmin(ha, N=200000)
    return _cache[k]
def dm(s):  # "27 48.1" -> degrees
    d, m = s.split(); return int(d) + float(m) / 60
HP_SUN = 8.794 / 60
def sun(ha, sd, refr):   # lower limb
    return -refr(ha) + HP_SUN * math.cos(D(ha)) + sd
def star(ha, refr): return -refr(ha)
def moonC(ha, hp_arcmin, limb, refr, k=0.2725076):
    r = refr(ha) / 60.0; hp = D(hp_arcmin / 60.0)
    sd = R2D(math.asin(k * math.sin(hp)))
    h_air = ha - r; sd_t = sd
    for _ in range(6):
        hc = h_air + (sd_t if limb == 'lower' else -sd_t)
        sd_t = sd / (1 - math.sin(hp) * math.sin(D(hc)))
    hc = h_air + (sd_t if limb == 'lower' else -sd_t)
    pa = R2D(math.asin(math.sin(hp) * math.cos(D(hc))))
    return (hc + pa - ha) * 60.0
def tp(ha, t_f, p_inhg, refr):
    T = (t_f - 32) / 1.8; P = p_inhg * 33.8639
    f = (P / 1010.0) * (283.0 / (273.0 + T))
    return refr(ha) * (1 - f)
rows = [
 ("stars Ha 27 48.1", -1.8, lambda r: star(dm("27 48.1"), r)),
 ("0-10 Sun Oct-Mar LL 6 29.7", +8.4, lambda r: sun(dm("6 29.7"), 16.15, r)),
 ("0-10 Sun Apr-Sep LL 1 19.7", -5.8, lambda r: sun(dm("1 19.7"), 15.9, r)),
 ("0-10 stars 4 02.1", -11.6, lambda r: star(dm("4 02.1"), r)),
 ("T and P exact, Ha 1 19.7 (88F, 29.78)", +1.5, lambda r: tp(dm("1 19.7"), 88, 29.78, r)),
 ("Moon upper 3 50", 56.1, lambda r: moonC(dm("3 50"), 57.7, 'lower', r) - 5),
 ("Moon upper 18 00", 62.5, lambda r: moonC(18.0, 57.7, 'lower', r) - 5),
 ("Moon upper 66 40", 33.1, lambda r: moonC(dm("66 40"), 57.7, 'lower', r) - 5),
 ("Moon upper 2 30", 52.2, lambda r: moonC(2.5, 57.7, 'lower', r) - 5),
 ("Moon U, HP 59.6, col 0-5 (at 2.5)", 5.0, lambda r: moonC(2.5, 59.6, 'upper', r) - moonC(2.5, 57.7, 'lower', r) + 35),
]
def rnd(x): return math.floor(x * 10 + 0.5) / 10
print(f"{'entry':40s} printed | Bennett (ours)   | rigorous refraction")
for name, printed, fn in rows:
    b, g = fn(bennett), fn(rigorous)
    print(f"{name:40s} {printed:+6.1f} | {b:+8.3f} -> {rnd(b):+5.1f} | {g:+8.3f} -> {rnd(g):+5.1f} {'= printed' if abs(rnd(g)-printed)<1e-9 else 'DIFFERS'}")

print("\nMoon examples, the navigator's total (upper + lower part [- 30' for U]) vs the exact chain:")
ex = [("s1908 Ha 3 47.2 HP 54.3 LL", dm("3 47.2"), 54.3, 'lower', 56.1 + 0.7, 56.2 + 0.7),
      ("s619-1 Ha 18 02.3 HP 59.6 LL", dm("18 02.3"), 59.6, 'lower', 62.5 + 7.4, 62.6 + 7.4),
      ("s619-2 Ha 66 37.6 HP 59.6 UL", dm("66 37.6"), 59.6, 'upper', 33.1 + 3.8 - 30, 33.2 + 3.8 - 30),
      ("s622-3 Ha 2 29.8 HP 59.6 UL", dm("2 29.8"), 59.6, 'upper', 52.2 + 5.0 - 30, 52.3 + 4.9 - 30)]
for name, ha, hp, limb, printed, ours in ex:
    eb, eg = moonC(ha, hp, limb, bennett), moonC(ha, hp, limb, rigorous)
    print(f"  {name:32s} printed {printed:6.1f}  ours {ours:6.1f}  exact chain (Bennett) {eb:7.3f}  (rigorous refraction) {eg:7.3f}")

print("\nLower part with a base HP of 57.7' (project) and 57.6' (hypothesis), column middles:")
lp = [("L HP 54.3 col 0-5", 2.5, 54.3, 'lower', 0.7), ("L HP 59.6 col 15-20", 17.5, 59.6, 'lower', 7.4),
      ("U HP 59.6 col 65-70", 67.5, 59.6, 'upper', 3.8), ("U HP 59.6 col 0-5", 2.5, 59.6, 'upper', 5.0)]
for name, hac, hp, limb, printed in lp:
    out = []
    for base in (57.7, 57.6):
        add = 5 if limb == 'lower' else 35
        v = moonC(hac, hp, limb, bennett) - moonC(hac, base, 'lower', bennett) + add
        out.append(f"{v:7.3f}->{rnd(v):4.1f}")
    print(f"  {name:22s} printed {printed:4.1f}   base 57.7: {out[0]}   base 57.6: {out[1]}")
print("upper part with base 57.6':", [f"{rnd(moonC(h, 57.6, 'lower', bennett) - 5):.1f}" for h in (dm('3 50'), 18.0, dm('66 40'), 2.5)], "printed 56.1 62.5 33.1 52.2")
