# Reference fixture generation (development-time only)

Python + Skyfield scripts that produce `fixtures/reference/*.json`. They are never a
runtime dependency and never run in CI on the hot path. Record the exact package
versions, ephemeris file and Earth-orientation assumptions in every output file.
