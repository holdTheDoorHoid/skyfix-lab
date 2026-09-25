import json, subprocess
from v2 import CLI, WT
import glob
PACK = sorted(glob.glob(WT + "/web/public/data/packs/lunar-limb-*.bin"))[-1]
fx = json.load(open(WT + "/fixtures/reference/eclipse_limb_svs.json"))
out = []
for e in fx["eclipses"]:
    for c in e["cities"]:
        if len(c["svs"]["ECLIPSE"]) < 6: continue
        r = subprocess.run([CLI, "--pack", PACK, "eclipse", e["id"], "--lat", str(c["lat_deg"]), "--lon", str(c["lon_deg"]),
                            "--height", str(c["height_m"]), "--limb", "--json"], capture_output=True, text=True)
        d = json.loads(r.stdout)
        out.append({"eclipse": e["id"], "name": c["name"], "doc": d})
json.dump(out, open("engine_limb.json", "w"))
d = out[0]["doc"]
print(list(d.keys())); print(json.dumps(d.get("limb"), indent=1)[:1500])
