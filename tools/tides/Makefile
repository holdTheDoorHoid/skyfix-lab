# The tides-us pack and its NOAA fixtures (tools/tides/README.md). From anywhere:
#
#     make -C tools/tides          # fetch (cached), fixtures, pack, sweep, repack
#     make -C tools/tides offline  # everything from the cache, no network
#
# Development-time only; cargo build/test never run this.

REPO := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../..)
PY   := python3

.PHONY: all offline fetch fixtures fixtures-offline pack sweep help

## all: fetch what is missing from NOAA, then fixtures, pack, sweep and the flagged repack
all: fetch fixtures sweep

## offline: rebuild fixtures and pack from the cache only
offline: fixtures-offline sweep

## fetch: station list, offsets, constants and datums (about 1 260 requests the first time)
fetch:
	cd $(REPO) && $(PY) -m tools.tides.fetch

## fixtures: NOAA's own predictions, validation set and all-station sweep (about 3 550 requests)
fixtures:
	cd $(REPO) && $(PY) -m tools.tides.fixtures

fixtures-offline:
	cd $(REPO) && $(PY) -m tools.tides.fixtures --offline

## pack: web/public/data/packs/tides-us-<rev>.bin and tides-us.json
pack:
	cd $(REPO) && $(PY) -m tools.tides.build

## sweep: check every station against NOAA, record the ones that differ, rebuild the pack
sweep: pack
	cd $(REPO) && cargo run --release -q -p skyfix-tides --example noaa_sweep -- \
	    $$(ls web/public/data/packs/tides-us-*.bin) fixtures/reference/tides_noaa_sweep.json \
	    --write tools/tides/noaa_differs.json
	cd $(REPO) && $(PY) -m tools.tides.build

help:
	@grep -E '^## ' $(lastword $(MAKEFILE_LIST)) | sed 's/^## /  /'
