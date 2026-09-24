//! `skyfix lunar`: clear a lunar distance and find the UTC it was taken at.
//! OWNER: cli agent.
//!
//! `skyfix_core::sights::lunar::lunar_distance` (docs/NAVIGATION_SKY.md section 4) with
//! the CLI's `auto` provider, exactly as the WASM `lunar_distance` export calls it. The
//! input is the export's own document, a `LunarDistanceInput` (EXPLORER_API.md), read
//! from a file or from standard input; `--format json` is the `LunarDistanceResult`.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use skyfix_core::sights::lunar::lunar_distance;
use skyfix_core::types::{LatLon, LunarDistanceInput, LunarDistanceResult, LunarLimb};
use skyfix_ephemeris::ProviderSource;

use super::args::FormatArgs;
use super::methods::labelled;
use super::text;
use crate::exit;
use crate::provider;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// A lunar distance document (the `lunar_distance` input of docs/EXPLORER_API.md):
    /// the DR, the instrument, the body, the watch time and the sextant reading. `-`
    /// reads it from standard input.
    pub input: PathBuf,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// Read and parse the document, with the body name made canonical as the WASM export
/// does.
pub fn read_input(path: &Path) -> Result<LunarDistanceInput> {
    let text = if path.as_os_str() == "-" {
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .context("cannot read the lunar distance document from standard input")?;
        s
    } else {
        std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path.display()))?
    };
    let mut input: LunarDistanceInput = serde_json::from_str(text.trim()).with_context(|| {
        format!(
            "{} is not a lunar distance document (docs/EXPLORER_API.md, lunar_distance)",
            path.display()
        )
    })?;
    input.body = skyfix_ephemeris::body::canonical(&input.body)
        .ok_or_else(|| anyhow!("unknown body {:?}", input.body))?
        .to_string();
    Ok(input)
}

pub fn run(a: &Args) -> Result<u8> {
    let input = read_input(&a.input)?;
    let source = ProviderSource(provider::auto_provider());
    let r = lunar_distance(&input, &source).map_err(|e| anyhow!("{e}"))?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&r)?)?;
    } else {
        report::emit(&render(&r, &input))?;
    }
    Ok(exit::OK)
}

fn limb_words(l: LunarLimb) -> &'static str {
    match l {
        LunarLimb::Near => "near limb",
        LunarLimb::Far => "far limb",
        LunarLimb::Center => "centre",
    }
}

pub fn render(r: &LunarDistanceResult, input: &LunarDistanceInput) -> String {
    let o = &input.observer;
    let dr = LatLon {
        lat_deg: o.lat_deg,
        lon_deg: o.lon_deg,
    };
    let body_limb = input.body_limb.unwrap_or(if r.body == "Sun" {
        LunarLimb::Near
    } else {
        LunarLimb::Center
    });
    let mut out = format!("LUNAR DISTANCE: the Moon to {}\n", r.body);
    labelled(
        "DR",
        &format!(
            "{} ({})",
            report::format_position(dr),
            report::format_position_decimal(dr)
        ),
        &mut out,
    );
    labelled(
        "",
        &format!(
            "height of eye {} m, {} hPa, {} C",
            o.height_of_eye_m, o.pressure_hpa, o.temperature_c
        ),
        &mut out,
    );
    labelled(
        "Reading",
        &format!(
            "{} ({} deg), the Moon's {} to {}'s {}, index correction {:+.1}'",
            text::dm360(input.distance_deg).trim_start(),
            input.distance_deg,
            limb_words(input.moon_limb),
            r.body,
            limb_words(body_limb),
            input.instrument.index_correction_arcmin
        ),
        &mut out,
    );
    labelled("Watch", &input.utc_estimate, &mut out);
    out.push('\n');

    labelled(
        "UTC",
        &format!("{}  sigma {:.1} s", text::utc(r.jd_utc), r.sigma_s),
        &mut out,
    );
    labelled(
        "Watch",
        &format!(
            "{}: add this to the watch's time",
            text::signed_min_s(r.utc_minus_estimate_s)
        ),
        &mut out,
    );
    labelled(
        "Longitude",
        &format!(
            "sigma {:.2}' of longitude, {:.2} NM at the DR latitude, from the time's sigma",
            r.longitude_sigma_arcmin, r.longitude_sigma_nm
        ),
        &mut out,
    );
    labelled(
        "Distance",
        &format!(
            "apparent between the centres {}, cleared (geocentric) {}, changing {:+.3}'/min",
            text::dm360(r.apparent_distance_deg).trim_start(),
            text::dm360(r.cleared_distance_deg).trim_start(),
            r.distance_rate_arcmin_per_min
        ),
        &mut out,
    );

    out.push_str("\nClearing\n");
    out.push_str(&format!(
        "  {}{:>12}{:>12}{:>9}  note\n",
        report::pad("step", 20),
        "before deg",
        "after deg",
        "delta '"
    ));
    for c in &r.clearing {
        out.push_str(&format!(
            "  {}{:>12.6}{:>12.6}{:>9.2}  {}\n",
            report::pad(&c.kind, 20),
            c.before_deg,
            c.after_deg,
            c.delta_arcmin,
            report::flatten(&c.note)
        ));
    }

    let a = &r.altitudes;
    out.push_str("\nAltitudes at the instant found\n");
    out.push_str(&format!(
        "  {}{}{:>10}{:>10}{:>10}{:>14}\n",
        report::pad("body", 10),
        report::pad("source", 10),
        "apparent",
        "true",
        "Az",
        "DR-computed"
    ));
    for (name, source, app, tru, az, comp) in [
        (
            "Moon",
            &a.moon_source,
            a.moon_apparent_deg,
            a.moon_true_deg,
            a.moon_azimuth_deg,
            a.moon_computed_apparent_deg,
        ),
        (
            r.body.as_str(),
            &a.body_source,
            a.body_apparent_deg,
            a.body_true_deg,
            a.body_azimuth_deg,
            a.body_computed_apparent_deg,
        ),
    ] {
        out.push_str(&format!(
            "  {}{}{:>10}{:>10}{:>10}{:>14}\n",
            report::pad(name, 10),
            report::pad(source, 10),
            text::alt(app),
            text::alt(tru),
            text::dm360(az),
            text::alt(comp)
        ));
    }

    out.push_str("\nError budget, 1 sigma, combined in quadrature\n");
    out.push_str(&format!(
        "  {}{:>12}{:>9}\n",
        report::pad("term", 30),
        "distance '",
        "time s"
    ));
    for t in &r.error_budget {
        out.push_str(&format!(
            "  {}{:>12.3}{:>9.1}\n",
            report::pad(&t.name, 30),
            t.distance_arcmin,
            t.time_s
        ));
    }
    let [n, e] = r.dr_sensitivity_arcmin_per_10nm;
    out.push('\n');
    labelled(
        "DR",
        &format!(
            "the cleared distance moves {n:+.3}' per 10 NM of DR error north and {e:+.3}' \
             per 10 NM east"
        ),
        &mut out,
    );
    if r.alternatives.is_empty() {
        labelled(
            "Also",
            "no other instant in the window gives this distance",
            &mut out,
        );
    } else {
        let times: Vec<String> = r.alternatives.iter().map(|x| text::utc(x.jd_utc)).collect();
        labelled(
            "Also",
            &format!(
                "the same distance also occurs at {}: check the watch against these",
                times.join(", ")
            ),
            &mut out,
        );
    }
    if !r.notes.is_empty() {
        out.push_str("\nNotes\n");
        for n in &r.notes {
            for (i, line) in report::wrap(n, 84, "    ").into_iter().enumerate() {
                if i == 0 {
                    out.push_str(&format!("  - {}\n", line.trim_start()));
                } else {
                    out.push_str(&format!("{line}\n"));
                }
            }
        }
    }
    report::warning_block(&r.warnings, &mut out);
    out
}
