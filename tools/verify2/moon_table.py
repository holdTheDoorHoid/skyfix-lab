"""The Nautical Almanac's Moon upper part at four altitudes: the project's chain vs variants."""
import math
D, R2D = math.radians, math.degrees
def bennett(ha):  # arcmin, ha degrees (apparent)
    return 1.0 / math.tan(D(ha + 7.31 / (ha + 4.4)))
def C(ha_deg, hp_arcmin, k=0.2725076, augment=True, refr=bennett, pa_rigorous=True):
    r = refr(ha_deg) / 60.0
    hp = D(hp_arcmin / 60.0)
    sd = R2D(math.asin(k * math.sin(hp)))  # geocentric SD, deg
    # lower limb: apparent centre = ha + sd_topo ; iterate topocentric SD with augmentation
    h_air = ha_deg - r  # airless altitude of the lower limb
    sd_t = sd
    for _ in range(5):
        hc = h_air + sd_t  # airless topocentric altitude of the centre
        if augment:
            # topocentric distance ratio: rho/r ~ 1 - sin(hp) sin(hc) (to first order)
            sd_t = sd / (1 - math.sin(hp) * math.sin(D(hc)))
        else:
            sd_t = sd
    hc = h_air + sd_t
    # geocentric altitude from topocentric (rigorous): sin(p) = sin(hp) cos(h_topo)
    pa = R2D(math.asin(math.sin(hp) * math.cos(D(hc)))) if pa_rigorous else hp_arcmin / 60 * math.cos(D(hc))
    ho = hc + pa
    return (ho - ha_deg) * 60.0
cases = [(3 + 50/60, 56.1), (18.0, 62.5), (66 + 40/60, 33.1), (2.5, 52.2)]
print(" Ha      printed | chain(k=.2725076,aug) | no augmentation | k=0.2724 | HP 57.0 | HP 57.5")
for ha, printed in cases:
    v = C(ha, 57.7) - 5
    print(f"{ha:6.3f} {printed:6.1f}   | {v:8.3f} -> {round(v,1):5.1f} | {C(ha,57.7,augment=False)-5:8.3f} | {C(ha,57.7,k=0.2724)-5:8.3f} | {C(ha,57.0)-5:8.3f} | {C(ha,57.5)-5:8.3f}")
