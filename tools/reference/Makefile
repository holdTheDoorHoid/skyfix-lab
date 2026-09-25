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

VSOP87_DIR   := $(DATA)/vsop87
VSOP87_URL   := https://cdsarc.cds.unistra.fr/ftp/cats/VI/81
VSOP87_FILES := VSOP87A.ear VSOP87A.mer VSOP87A.ven VSOP87A.mar VSOP87A.jup \
                VSOP87A.sat VSOP87A.ura VSOP87A.nep vsop87.chk vsop87.txt

# ELP/MPP02 (Chapront & Francou 2003). SYRTE's directory
# ftp://cyrano-se.obspm.fr/pub/2_lunar_solutions/2_elpmpp02/ was unreachable on
# 2026-09-24; the verbatim mirror below is pinned by SHA-256 in elpmpp02.py.
ELPMPP02_DIR   := $(DATA)/series/elpmpp02
ELPMPP02_URL   := https://raw.githubusercontent.com/THRASTRO/ephem.js/develop/src/elpmpp02/data
ELPMPP02_FILES := ELP_MAIN.S1 ELP_MAIN.S2 ELP_MAIN.S3 ELP_PERT.S1 ELP_PERT.S2 ELP_PERT.S3 \
                  ELPMPP02.for README.TXT elpmpp02.pdf

# The long-span kernels (EXPANSION_PLAN 4.6): DE440 (1550-2650, 114 MB) and DE441
# (-13200..17191 in two files, 3.1 GB). Only `series` and `deeptime` need them.
NAIF_PLANETS := https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets
DE440        := $(DATA)/de440.bsp
DE441        := $(DATA)/de441_part-1.bsp $(DATA)/de441_part-2.bsp

.PHONY: all offline venv data vsop87 elpmpp02 kernels series deeptime clean-venv clean-data help

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

## vsop87: download the CDS VI/81 files the embedded Sun and planet series are cut from (git-ignored)
vsop87: $(addprefix $(VSOP87_DIR)/,$(VSOP87_FILES))

$(VSOP87_DIR)/%:
	mkdir -p $(VSOP87_DIR) && curl -fsSL -o $@ $(VSOP87_URL)/$*

## elpmpp02: download the ELP/MPP02 files the embedded Moon series is cut from (git-ignored)
elpmpp02: $(addprefix $(ELPMPP02_DIR)/,$(ELPMPP02_FILES))

$(ELPMPP02_DIR)/%:
	mkdir -p $(ELPMPP02_DIR) && curl -fsSL -o $@ $(ELPMPP02_URL)/$*

## kernels: download JPL DE440 and DE441 (about 3.2 GB, git-ignored)
kernels: $(DE440) $(DE441)

$(DATA)/de44%.bsp:
	mkdir -p $(DATA) && curl -fsSL -o $@ $(NAIF_PLANETS)/de44$*.bsp

## series: regenerate crates/skyfix-ephemeris/data/series.bin and series_checks.json (both tiers, about 10 minutes)
series: venv vsop87 elpmpp02 kernels
	cd $(REPO) && $(PY) -m tools.reference.build_series --vsop-source $(VSOP87_DIR) --elp-source $(ELPMPP02_DIR)

## deeptime: regenerate fixtures/reference/deeptime_bodies.json (DE440 and DE441, about 25 minutes)
deeptime: venv data kernels
	cd $(REPO) && $(PY) -m tools.reference.gen_deeptime

clean-venv:
	rm -rf $(VENV)

clean-data:
	rm -rf $(DATA)

help:
	@grep -E '^## ' $(lastword $(MAKEFILE_LIST)) | sed 's/^## /  /'
