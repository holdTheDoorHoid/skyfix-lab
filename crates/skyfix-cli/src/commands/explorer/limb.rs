//! The lunar limb from the optional `lunar-limb` pack: `limb-profile` and `limb-pack`.
//! `skyfix eclipse ID --lat --lon --limb` gives the limb-corrected contacts. OWNER: cli3
//! agent.
//!
//! Engine: `skyfix_almanac::eclipses::limb` through the WASM adapter's
//! `skyfix_wasm::limb::native`, with the ring the pack installs (`--pack
//! web/public/data/packs/lunar-limb`); wire format EXPLORER_API.md "Expansion programme
//! P12 — the lunar limb"; definitions CONVENTIONS 15.7. Display only, like every eclipse
//! quantity.

use anyhow::{Result, anyhow};
use skyfix_almanac::eclipses::LimbProfile;
use skyfix_wasm::limb::native;

use super::args::{Dut1Args, FormatArgs, parse_instant};
use super::text;
use super::wire::{
    Align, SiteArgs, Table, emit_json, observer_line, push_field, push_note, set_explorer_dut1,
};
use crate::exit;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct ProfileArgs {
    #[command(flatten)]
    pub site: SiteArgs,
    /// The instant, RFC 3339 with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
    /// Print the height every this many degrees of position angle in the text (the JSON
    /// has every 1/16 degree).
    #[arg(long, value_name = "DEG", default_value_t = 5.0)]
    pub every: f64,
    #[command(flatten)]
    pub dut1: Dut1Args,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_profile(a: &ProfileArgs) -> Result<u8> {
    set_explorer_dut1(a.dut1.dut1)?;
    let ring = native::installed();
    let p = native::lunar_limb_profile_in(ring.as_deref(), &a.site.json(), a.utc).map_err(|e| {
        if e.starts_with("pack_not_loaded") {
            anyhow!(
                "{e}\nLoad it for this run with --pack web/public/data/packs/lunar-limb \
                     (from the repository root), or --pack FILE for a copy of the pack"
            )
        } else {
            anyhow!(e)
        }
    })?;
    if a.format.is_json() {
        emit_json(&p)?;
    } else {
        report::emit(&render_profile(&p, a))?;
    }
    Ok(exit::OK)
}

fn render_profile(p: &LimbProfile, a: &ProfileArgs) -> String {
    let mut out = String::from("THE MOON'S LIMB\n");
    push_field(&mut out, "Observer", &observer_line(&a.site.site()));
    push_field(&mut out, "Time", &text::utc(p.jd_utc));
    push_field(
        &mut out,
        "Moon",
        &format!(
            "{:.0} km away; the {} km sphere is {:.3}\" in radius here; libration {:+.3}, \
             {:+.3} deg; its north pole at PA {:.2} deg, the zenith at {:.2} deg",
            p.moon_distance_km,
            p.reference_radius_km,
            p.reference_radius_arcsec,
            p.libration_lon_deg,
            p.libration_lat_deg,
            p.axis_position_angle_deg,
            p.parallactic_angle_deg
        ),
    );
    push_field(
        &mut out,
        "Sun",
        &format!(
            "radius {:.3}\", centre {:+.3}\" east and {:+.3}\" north of the Moon's",
            p.sun_radius_arcsec, p.sun_offset_east_arcsec, p.sun_offset_north_arcsec
        ),
    );
    push_field(
        &mut out,
        "Mean limb",
        &format!(
            "NASA's k1 Moon {:+.3}\", k2 Moon {:+.3}\" against the sphere",
            p.mean_limb_k1_arcsec, p.mean_limb_k2_arcsec
        ),
    );
    out.push('\n');
    let every = (a.every / p.step_deg).round().max(1.0) as usize;
    let mut t = Table::new(&[("PA deg", Align::Right), ("height \"", Align::Right)]);
    for (k, h) in p.height_arcsec.iter().enumerate().step_by(every) {
        t.row(vec![
            format!("{:.2}", p.start_deg + k as f64 * p.step_deg),
            h.map_or_else(|| "-".to_string(), |h| format!("{h:+.3}")),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "Heights above the {} km sphere at position angles from the Moon's centre, north \
             through east, every {} deg of the {} in --format json.{}",
            p.reference_radius_km,
            a.every,
            p.height_arcsec.len(),
            if p.ring_truncated {
                " Ground beyond the ring's reach might have stood out here (ring_truncated)."
            } else {
                ""
            }
        ),
    );
    out
}

#[derive(clap::Args, Debug)]
pub struct PackArgs {
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_pack(a: &PackArgs) -> Result<u8> {
    let info = native::pack_info();
    if a.format.is_json() {
        emit_json(&info)?;
        return Ok(exit::OK);
    }
    let out = match info {
        Some(i) => format!(
            "LUNAR LIMB PACK\nPack       {} {}: {}\nRing       every {} deg ({:.3} km), {} to {} \
             deg from the mean limb, heights {} m to {} m above {} km\n",
            i.name,
            i.version,
            i.source,
            i.step_deg,
            i.resolution_km,
            i.delta_min_deg,
            i.delta_max_deg,
            i.min_height_m,
            i.max_height_m,
            i.reference_radius_km
        ),
        None => "LUNAR LIMB PACK\nPack       not loaded: give --pack \
                 web/public/data/packs/lunar-limb\n"
            .to_string(),
    };
    report::emit(&out)?;
    Ok(exit::OK)
}
