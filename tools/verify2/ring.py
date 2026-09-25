"""Decode the lunar-limb pack's ring (EXPLORER_API, 'The lunar-limb pack') independently."""
import struct, zlib, numpy as np
import glob, os
PACK = sorted(glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "web/public/data/packs/lunar-limb-*.bin")))[-1]
def load(path=PACK):
    b = open(path, "rb").read()
    assert b[:8] == b"SKYFIXPK"
    ver, nlen = struct.unpack_from("<HH", b, 8)
    name = b[12:12 + nlen].decode()
    off = 12 + nlen
    plen, = struct.unpack_from("<I", b, off); off += 4
    payload = b[off:off + plen]
    crc, = struct.unpack_from("<I", b, off + plen)
    assert zlib.crc32(payload) & 0xffffffff == crc, "crc"
    p = payload; o = 0
    assert p[:4] == b"LIMB"; o = 4
    fmt, = struct.unpack_from("<H", p, o); o += 2
    def str8():
        nonlocal o
        n = p[o]; s = p[o + 1:o + 1 + n].decode(); o += 1 + n; return s
    version, source = str8(), str8()
    r_km, quantum_m, step_deg, dmin = struct.unpack_from("<dddd", p, o); o += 32
    na, nd = struct.unpack_from("<HH", p, o); o += 4
    blen, = struct.unpack_from("<I", p, o); o += 4
    body = p[o:o + blen]
    assert o + blen == len(p), "trailing bytes"
    res = np.empty(na * nd, dtype=np.int32)
    k = 0; i = 0; n = len(body)
    while k < n:
        v = body[k]
        if v == 0x80:
            res[i] = struct.unpack_from("<h", body, k + 1)[0]; k += 3
        else:
            res[i] = v - 256 if v > 127 else v; k += 1
        i += 1
    assert i == na * nd, (i, na * nd)
    r = res.reshape(na, nd)            # column j (alpha), row i (delta)
    q = np.cumsum(np.cumsum(r, axis=0), axis=1)   # planar prediction inverted
    h_km = q * quantum_m / 1000.0
    alpha = (np.arange(na) + 0.5) * step_deg
    delta = dmin + (np.arange(nd) + 0.5) * step_deg
    return dict(name=name, version=version, source=source, r_km=r_km, quantum_m=quantum_m,
                step=step_deg, alpha=alpha, delta=delta, h_km=h_km)
if __name__ == "__main__":
    import time; t = time.time()
    R = load()
    print(R["name"], R["version"], R["source"], R["r_km"], R["quantum_m"], R["step"], R["alpha"][[0, -1]], R["delta"][[0, -1]], R["h_km"].shape)
    print("heights km: min %.3f max %.3f mean %.3f" % (R["h_km"].min(), R["h_km"].max(), R["h_km"].mean()), "decoded in %.1f s" % (time.time() - t))
