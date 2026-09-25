//! `skyfix sky`: the whole sky from one place at one instant. OWNER: cli agent.
//!
//! `skyfix_almanac::sky::sky_state` (EXPLORER_API.md `sky_state`) with each body's IAU
//! constellation joined in from the display-only star field, exactly as the WASM export
//! joins it: the almanac crate must not depend on the star field (CONVENTIONS 13.6), so
//! the adapters do the join. `--format json` prints that `SkyState` as serde emits it.
//!
//! The Earth's rotation is the site's: DUT1 from `--dut1` (the site's DUT1 field,
//! `set_dut1`), else the IERS history, else 0 (CONVENTIONS 15.2), taken at the instant, as
//! the WASM `sky_state` builds its `Sky` (`skyfix_wasm::explorer::native::sky_at`).
//!
//! The text table shows what the eye sees — the topocentric apparent altitude and the
//! azimuth — beside the Almanac's GHA and declination. It never shows the two altitude
//! families (CONVENTIONS 13.2) side by side as if they were comparable: a navigator's
//! `Hc`/`Zn` are in the JSON, and `skyfix predict` gives the sextant reading.

use anyhow::{Result, anyhow};
use skyfix_almanac::sky::{self as almanac_sky, AlmanacError, SkyPhase, SkyState};
use skyfix_core::types::LatLon;
use skyfix_ephemeris::topocentric::Site;

use super::args::{AirArgs, BodyList, FormatArgs, PositionArgs, parse_bodies, parse_instant};
use super::text;
use crate::exit;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct Args {
    #[command(flatten)]
    pub position: PositionArgs,
    /// Height of the site above the WGS84 ellipsoid, metres. It moves the Moon by its
    /// parallax; it is not the height of eye.
    #[arg(
        long,
        value_name = "M",
        default_value_t = 0.0,
        allow_negative_numbers = true
    )]
    pub height: f64,
    /// The instant, RFC 3339 UTC with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
    /// `all`, `solar_system`, `navigational`, or a comma-separated list of names.
    #[arg(long, value_name = "LIST", default_value = "all", value_parser = parse_bodies)]
    pub bodies: BodyList,
    #[command(flatten)]
    pub air: AirArgs,
    #[command(flatten)]
    pub dut1: super::args::Dut1Args,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run(a: &Args) -> Result<u8> {
    super::wire::set_explorer_dut1(a.dut1.dut1)?;
    let site = Site {
        lat_deg: a.position.lat,
        lon_deg: a.position.lon,
        height_m: a.height,
        pressure_hpa: a.air.pressure,
        temperature_c: a.air.temperature,
    };
    let state = sky_state(&site, a.utc, &a.bodies.0).map_err(|e| anyhow!("{e}"))?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&state)?)?;
    } else {
        report::emit(&render(&state, &site))?;
    }
    for e in &state.errors {
        eprintln!("not computed: {}: {}", e.body, e.message);
    }
    Ok(if state.errors.is_empty() {
        exit::OK
    } else {
        exit::SIGHTS_REJECTED
    })
}

/// `skyfix_almanac::sky::sky_state` on the explorer's astronomy (the Sun, the Moon, the
/// planets and the stars, with the site's DUT1 at the instant), with each body's
/// constellation from `skyfix_starfield::constellation_at`; a direction the boundaries
/// cannot place stays `None`. The same join the WASM `sky_state` export makes.
pub fn sky_state(site: &Site, jd_utc: f64, bodies: &[&str]) -> Result<SkyState, AlmanacError> {
    let sky = skyfix_wasm::explorer::native::sky_at(jd_utc);
    let mut s = almanac_sky::sky_state(&sky, site, jd_utc, bodies)?;
    for b in &mut s.bodies {
        b.constellation = skyfix_starfield::constellation_at(b.ra_deg, b.dec_deg, jd_utc)
            .ok()
            .map(str::to_string);
    }
    Ok(s)
}

/// The sky phase as words (CONVENTIONS 13.4).
pub fn phase_words(p: SkyPhase) -> &'static str {
    match p {
        SkyPhase::Day => "day",
        SkyPhase::Civil => "civil twilight",
        SkyPhase::Nautical => "nautical twilight",
        SkyPhase::Astronomical => "astronomical twilight",
        SkyPhase::Night => "night",
    }
}

pub fn render(s: &SkyState, site: &Site) -> String {
    let p = LatLon {
        lat_deg: site.lat_deg,
        lon_deg: site.lon_deg,
    };
    let mut out = String::from("SKY\n");
    out.push_str(&format!(
        "Observer   {} ({}), {} m above the WGS84 ellipsoid\n",
        report::format_position(p),
        report::format_position_decimal(p),
        site.height_m
    ));
    out.push_str(&format!("Time       {}\n", text::utc(s.jd_utc)));
    out.push_str(&format!(
        "Sky        {}: the Sun's centre is at {}, geometric (CONVENTIONS 13.4)\n",
        phase_words(s.sky_phase),
        text::alt_inline(s.sun_altitude_deg)
    ));
    out.push_str(&format!(
        "Aries      GHA {}\n\n",
        text::dm360(s.gha_aries_deg).trim_start()
    ));

    out.push_str(&format!(
        "  {}{:>9}{:>10}{:>10}{:>11}{:>8}{:>6}  {}\n",
        report::pad("body", 18),
        "alt",
        "Az",
        "GHA",
        "Dec",
        "mag",
        "lit",
        "con"
    ));
    for b in &s.bodies {
        out.push_str(&format!(
            "  {}{:>9}{:>10}{:>10}{:>11}{}{:>6}  {}\n",
            report::pad(&b.body, 18),
            text::alt(b.alt_apparent_deg),
            text::dm360(b.az_deg),
            text::dm360(b.gha_deg),
            text::dec(b.dec_deg),
            text::opt(b.magnitude, 8, 2),
            match b.illuminated_fraction {
                Some(k) => format!("{:.0}%", k * 100.0),
                None => "-".to_string(),
            },
            b.constellation.as_deref().unwrap_or("-")
        ));
    }
    let up = s.bodies.iter().filter(|b| b.above_horizon).count();
    out.push_str(&format!(
        "\n{up} of {} bodies are above the horizon (upper limb above the sea-level horizon).\n",
        s.bodies.len()
    ));
    if !s.errors.is_empty() {
        out.push_str("\nNot computed\n");
        for e in &s.errors {
            for (i, line) in report::wrap(&format!("{}: {}", e.body, e.message), 84, "    ")
                .into_iter()
                .enumerate()
            {
                if i == 0 {
                    out.push_str(&format!("  - {}\n", line.trim_start()));
                } else {
                    out.push_str(&format!("{line}\n"));
                }
            }
        }
    }
    out.push('\n');
    let notes = format!(
        "alt is the topocentric apparent altitude of the centre, what the eye sees: WGS84 \
         site, parallax applied, refraction for {} hPa and {} C (display only, CONVENTIONS \
         13.2); below -1 degree the refraction is held at its -1 degree value, so there alt \
         is a display value and not a measurement. Az is true, clockwise from north. GHA \
         and Dec are apparent geocentric of date, as the Nautical Almanac tabulates them. \
         lit is the illuminated fraction of the disc. con is the IAU constellation, from the display-only star field (CONVENTIONS \
         13.6). A navigator's Hc and Zn at this position are hc_deg and zn_deg in --format \
         json; skyfix predict gives the sextant reading.",
        site.pressure_hpa, site.temperature_c
    );
    for line in report::wrap(&notes, 88, "") {
        out.push_str(&line);
        out.push('\n');
    }
    out
}
