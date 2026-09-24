//! `skyfix plan-sights`: tonight's sights. OWNER: cli agent.
//!
//! `skyfix_ephemeris::visibility::plan_sights` (docs/NAVIGATION_SKY.md section 5), called
//! exactly as the WASM `plan_sights` export calls it: the explorer's `Sky` for the Sun
//! and the magnitudes, the CLI's `auto` provider for the directions, every body offered
//! for sights except the Sun, and the planner's default options. For the next evening
//! and the next morning nautical twilight in the window it recommends three to five
//! bodies with their predicted sextant readings. `--format json` is the `SightPlan`.
//!
//! This is not `skyfix plan`, which ranks what is up at one instant for a position; this
//! finds the twilights first and plans each.

use anyhow::{Result, anyhow, bail};
use skyfix_core::corrections::horizon_name;
use skyfix_core::planner::PlanOptions;
use skyfix_core::types::{LatLon, Limb, SightPlan, TwilightPlan};
use skyfix_ephemeris::body::{SUN, Sky};

use super::args::{FormatArgs, PositionArgs, SightOpticsArgs, When, parse_when};
use super::methods::labelled;
use super::text;
use crate::exit;
use crate::provider;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct Args {
    #[command(flatten)]
    pub position: PositionArgs,
    /// Start of the search: YYYY-MM-DD (00:00 UTC that day) or an RFC 3339 UTC instant.
    #[arg(long, value_name = "WHEN", value_parser = parse_when)]
    pub from: When,
    /// End of the search: YYYY-MM-DD (through the end of that day, UTC) or an RFC 3339
    /// UTC instant. At most 7 days after --from.
    #[arg(long, value_name = "WHEN", value_parser = parse_when)]
    pub to: When,
    #[command(flatten)]
    pub optics: SightOpticsArgs,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// The plan the flags ask for.
pub fn plan(a: &Args) -> Result<SightPlan> {
    let (start, end) = (a.from.start_jd(), a.to.end_jd());
    if end <= start {
        bail!(
            "--to must come after --from (a date as --to means the end of that day): {} is not \
             after {}",
            text::utc(end),
            text::utc(start)
        );
    }
    let bodies: Vec<&str> = skyfix_ephemeris::sights::sight_bodies()
        .into_iter()
        .filter(|b| *b != SUN)
        .collect();
    skyfix_ephemeris::visibility::plan_sights(
        &Sky::new(),
        &provider::auto_provider(),
        &bodies,
        &a.optics.observer(a.position.lat, a.position.lon),
        start,
        end,
        &a.optics.instrument(),
        &PlanOptions::default(),
    )
    .map_err(|e| anyhow!("{e}"))
}

pub fn run(a: &Args) -> Result<u8> {
    let p = plan(a)?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&p)?)?;
    } else {
        report::emit(&render(&p, a))?;
    }
    Ok(exit::OK)
}

fn bullets(lines: &[String], out: &mut String) {
    for n in lines {
        for (i, line) in report::wrap(n, 84, "      ").into_iter().enumerate() {
            if i == 0 {
                out.push_str(&format!("    - {}\n", line.trim_start()));
            } else {
                out.push_str(&format!("{line}\n"));
            }
        }
    }
}

pub fn render(p: &SightPlan, a: &Args) -> String {
    let pos = LatLon {
        lat_deg: p.observer.lat_deg,
        lon_deg: p.observer.lon_deg,
    };
    let mut out = String::from("TONIGHT'S SIGHTS\n");
    labelled(
        "Observer",
        &format!(
            "{} ({})",
            report::format_position(pos),
            report::format_position_decimal(pos)
        ),
        &mut out,
    );
    labelled(
        "",
        &format!(
            "height of eye {} m, {} hPa, {} C",
            p.observer.height_of_eye_m, p.observer.pressure_hpa, p.observer.temperature_c
        ),
        &mut out,
    );
    labelled(
        "Instrument",
        &format!(
            "{} horizon, index correction {:+.1}' (added)",
            horizon_name(a.optics.horizon.into()),
            a.optics.ic
        ),
        &mut out,
    );
    labelled(
        "Window",
        &format!("{} to {}", text::utc(p.jd_start), text::utc(p.jd_end)),
        &mut out,
    );
    if p.windows.is_empty() {
        out.push_str(
            "\nNo nautical twilight in this window: the Sun does not pass between 6 and 12 \
             degrees below the horizon here (polar day or night), or the window is too short.\n",
        );
    }
    for w in &p.windows {
        out.push('\n');
        render_window(w, &mut out);
    }
    if !p.notes.is_empty() {
        out.push_str("\nNotes\n");
        let mut s = String::new();
        bullets(&p.notes, &mut s);
        // One level less indent than inside a window.
        for line in s.lines() {
            out.push_str(line.strip_prefix("  ").unwrap_or(line));
            out.push('\n');
        }
    }
    out
}

fn render_window(w: &TwilightPlan, out: &mut String) {
    out.push_str(&format!(
        "{} NAUTICAL TWILIGHT  {} to {}\n",
        w.kind.to_uppercase(),
        text::utc(w.jd_start),
        text::utc(w.jd_end)
    ));
    out.push_str(&format!(
        "  predicted for {}, the Sun at {}; limiting magnitude {:.1}\n",
        text::utc(w.jd_predicted),
        text::alt_inline(w.sun_altitude_deg),
        w.limiting_magnitude
    ));
    if w.sights.is_empty() {
        out.push_str("  no body qualifies\n");
    } else {
        out.push_str(&format!(
            "  {}{}{:>7}  {}{:>9}{:>10}{:>10}\n",
            report::pad("#", 4),
            report::pad("body", 16),
            "mag",
            report::pad("limb", 7),
            "Hs",
            "Zn",
            "Hc"
        ));
        for s in &w.sights {
            out.push_str(&format!(
                "  {}{}{}  {}{:>9}{:>10}{:>10}\n",
                report::pad(&s.step.to_string(), 4),
                report::pad(&s.body, 16),
                text::opt(s.magnitude, 7, 2),
                report::pad(
                    match s.limb {
                        Limb::Center => "centre",
                        Limb::Lower => "lower",
                        Limb::Upper => "upper",
                    },
                    7
                ),
                text::alt(s.hs_deg),
                text::dm360(s.zn_deg),
                text::alt(s.hc_deg)
            ));
        }
        for s in &w.sights {
            for (i, line) in report::wrap(&s.rationale, 82, "       ")
                .into_iter()
                .enumerate()
            {
                if i == 0 {
                    out.push_str(&format!(
                        "  {}  {}\n",
                        report::pad(&format!("{}.", s.step), 3),
                        line.trim_start()
                    ));
                } else {
                    out.push_str(&format!("{line}\n"));
                }
            }
        }
        if let Some(m) = w.plan.predicted.trace_sigma_m {
            out.push_str(&format!(
                "  Taking them all predicts a fix of about {m:.0} m overall (planner, CONVENTIONS 9).\n"
            ));
        }
    }
    if !w.notes.is_empty() {
        out.push_str("  Notes\n");
        bullets(&w.notes, out);
    }
}
