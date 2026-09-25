//! `skyfix predict`: what the sextant will read. OWNER: cli agent.
//!
//! `skyfix_core::sights::predict::predict_sextant` (docs/NAVIGATION_SKY.md section 3)
//! on the direction from the CLI's `auto` provider — the Sun, the Moon, Venus (at its
//! centre of light), Mars, Jupiter, Saturn and the stars, the same astronomy `reduce`
//! and `solve` use — so a prediction and a reduction cannot disagree: reducing the
//! predicted reading gives `Hc` back to 1e-9 degrees. `--format json` is the
//! `PredictedSight` (EXPLORER_API.md `predict_sextant`).

use anyhow::{Result, anyhow};
use skyfix_core::corrections::{SightBody, horizon_name, sight_body};
use skyfix_core::sights::predict::predict_sextant;
use skyfix_core::types::{HorizonMode, LatLon, Limb, PredictedSight};
use skyfix_ephemeris::AstroProvider;

use super::args::{Dut1Args, FormatArgs, LimbArg, PositionArgs, SightOpticsArgs, parse_instant};
use super::text;
use crate::commands::reduce::{step_header, step_row};
use crate::exit;
use crate::provider;
use crate::report;

#[derive(clap::Args, Debug)]
pub struct Args {
    #[command(flatten)]
    pub position: PositionArgs,
    /// The instant, RFC 3339 UTC with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant)]
    pub utc: f64,
    /// The body: the Sun, the Moon, Venus, Mars, Jupiter, Saturn or a navigational star
    /// (`skyfix catalog`).
    #[arg(long, value_name = "NAME")]
    pub body: String,
    /// Which edge of the Sun's or the Moon's disc is brought to the horizon.
    #[arg(long, value_enum, default_value_t = LimbArg::Center, value_name = "LIMB")]
    pub limb: LimbArg,
    #[command(flatten)]
    pub optics: SightOpticsArgs,
    #[command(flatten)]
    pub dut1: Dut1Args,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// The prediction the flags ask for, from the CLI's `auto` provider.
pub fn predict(a: &Args) -> Result<PredictedSight> {
    let name = skyfix_ephemeris::body::canonical(&a.body).ok_or_else(|| {
        anyhow!(
            "unknown body {:?}: expected the Sun, the Moon, Venus, Mars, Jupiter, Saturn or a \
             navigational star (skyfix catalog lists them)",
            a.body
        )
    })?;
    let astro = provider::auto_provider_with_dut1(a.dut1.at(a.utc));
    let direction = astro.geocentric(name, a.utc).map_err(|e| anyhow!("{e}"))?;
    predict_sextant(
        &a.optics.observer(a.position.lat, a.position.lon),
        &a.optics.instrument(),
        name,
        a.limb.into(),
        a.utc,
        direction,
        astro.name(),
    )
    .map_err(|e| anyhow!("{e}"))
}

pub fn run(a: &Args) -> Result<u8> {
    let p = predict(a)?;
    if a.format.is_json() {
        report::emit_line(&serde_json::to_string_pretty(&p)?)?;
    } else {
        report::emit(&render(&p, a))?;
    }
    Ok(exit::OK)
}

fn limb_words(l: Limb) -> &'static str {
    match l {
        Limb::Center => "centre",
        Limb::Lower => "lower limb",
        Limb::Upper => "upper limb",
    }
}

pub fn render(p: &PredictedSight, a: &Args) -> String {
    let pos = LatLon {
        lat_deg: a.position.lat,
        lon_deg: a.position.lon,
    };
    let mut out = String::from("PREDICTED SEXTANT READING\n");
    out.push_str(&format!("Body        {}, {}\n", p.body, limb_words(p.limb)));
    out.push_str(&format!(
        "Observer    {} ({})\n",
        report::format_position(pos),
        report::format_position_decimal(pos)
    ));
    out.push_str(&format!(
        "            height of eye {} m, {} hPa, {} C\n",
        a.optics.height_of_eye, a.optics.air.pressure, a.optics.air.temperature
    ));
    out.push_str(&format!(
        "Instrument  {} horizon, index correction {:+.1}' (added to the reading)\n",
        horizon_name(p.horizon),
        a.optics.ic
    ));
    out.push_str(&format!("Time        {}\n", text::utc(p.jd_utc)));
    out.push_str(&format!(
        "Direction   GHA {}, Dec {}, SD {:.2}', HP {:.2}' (from {})\n\n",
        text::dm360(p.gha_deg).trim_start(),
        text::dec_inline(p.dec_deg),
        p.semidiameter_arcmin,
        p.horizontal_parallax_arcmin,
        p.direction_source
    ));

    let reading = if p.horizon == HorizonMode::ArtificialReflected {
        "the sextant reading: set this on the arc (the DOUBLE angle, reflected artificial \
         horizon)"
    } else {
        "the sextant reading: set this on the arc"
    };
    out.push_str(&format!("Hs  {}   {reading}\n", text::alt(p.hs_deg)));
    out.push_str(&format!(
        "Zn  {}   the true bearing to look along\n",
        text::dm360(p.zn_deg)
    ));
    out.push_str(&format!(
        "Hc  {}   the computed altitude here; reducing Hs gives it back\n",
        text::alt(p.hc_deg)
    ));
    if sight_body(&p.body) == SightBody::Moon {
        out.push_str(&format!(
            "         including the Moon's Earth-shape term, {}' (CONVENTIONS 15.4)\n",
            text::signed_fixed(p.earth_shape_arcmin, 3)
        ));
    }
    out.push_str(&format!(
        "Ha  {}   the apparent altitude after the index correction and the horizon step\n",
        text::alt(p.ha_deg)
    ));

    out.push_str("\nCorrections, from the reading forward to Hc\n");
    out.push_str(&step_header());
    for step in &p.corrections.steps {
        out.push_str(&step_row(step));
    }
    out.push_str(&format!(
        "  Ho {:.6} deg = Hc {:.6} deg\n",
        p.corrections.ho_deg, p.hc_deg
    ));
    report::warning_block(&p.warnings, &mut out);
    out.push('\n');
    let mut note = String::from(
        "Hs and Hc are on the spherical Earth of CONVENTIONS section 1, like every reduction.",
    );
    if sight_body(&p.body) == SightBody::Moon {
        note = String::from(
            "Hc is the spherical Earth's computed altitude (CONVENTIONS section 3) plus the \
             Moon's Earth-shape term, the part of its parallax the sphere leaves out (up to \
             0.24'): Hs is what a perfect sextant reads on the real (WGS84) Earth at sea \
             level, and reducing it with the usual chain lands on this Hc \
             (docs/NAVIGATION_SKY.md section 3).",
        );
    }
    for line in report::wrap(&note, 88, "") {
        out.push_str(&line);
        out.push('\n');
    }
    out
}
