# Regenerate every reference fixture.  Run from anywhere:
#
#     make -C tools/reference
#
# Development-time only. Nothing produced here is a runtime dependency of the
# Rust workspace, and `cargo build`/`cargo test` never invoke this Makefile.

REPO    := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../..)
VENV    := $(REPO)/tools/reference/.venv
PY      := $(VENV)/bin/python
PIP     := $(VENV)/bin/pip
DATA    := $(REPO)/tools/reference/data

EPHEMERIS       := $(DATA)/de421.bsp
EPHEMERIS_XCHK  := $(DATA)/de440s.bsp
CATALOGUE       := $(DATA)/hip_main.dat

EPHEMERIS_URL      := https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/a_old_versions/de421.bsp
EPHEMERIS_XCHK_URL := https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp
CATALOGUE_URL      := https://cdsarc.cds.unistra.fr/ftp/cats/I/239/hip_main.dat

.PHONY: all offline venv data clean-venv clean-data help

## all: regenerate every fixture, including the USNO query (needs network)
all: venv data
	cd $(REPO) && $(PY) -m tools.reference.generate_all

## offline: regenerate everything except the USNO cross-check
offline: venv data
	cd $(REPO) && $(PY) -m tools.reference.generate_all --offline

## venv: create the virtualenv and install the pinned requirements
venv: $(PY)
$(PY):
	python3 -m venv $(VENV)
	$(PIP) install --quiet --upgrade pip
	$(PIP) install --quiet -r $(REPO)/tools/reference/requirements.txt

## data: download the ephemeris and star catalogue (git-ignored, ~100 MB)
data: $(EPHEMERIS) $(EPHEMERIS_XCHK) $(CATALOGUE)

$(EPHEMERIS):
	mkdir -p $(DATA) && curl -fsSL -o $@ $(EPHEMERIS_URL)

$(EPHEMERIS_XCHK):
	mkdir -p $(DATA) && curl -fsSL -o $@ $(EPHEMERIS_XCHK_URL)

$(CATALOGUE):
	mkdir -p $(DATA) && curl -fsSL -o $@ $(CATALOGUE_URL)

clean-venv:
	rm -rf $(VENV)

clean-data:
	rm -rf $(DATA)

help:
	@grep -E '^## ' $(lastword $(MAKEFILE_LIST)) | sed 's/^## /  /'
