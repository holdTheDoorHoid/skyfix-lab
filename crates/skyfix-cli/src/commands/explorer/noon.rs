//! `skyfix noon`: latitude at meridian passage, the time of passage and a (weak)
//! longitude, from a run of sights of one body. OWNER: cli agent.
//!
//! `skyfix_core::methods::noon::noon_sight`, which `docs/NAVIGATION_METHODS.md` section 2
//! describes; `--format json` is its `NoonSightResult` (EXPLORER_API.md `noon_sight`).
//! Every flag below is a field of `NoonSightOptions`.

use std::path::PathBuf;

use anyhow::{Result, anyhow};
use skyfix_core::methods::noon;
use skyfix_core::types::{
    BodyBearing, DrPosition, MeridianSide, NoonCurvature, NoonMethod, NoonSightOptions,
    NoonSightResult, SingleAltitudeMode, VesselMotion,
};

use super::args::{Dut1Args, FormatArgs, parse_dr, parse_vessel};
use super::methods::{self, labelled, latitude_line};
use super::text;
use crate::provider::EphemerisChoice;
use crate::report;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum BearingArg {
    /// Decide from the DR latitude and the declination.
    #[default]
    Auto,
    /// The body was north of the zenith at meridian passage (you faced north).
    North,
    /// The body was south of the zenith at meridian passage (you faced south).
    South,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum CurvatureArg {
    /// The exact altitude curve from the geometry (the default).
    #[default]
    Predicted,
    /// A free parabola fitted to the sights (three or more).
    Fitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum SingleArg {
    /// The one altitude is the recorded peak, the meridian altitude (the default).
    #[default]
    Maximum,
    /// The one altitude was taken at its recorded time near noon: reduce it to the
    /// meridian with the DR longitude.
    ExMeridian,
}

#[derive(clap::Args, Debug)]
pub struct Args {
    /// Session file (.json or .csv): a run of sights of ONE body around its meridian
    /// passage, or a single altitude.
    pub session: PathBuf,
    /// DR position LAT,LON[,SIGMA_NM], degrees, east-positive longitude; SIGMA_NM is its
    /// 1-sigma error north and east. Default: the session's assumed position (and its
    /// prior sigma when its role is prior). Required one way or the other.
    #[arg(long, value_name = "LAT,LON[,SIGMA_NM]", value_parser = parse_dr, allow_hyphen_values = true)]
    pub dr: Option<DrPosition>,
    /// Course and speed over the ground during the run: COURSE_DEG,SPEED_KN.
    #[arg(long, value_name = "COURSE,SPEED", value_parser = parse_vessel)]
    pub vessel: Option<VesselMotion>,
    /// Which side of the zenith the body crossed the meridian.
    #[arg(long = "body-bearing", value_enum, default_value_t = BearingArg::Auto, value_name = "SIDE")]
    pub body_bearing: BearingArg,
    /// How the curve's curvature is obtained.
    #[arg(long, value_enum, default_value_t = CurvatureArg::Predicted, value_name = "HOW")]
    pub curvature: CurvatureArg,
    /// What a single altitude means.
    #[arg(long = "single-altitude", value_enum, default_value_t = SingleArg::Maximum, value_name = "MODE")]
    pub single_altitude: SingleArg,
    /// Where body directions come from when an observation has no geocentric block.
    #[arg(long, value_enum, default_value_t = EphemerisChoice::Auto, value_name = "MODE")]
    pub ephemeris: EphemerisChoice,
    #[command(flatten)]
    pub dut1: Dut1Args,
    #[command(flatten)]
    pub format: FormatArgs,
}

impl Args {
    pub fn options(&self) -> NoonSightOptions {
        NoonSightOptions {
            dr: self.dr,
            vessel: self.vessel,
            body_bearing: match self.body_bearing {
                BearingArg::Auto => BodyBearing::Auto,
                BearingArg::North => BodyBearing::North,
                BearingArg::South => BodyBearing::South,
            },
            curvature: match self.curvature {
                CurvatureArg::Predicted => NoonCurvature::Predicted,
                CurvatureArg::Fitted => NoonCurvature::Fitted,
            },
            single_altitude: match self.single_altitude {
                SingleArg::Maximum => SingleAltitudeMode::Maximum,
                SingleArg::ExMeridian => SingleAltitudeMode::ExMeridian,
            },
        }
    }
}

pub fn run(a: &Args) -> Result<u8> {
    let mut session = methods::load(&a.session)?;
    a.dut1.apply(&mut session);
    let source = methods::source(a.ephemeris, &session);
    let r =
        noon::noon_sight(&session, source.as_ref(), &a.options()).map_err(|e| anyhow!("{e}"))?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&r)?)?;
    } else {
        let mut out = String::from("NOON SIGHT\n");
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
    Ok(methods::exit_for(
        session.observations.len() - r.sights.len(),
        session.observations.len(),
    ))
}

pub fn method_words(m: NoonMethod) -> &'static str {
    match m {
        NoonMethod::CurveFit => "curve fit, curvature predicted",
        NoonMethod::CurveFitFreeCurvature => "curve fit, free curvature",
        NoonMethod::ExMeridian => "ex-meridian, reduced to the meridian on the DR longitude",
        NoonMethod::MaximumAltitude => "one altitude, taken as the peak",
    }
}

pub fn render(r: &NoonSightResult) -> String {
    let mut out = String::new();
    let headline = format!(
        "{}, {} sight(s): {}; the {} crossed the meridian {} of the zenith",
        r.body,
        r.n_sights,
        method_words(r.method),
        r.body,
        match r.side {
            MeridianSide::North => "NORTH",
            MeridianSide::South => "SOUTH",
        }
    );
    for line in report::wrap(&headline, 88, "") {
        out.push_str(&line);
        out.push('\n');
    }
    out.push('\n');
    labelled(
        "Latitude",
        &latitude_line(r.latitude.lat_deg, r.latitude.sigma_arcmin),
        &mut out,
    );
    for line in report::wrap(&r.latitude_rule, 78, "           ") {
        out.push_str(&line);
        out.push('\n');
    }
    labelled(
        "Meridian",
        &format!(
            "altitude {} (Ho of the centre at passage), declination {}, zenith distance {}",
            text::alt_inline(r.meridian_altitude_deg),
            text::dec_inline(r.declination_deg),
            text::dm360(r.zenith_distance_deg).trim_start()
        ),
        &mut out,
    );
    if let Some(sens) = r.longitude_sensitivity_arcmin_per_nm {
        labelled(
            "",
            &format!(
                "the latitude moves {}' per NM of east-west error in the DR",
                text::signed_fixed(sens, 3)
            ),
            &mut out,
        );
    }
    match &r.meridian_passage {
        Some(t) => labelled(
            "Passage",
            &format!("{}  sigma {:.1} s", text::utc(t.jd_utc), t.sigma_s),
            &mut out,
        ),
        None => labelled("Passage", "not timed by this method", &mut out),
    }
    match &r.longitude {
        Some(l) => labelled(
            "Longitude",
            &format!(
                "{} ({:.6})  sigma {:.2}' of longitude, {:.2} NM east-west (of which the \
                 clock {:.2}')",
                report::format_lon(l.lon_deg),
                l.lon_deg,
                l.sigma_arcmin,
                l.sigma_nm,
                l.clock_sigma_arcmin
            ),
            &mut out,
        ),
        None => labelled("Longitude", "none", &mut out),
    }
    for line in report::wrap(&r.longitude_caveat, 78, "           ") {
        out.push_str(&line);
        out.push('\n');
    }
    if let Some(m) = &r.maximum {
        labelled(
            "Peak",
            &format!(
                "{} at {}, {:.1} s {} passage",
                text::utc(m.jd_utc),
                text::alt_inline(m.altitude_deg),
                m.seconds_after_passage.abs(),
                if m.seconds_after_passage < 0.0 {
                    "before"
                } else {
                    "after"
                }
            ),
            &mut out,
        );
    }
    let c = &r.curvature;
    let fitted = match (
        c.fitted_arcmin_per_min2,
        c.fitted_sigma_arcmin_per_min2,
        c.z,
    ) {
        (Some(f), Some(s), Some(z)) => format!(
            ", fitted {f:.4} +/- {s:.4} (z {}, {})",
            text::signed_fixed(z, 1),
            if c.consistent == Some(true) {
                "consistent"
            } else {
                "INCONSISTENT"
            }
        ),
        _ => String::new(),
    };
    labelled(
        "Curve",
        &format!(
            "curvature {:.4}'/min^2 predicted{fitted}; the meridian altitude itself changes \
             {}'/min, putting the peak {}' above it",
            c.predicted_arcmin_per_min2,
            text::signed_fixed(c.rate_at_passage_arcmin_per_min, 4),
            text::fixed(c.max_minus_meridian_arcmin, 4)
        ),
        &mut out,
    );
    let d = &r.dr_check;
    labelled(
        "DR check",
        &format!(
            "the DR predicts passage at {}{}; answer minus DR: latitude {}'{}",
            text::utc(d.predicted_passage_jd_utc),
            match d.predicted_passage_sigma_s {
                Some(s) => format!(" (sigma {s:.0} s)"),
                None => " (sigma not stated)".to_string(),
            },
            text::signed_fixed(d.latitude_difference_arcmin, 2),
            match d.longitude_difference_arcmin {
                Some(l) => format!(", longitude {}'", text::signed_fixed(l, 2)),
                None => String::new(),
            }
        ),
        &mut out,
    );
    labelled(
        "Fit",
        &format!(
            "chi2 {} on {} degree(s) of freedom",
            text::fixed(r.chi2, 4),
            r.dof
        ),
        &mut out,
    );
    if let Some(alt) = &r.alternative {
        let mut s = format!(
            "{}: latitude {}",
            method_words(alt.method),
            latitude_line(alt.latitude.lat_deg, alt.latitude.sigma_arcmin)
        );
        if let Some(t) = &alt.meridian_passage {
            s.push_str(&format!(
                ", passage {} sigma {:.1} s",
                text::utc(t.jd_utc),
                t.sigma_s
            ));
        }
        if let Some(l) = &alt.longitude {
            s.push_str(&format!(
                ", longitude {} sigma {:.2}'",
                report::format_lon(l.lon_deg),
                l.sigma_arcmin
            ));
        }
        labelled("Other", &s, &mut out);
    }

    out.push_str("\nResiduals (minutes from meridian passage)\n");
    methods::residual_table(&r.residuals, &mut out);
    methods::warnings(&r.warnings, &mut out);
    methods::workings_note(&mut out);
    out
}
