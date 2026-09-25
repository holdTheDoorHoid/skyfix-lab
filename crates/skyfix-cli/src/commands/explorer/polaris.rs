//! `skyfix polaris`: latitude from sights of Polaris. OWNER: cli agent.
//!
//! `skyfix_core::methods::polaris::polaris_latitude` (docs/NAVIGATION_METHODS.md section
//! 3) with `skyfix_ephemeris::stars::EphemerisPolarisTable` for the Nautical Almanac's
//! a0, a1, a2 teaching terms, exactly as the WASM export calls it. `--format json` is
//! its `PolarisResult` (EXPLORER_API.md `polaris_latitude`). Observations of other bodies
//! in the session are ignored with a warning naming them.

use std::path::PathBuf;

use anyhow::{Result, anyhow};
use skyfix_core::methods::polaris::{self, is_polaris};
use skyfix_core::types::{DrPosition, PolarisOptions, PolarisResult, VesselMotion};
use skyfix_ephemeris::stars::EphemerisPolarisTable;

use super::args::{Dut1Args, FormatArgs, parse_dr, parse_vessel, wire_instant};
use super::methods::{self, labelled, latitude_line};
use super::text;
use crate::provider::EphemerisChoice;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Session file (.json or .csv) with one or more sights of Polaris.
    pub session: PathBuf,
    /// DR position LAT,LON[,SIGMA_NM]. The longitude is required (Polaris' correction
    /// depends on its hour angle); SIGMA_NM enters the latitude's sigma. Default: the
    /// session's assumed position.
    #[arg(long, value_name = "LAT,LON[,SIGMA_NM]", value_parser = parse_dr, allow_hyphen_values = true)]
    pub dr: Option<DrPosition>,
    /// Course and speed over the ground between the sights: COURSE_DEG,SPEED_KN.
    #[arg(long, value_name = "COURSE,SPEED", value_parser = parse_vessel)]
    pub vessel: Option<VesselMotion>,
    /// The instant a combined latitude refers to, RFC 3339 UTC. Default: the last sight.
    #[arg(
        long = "reference-utc",
        value_name = "RFC3339",
        allow_hyphen_values = true
    )]
    pub reference_utc: Option<String>,
    /// Where body directions come from when an observation has no geocentric block.
    #[arg(long, value_enum, default_value_t = EphemerisChoice::Auto, value_name = "MODE")]
    pub ephemeris: EphemerisChoice,
    #[command(flatten)]
    pub dut1: Dut1Args,
    #[command(flatten)]
    pub format: FormatArgs,
}

impl Args {
    pub fn options(&self) -> Result<PolarisOptions> {
        // As the engine's wire string: the flag may be typed in the Julian calendar.
        let reference_utc = match &self.reference_utc {
            Some(u) => Some(wire_instant(u).map_err(|e| anyhow!("--reference-utc: {e}"))?),
            None => None,
        };
        Ok(PolarisOptions {
            dr: self.dr,
            vessel: self.vessel,
            reference_utc,
        })
    }
}

pub fn run(a: &Args) -> Result<u8> {
    let mut session = methods::load(&a.session)?;
    a.dut1.apply(&mut session);
    let source = methods::source(a.ephemeris, &session);
    let r = polaris::polaris_latitude(
        &session,
        source.as_ref(),
        Some(&EphemerisPolarisTable),
        &a.options()?,
    )
    .map_err(|e| anyhow!("{e}"))?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&r)?)?;
    } else {
        let mut out = String::from("LATITUDE BY POLARIS\n");
        out.push_str(&methods::header(
            &session,
            a.ephemeris,
            &r.sights,
            a.dr,
            a.vessel,
        ));
        out.push('\n');
        out.push_str(&render(&r));
        report::emit(&out)?;
    }
    // A Polaris sight the reducer rejected, or one no latitude on the DR meridian fits,
    // is left out with a warning; other bodies are ignored, not rejected.
    let n_polaris = session
        .observations
        .iter()
        .filter(|o| is_polaris(&o.body))
        .count();
    Ok(methods::exit_for(n_polaris - r.polaris.len(), n_polaris))
}

pub fn render(r: &PolarisResult) -> String {
    let mut out = String::new();
    labelled(
        "Latitude",
        &format!(
            "{}  at {}",
            latitude_line(r.latitude.lat_deg, r.latitude.sigma_arcmin),
            text::utc(r.reference_jd_utc)
        ),
        &mut out,
    );
    if let Some(chi2) = r.chi2 {
        labelled(
            "",
            &format!(
                "{} sights combined: chi2 {} on {} degree(s) of freedom",
                r.polaris.len(),
                text::fixed(chi2, 3),
                r.dof
            ),
            &mut out,
        );
    }

    out.push_str("\nSights\n");
    out.push_str(&format!(
        "  {}{}{:>9}{:>10}{:>10}  {}{:>8}\n",
        report::pad("id", 10),
        report::pad(text::scale_word(r.reference_jd_utc), 21),
        "Ho",
        "LHA",
        "Zn",
        report::pad("latitude", 12),
        "sigma '"
    ));
    for s in &r.polaris {
        out.push_str(&format!(
            "  {}{}{:>9}{:>10}{:>10}  {}{:>8.2}\n",
            report::pad(&s.id, 10),
            report::pad(&text::utc(s.jd_utc), 21),
            text::alt(s.ho_deg),
            text::dm360(s.lha_deg),
            text::dm360(s.azimuth_deg),
            report::pad(&report::format_lat(s.latitude.lat_deg), 12),
            s.latitude.sigma_arcmin
        ));
        let lon = match s.sigma_from_longitude_arcmin {
            Some(l) => format!("{l:.2}"),
            None => "not stated".to_string(),
        };
        let resid = match s.normalized_residual {
            Some(z) => format!(
                "; {} sigma from the combined latitude",
                text::signed_fixed(z, 2)
            ),
            None => String::new(),
        };
        for line in report::wrap(
            &format!(
                "correction (latitude - Ho) {}'; sigma parts: altitude {:.2}', DR longitude \
                 {lon} ({}' per NM east), clock {:.2}'{resid}",
                text::fixed(s.correction_arcmin, 2),
                s.sigma_from_altitude_arcmin,
                text::signed_fixed(s.longitude_sensitivity_arcmin_per_nm, 4),
                s.sigma_from_clock_arcmin
            ),
            84,
            "    ",
        ) {
            out.push_str(&line);
            out.push('\n');
        }
    }

    if r.polaris.iter().any(|s| s.almanac.is_some()) {
        out.push_str(
            "\nAlmanac Polaris table, unrounded (teaching only; the rigorous latitude is above)\n",
        );
        out.push_str(&format!(
            "  {}{:>10}{:>8}{:>8}{:>8}  {}{:>18}\n",
            report::pad("id", 10),
            "LHA Aries",
            "a0 '",
            "a1 '",
            "a2 '",
            report::pad("Ho - 1 + a0 + a1 + a2", 22),
            "rigorous minus '"
        ));
        let mut notes: Vec<&str> = Vec::new();
        for s in &r.polaris {
            let Some(t) = &s.almanac else { continue };
            out.push_str(&format!(
                "  {}{:>10}{:>8.2}{:>8.2}{:>8.2}  {}{:>18}{}\n",
                report::pad(&s.id, 10),
                text::dm360(t.lha_aries_deg),
                t.a0_arcmin,
                t.a1_arcmin,
                t.a2_arcmin,
                report::pad(&report::format_lat(t.latitude_deg), 22),
                text::fixed(t.difference_arcmin, 3),
                if t.within_printed_table {
                    ""
                } else {
                    "  outside the printed a1 table"
                }
            ));
            if !notes.contains(&t.note.as_str()) {
                notes.push(&t.note);
            }
        }
        for n in notes {
            for line in report::wrap(n, 84, "  ") {
                out.push_str(&line);
                out.push('\n');
            }
        }
    }
    methods::warnings(&r.warnings, &mut out);
    methods::workings_note(&mut out);
    out
}
