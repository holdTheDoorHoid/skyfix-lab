//! `skyfix average`: a run of sights of one body averaged into one sight. OWNER: cli agent.
//!
//! `skyfix_core::methods::averaging::average_sights` (docs/NAVIGATION_METHODS.md section
//! 4): the shape of the run is predicted at the DR and only its level is fitted, so the
//! average is right even though the altitude changes by ten arcminutes a minute.
//! `--format json` is its `AveragedSight` (EXPLORER_API.md `average_sights`), whose
//! `observation` can go straight into a session for `skyfix solve`; the text report
//! prints that observation as one line of JSON for the same purpose.

use std::path::PathBuf;

use anyhow::{Result, anyhow};
use skyfix_core::methods::averaging;
use skyfix_core::types::{AveragedSight, AveragingOptions, DrPosition, VesselMotion};

use super::args::{Dut1Args, FormatArgs, parse_dr, parse_vessel, wire_instant};
use super::methods::{self, labelled};
use super::text;
use crate::provider::EphemerisChoice;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Session file (.json or .csv): a run of sights of ONE body over a few minutes.
    pub session: PathBuf,
    /// The instant of the averaged sight, RFC 3339 UTC. Default: the weighted mean time
    /// of the sights used, where the sigma is smallest.
    #[arg(long = "reference-utc", value_name = "RFC3339")]
    pub reference_utc: Option<String>,
    /// DR position LAT,LON[,SIGMA_NM]: where the slope is predicted. Default: the
    /// session's assumed position. Required one way or the other.
    #[arg(long, value_name = "LAT,LON[,SIGMA_NM]", value_parser = parse_dr, allow_hyphen_values = true)]
    pub dr: Option<DrPosition>,
    /// Course and speed over the ground during the run: COURSE_DEG,SPEED_KN.
    #[arg(long, value_name = "COURSE,SPEED", value_parser = parse_vessel)]
    pub vessel: Option<VesselMotion>,
    /// Flag outliers but keep them in the average (they are left out by default).
    #[arg(long = "keep-outliers")]
    pub keep_outliers: bool,
    /// Leave-one-out normalised residual above which a sight is an outlier.
    #[arg(
        long = "outlier-threshold",
        value_name = "SIGMAS",
        default_value_t = 3.0
    )]
    pub outlier_threshold: f64,
    /// Where body directions come from when an observation has no geocentric block.
    #[arg(long, value_enum, default_value_t = EphemerisChoice::Auto, value_name = "MODE")]
    pub ephemeris: EphemerisChoice,
    #[command(flatten)]
    pub dut1: Dut1Args,
    #[command(flatten)]
    pub format: FormatArgs,
}

impl Args {
    pub fn options(&self) -> Result<AveragingOptions> {
        // As the engine's wire string: the flag may be typed in the Julian calendar.
        let reference_utc = match &self.reference_utc {
            Some(u) => Some(wire_instant(u).map_err(|e| anyhow!("--reference-utc: {e}"))?),
            None => None,
        };
        Ok(AveragingOptions {
            reference_utc,
            dr: self.dr,
            vessel: self.vessel,
            reject_outliers: !self.keep_outliers,
            outlier_threshold: self.outlier_threshold,
        })
    }
}

pub fn run(a: &Args) -> Result<u8> {
    let mut session = methods::load(&a.session)?;
    a.dut1.apply(&mut session);
    let source = methods::source(a.ephemeris, &session);
    let r = averaging::average_sights(&session, source.as_ref(), &a.options()?)
        .map_err(|e| anyhow!("{e}"))?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&r)?)?;
    } else {
        let mut out = String::from("AVERAGED SIGHT\n");
        out.push_str(&methods::header(
            &session,
            a.ephemeris,
            &r.sights,
            a.dr,
            a.vessel,
        ));
        out.push('\n');
        out.push_str(&render(&r)?);
        report::emit(&out)?;
    }
    Ok(methods::exit_for(
        session.observations.len() - r.sights.len(),
        session.observations.len(),
    ))
}

pub fn render(r: &AveragedSight) -> Result<String> {
    let mut out = String::new();
    labelled(
        &r.body,
        &format!(
            "at {}: Ho {} ({:.6} deg)  sigma {:.2}'",
            text::utc(r.jd_utc),
            text::alt_inline(r.ho_deg),
            r.ho_deg,
            r.sigma_arcmin
        ),
        &mut out,
    );
    labelled(
        "",
        &format!(
            "{} of {} sight(s) used; outliers left out: {}",
            r.n_used,
            r.n_total,
            if r.outliers.is_empty() {
                "none".to_string()
            } else {
                r.outliers.join(", ")
            }
        ),
        &mut out,
    );
    labelled(
        "Slope",
        &format!(
            "{}'/min predicted at the DR ({}), curvature {}'/min^2",
            text::signed_fixed(r.predicted_slope_arcmin_per_min, 3),
            match r.predicted_slope_sigma_arcmin_per_min {
                Some(s) => format!("sigma {s:.3}'/min"),
                None => "sigma not stated: the DR's is not".to_string(),
            },
            text::signed_fixed(r.predicted_curvature_arcmin_per_min2, 4)
        ),
        &mut out,
    );
    if let Some(f) = &r.free_slope {
        labelled(
            "Free line",
            &format!(
                "slope {} +/- {:.3}'/min, Ho {:.6} deg sigma {:.2}', z {}: {}",
                text::signed_fixed(f.slope_arcmin_per_min, 3),
                f.slope_sigma_arcmin_per_min,
                f.ho_deg,
                f.sigma_arcmin,
                text::signed_fixed(f.z, 2),
                if f.consistent {
                    "consistent with the predicted slope"
                } else {
                    "INCONSISTENT with the predicted slope"
                }
            ),
            &mut out,
        );
    }
    labelled(
        "Fit",
        &format!(
            "chi2 {} on {} degree(s) of freedom",
            text::fixed(r.chi2, 4),
            r.dof
        ),
        &mut out,
    );

    out.push_str(&format!(
        "\nResiduals (minutes from {})\n",
        text::utc(r.jd_utc)
    ));
    methods::residual_table(&r.residuals, &mut out);

    out.push_str("\nThe averaged sight as a session observation (fully corrected, observed_ho):\n");
    out.push_str(&format!("  {}\n", serde_json::to_string(&r.observation)?));
    methods::warnings(&r.warnings, &mut out);
    methods::workings_note(&mut out);
    Ok(out)
}
