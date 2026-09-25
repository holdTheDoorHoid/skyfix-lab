//! The Earth's magnetic field and compass error: `variation`, `magnetic-grid` and
//! `compass-error`. OWNER: cli3 agent.
//!
//! Engines: `skyfix_geomag` (WMM2025, IGRF-14) and `skyfix_core::methods::compass`,
//! through the WASM adapter's `skyfix_wasm::geomag` (`magnetic_field_impl`,
//! `magnetic_grid_impl`, `compass_error_impl`); wire format EXPLORER_API.md "Expansion
//! programme — magnetic field and compass error"; definitions CONVENTIONS 14.1-14.2. A
//! date no model covers is an answer, not an error: `variation` prints the reason and
//! exits 0, as the export returns `{available: false, reason}`.

use anyhow::{Result, anyhow};
use serde_json::json;
use skyfix_core::methods::compass::{
    AmplitudeHorizon, CompassErrorResult, CompassKind, CompassMethod, CompassObserver,
    CompassRequest, RiseSet,
};
use skyfix_wasm::geomag::{self as wasm_geomag, MagneticFieldWire};

use super::args::{Dut1Args, FormatArgs, LimbArg, parse_instant};
use super::text;
use super::wire::{
    Align, SiteArgs, Table, call, emit_json, f64s, observer_line, push_field, push_note,
    set_explorer_dut1,
};
use crate::exit;
use crate::report;

/// `--model` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum ModelArg {
    /// WMM2025 from 2025.0 to 2030.0, IGRF-14 from 1900.0 up to 2025.0.
    #[default]
    Auto,
    /// The World Magnetic Model 2025 (2025.0 to 2030.0).
    Wmm2025,
    /// The International Geomagnetic Reference Field, 14th generation (1900.0 to 2030.0).
    Igrf14,
}

impl ModelArg {
    fn wire(self) -> &'static str {
        match self {
            ModelArg::Auto => "auto",
            ModelArg::Wmm2025 => "wmm2025",
            ModelArg::Igrf14 => "igrf14",
        }
    }
}

// ---------------------------------------------------------------------------
// variation
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct VariationArgs {
    #[command(flatten)]
    pub site: SiteArgs,
    /// The instant, RFC 3339 with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
    /// Which model: `auto` (default), `wmm2025` or `igrf14`.
    #[arg(long, value_enum, default_value_t = ModelArg::Auto, value_name = "MODEL")]
    pub model: ModelArg,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_variation(a: &VariationArgs) -> Result<u8> {
    let r = call(wasm_geomag::magnetic_field_impl(
        a.site.position.lat,
        a.site.position.lon,
        a.site.height,
        a.utc,
        Some(a.model.wire()),
    ))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_variation(&r, a))?;
    }
    Ok(exit::OK)
}

fn render_variation(r: &MagneticFieldWire, a: &VariationArgs) -> String {
    let mut out = format!(
        "MAGNETIC VARIATION\nPlace      {}\nTime       {}\n",
        observer_line(&a.site.site()),
        text::utc(a.utc)
    );
    let f = match r {
        MagneticFieldWire::Unavailable(u) => {
            out.push_str(&format!("Year       {:.4}\n\n", u.decimal_year));
            push_note(&mut out, &format!("No variation: {}", u.reason));
            return out;
        }
        MagneticFieldWire::Available(f) => f,
    };
    let field = &f.field;
    out.push_str(&format!(
        "Model      {}, decimal year {:.4}{}\n\n",
        field.model.label(),
        field.decimal_year,
        if field.forecast {
            ", a forecast (after 2025.0)"
        } else {
            ""
        }
    ));
    push_note(&mut out, &f.sentence);
    out.push('\n');
    let c = &field.annual_change;
    let u = &field.uncertainty;
    let mut t = Table::new(&[
        ("element", Align::Left),
        ("value", Align::Right),
        ("sigma", Align::Right),
        ("change a year", Align::Right),
    ]);
    let deg = |v: f64| format!("{v:.4} deg");
    let nt = |v: f64| format!("{v:.1} nT");
    t.row(vec![
        "declination (variation)".into(),
        deg(field.declination_deg),
        format!("{:.3} deg", u.declination_deg),
        format!("{:+.4} deg", c.declination_deg_per_year),
    ]);
    t.row(vec![
        "inclination (dip)".into(),
        deg(field.inclination_deg),
        format!("{:.3} deg", u.inclination_deg),
        format!("{:+.4} deg", c.inclination_deg_per_year),
    ]);
    for (name, v, s, d) in [
        (
            "horizontal H",
            field.horizontal_nt,
            u.horizontal_nt,
            c.horizontal_nt_per_year,
        ),
        ("north X", field.north_nt, u.north_nt, c.north_nt_per_year),
        ("east Y", field.east_nt, u.east_nt, c.east_nt_per_year),
        ("down Z", field.down_nt, u.down_nt, c.down_nt_per_year),
        ("total F", field.total_nt, u.total_nt, c.total_nt_per_year),
    ] {
        t.row(vec![
            name.into(),
            nt(v),
            format!("{s:.0} nT"),
            format!("{d:+.1} nT"),
        ]);
    }
    out.push_str(&t.render("  "));
    out.push_str(&format!(
        "\nZone       {}\n",
        match field.zone {
            skyfix_geomag::Zone::Normal => "normal",
            skyfix_geomag::Zone::Caution =>
                "caution: H under 6000 nT, compass accuracy may be degraded",
            skyfix_geomag::Zone::Blackout =>
                "blackout: H under 2000 nT, the compass is unreliable and the variation can be wrong by tens of degrees",
        }
    ));
    for n in &field.notes {
        push_note(&mut out, n);
    }
    out.push('\n');
    push_note(
        &mut out,
        &format!(
            "Declination (the navigator's variation) is east positive: {} is {}. \
             Inclination is down positive. sigma: {}",
            text::fixed(field.declination_deg, 4),
            f.variation_text,
            u.basis
        ),
    );
    out
}

// ---------------------------------------------------------------------------
// magnetic-grid
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct GridArgs {
    /// The instant, RFC 3339 with a trailing Z.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
    /// Southernmost and northernmost latitude, degrees: -60,60.
    #[arg(long = "lat-range", value_name = "MIN,MAX", value_parser = parse_range, allow_hyphen_values = true)]
    pub lat_range: (f64, f64),
    /// Westernmost and easternmost longitude, degrees east: -100,-60.
    #[arg(long = "lon-range", value_name = "MIN,MAX", value_parser = parse_range, allow_hyphen_values = true)]
    pub lon_range: (f64, f64),
    /// Rows of latitude, both ends included.
    #[arg(long, value_name = "N")]
    pub rows: u32,
    /// Columns of longitude, both ends included.
    #[arg(long, value_name = "N")]
    pub cols: u32,
    /// Height above the WGS84 ellipsoid, metres. Default 0.
    #[arg(
        long,
        value_name = "M",
        default_value_t = 0.0,
        allow_negative_numbers = true
    )]
    pub height: f64,
    #[command(flatten)]
    pub format: FormatArgs,
}

/// `MIN,MAX`, two numbers.
pub fn parse_range(s: &str) -> Result<(f64, f64), String> {
    let parts: Vec<&str> = s.split(',').map(str::trim).collect();
    let n = |p: &str| -> Result<f64, String> {
        p.parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())
            .ok_or_else(|| format!("{p:?} is not a number"))
    };
    match parts.as_slice() {
        [a, b] => Ok((n(a)?, n(b)?)),
        _ => Err(format!("expected MIN,MAX (two numbers), got {s:?}")),
    }
}

pub fn run_grid(a: &GridArgs) -> Result<u8> {
    let g = call(wasm_geomag::magnetic_grid_impl(
        a.utc,
        a.lat_range.0,
        a.lat_range.1,
        a.rows,
        a.lon_range.0,
        a.lon_range.1,
        a.cols,
        a.height,
    ))?;
    if a.format.is_json() {
        // The export's object, its Float64Arrays as arrays; `null` when no model covers
        // the date.
        let v = match &g {
            Some(g) => json!({
                "model": g.model,
                "decimal_year": g.decimal_year,
                "lat_deg": f64s(&g.lat_deg),
                "lon_deg": f64s(&g.lon_deg),
                "declination_deg": f64s(&g.declination_deg),
                "horizontal_nt": f64s(&g.horizontal_nt),
            }),
            None => serde_json::Value::Null,
        };
        emit_json(&v)?;
        return Ok(exit::OK);
    }
    let Some(g) = g else {
        report::emit(&format!(
            "MAGNETIC GRID\nTime       {}\n\nNo model covers this date (WMM2025 and IGRF-14 \
             together cover 1900.0 to 2030.0).\n",
            text::utc(a.utc)
        ))?;
        return Ok(exit::OK);
    };
    let mut out = format!(
        "MAGNETIC GRID\nTime       {} (decimal year {:.4}), {}\nGrid       {} rows x {} columns, \
         {} m above the ellipsoid\n\n",
        text::utc(a.utc),
        g.decimal_year,
        g.model,
        g.lat_deg.len(),
        g.lon_deg.len(),
        a.height
    );
    let mut t = Table::new(&[
        ("lat", Align::Right),
        ("lon", Align::Right),
        ("declination", Align::Right),
        ("H nT", Align::Right),
        ("zone", Align::Left),
    ]);
    for (i, lat) in g.lat_deg.iter().enumerate() {
        for (j, lon) in g.lon_deg.iter().enumerate() {
            let k = i * g.lon_deg.len() + j;
            let h = g.horizontal_nt[k];
            t.row(vec![
                text::fixed(*lat, 4),
                text::fixed(*lon, 4),
                format!("{:.3}", g.declination_deg[k]),
                format!("{h:.0}"),
                if h < 2000.0 {
                    "blackout"
                } else if h < 6000.0 {
                    "caution"
                } else {
                    ""
                }
                .to_string(),
            ]);
        }
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        "Declination (variation) in degrees, east positive; H the horizontal intensity. Row by \
         row from the southern edge, west to east, as --format json lays the arrays out.",
    );
    report::emit(&out)?;
    Ok(exit::OK)
}

// ---------------------------------------------------------------------------
// compass-error
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum MethodArg {
    /// The body's azimuth at the instant of the bearing.
    #[default]
    Azimuth,
    /// The body's bearing as it rises or sets.
    Amplitude,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum CompassArg {
    /// A magnetic compass: the error splits into variation and deviation.
    #[default]
    Magnetic,
    /// A gyrocompass: the whole error is gyro error.
    Gyro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum AmplitudeHorizonArg {
    /// The limb (or centre, --limb) on the sea horizon, as it is seen.
    #[default]
    Visible,
    /// The centre at geocentric altitude 0.
    Celestial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum RiseSetArg {
    Rising,
    Setting,
}

#[derive(clap::Args, Debug)]
pub struct CompassArgs {
    #[command(flatten)]
    pub site: SiteArgs,
    /// When the bearing was taken, RFC 3339 with a trailing Z. For an amplitude, roughly:
    /// the crossing nearest it within 12 hours is used.
    #[arg(long, value_name = "RFC3339", value_parser = parse_instant, allow_hyphen_values = true)]
    pub utc: f64,
    /// The body: the Sun, the Moon, Venus, Mars, Jupiter, Saturn or a navigational star.
    #[arg(long, value_name = "NAME")]
    pub body: String,
    /// What the compass read, degrees (0 to 360).
    #[arg(long, value_name = "DEG")]
    pub bearing: f64,
    /// By the azimuth at an instant, or by the amplitude at rising or setting.
    #[arg(long, value_enum, default_value_t = MethodArg::Azimuth, value_name = "METHOD")]
    pub method: MethodArg,
    /// The compass: magnetic (default) or gyro.
    #[arg(long, value_enum, default_value_t = CompassArg::Magnetic, value_name = "KIND")]
    pub compass: CompassArg,
    /// The chart's variation, degrees east positive (11.5 W is -11.5). Default: the
    /// magnetic model's at the place and the instant.
    #[arg(long, value_name = "DEG", allow_negative_numbers = true)]
    pub variation: Option<f64>,
    /// The 1-sigma of --variation, degrees.
    #[arg(long = "variation-sigma", value_name = "DEG", requires = "variation")]
    pub variation_sigma: Option<f64>,
    /// Which model fills a missing variation: auto (default), wmm2025 or igrf14.
    #[arg(long, value_enum, default_value_t = ModelArg::Auto, value_name = "MODEL", conflicts_with = "variation")]
    pub model: ModelArg,
    /// The 1-sigma of the compass reading, degrees, when you can state it.
    #[arg(long = "bearing-sigma", value_name = "DEG")]
    pub bearing_sigma: Option<f64>,
    /// Amplitude: the horizon the body was on.
    #[arg(long, value_enum, value_name = "HORIZON")]
    pub horizon: Option<AmplitudeHorizonArg>,
    /// Amplitude on the visible horizon: height of eye above the sea, metres (the dip).
    #[arg(long = "height-of-eye", value_name = "M")]
    pub height_of_eye: Option<f64>,
    /// Amplitude on the visible horizon: which part of the disc touched it.
    #[arg(long, value_enum, value_name = "LIMB")]
    pub limb: Option<LimbArg>,
    /// Amplitude: rising or setting. Default: from the body's side of the meridian.
    #[arg(long, value_enum, value_name = "EVENT")]
    pub event: Option<RiseSetArg>,
    /// Amplitude on the visible horizon: air pressure, hPa, for refraction. Default 1010.
    #[arg(long, value_name = "HPA")]
    pub pressure: Option<f64>,
    /// Amplitude on the visible horizon: air temperature, C. Default 10.
    #[arg(long, value_name = "C", allow_negative_numbers = true)]
    pub temperature: Option<f64>,
    #[command(flatten)]
    pub dut1: Dut1Args,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn compass_request(a: &CompassArgs) -> Result<CompassRequest> {
    let amplitude_only = a.horizon.is_some()
        || a.height_of_eye.is_some()
        || a.limb.is_some()
        || a.event.is_some()
        || a.pressure.is_some()
        || a.temperature.is_some();
    if a.method == MethodArg::Azimuth && amplitude_only {
        return Err(anyhow!(
            "--horizon, --height-of-eye, --limb, --event, --pressure and --temperature belong \
             to --method amplitude; a bearing by azimuth uses none of them"
        ));
    }
    Ok(CompassRequest {
        method: match a.method {
            MethodArg::Azimuth => CompassMethod::Azimuth,
            MethodArg::Amplitude => CompassMethod::Amplitude,
        },
        body: a.body.clone(),
        utc: None,
        jd_utc: Some(a.utc),
        observer: CompassObserver {
            lat_deg: a.site.position.lat,
            lon_deg: a.site.position.lon,
            height_m: a.site.height,
        },
        compass_bearing_deg: a.bearing,
        compass: match a.compass {
            CompassArg::Magnetic => CompassKind::Magnetic,
            CompassArg::Gyro => CompassKind::Gyro,
        },
        variation_deg: a.variation,
        variation_sigma_deg: a.variation_sigma,
        bearing_sigma_deg: a.bearing_sigma,
        horizon: match a.horizon.unwrap_or_default() {
            AmplitudeHorizonArg::Visible => AmplitudeHorizon::Visible,
            AmplitudeHorizonArg::Celestial => AmplitudeHorizon::Celestial,
        },
        height_of_eye_m: a.height_of_eye.unwrap_or(0.0),
        limb: a.limb.unwrap_or_default().into(),
        pressure_hpa: a.pressure.unwrap_or(1010.0),
        temperature_c: a.temperature.unwrap_or(10.0),
        event: a.event.map(|e| match e {
            RiseSetArg::Rising => RiseSet::Rising,
            RiseSetArg::Setting => RiseSet::Setting,
        }),
        magnetic_model: (a.variation.is_none() && a.model != ModelArg::Auto)
            .then(|| a.model.wire().to_string()),
    })
}

pub fn run_compass(a: &CompassArgs) -> Result<u8> {
    let req = compass_request(a)?;
    set_explorer_dut1(a.dut1.dut1)?;
    let r = call(wasm_geomag::compass_error_impl(&serde_json::to_string(
        &req,
    )?))?;
    if a.format.is_json() {
        emit_json(&r)?;
    } else {
        report::emit(&render_compass(&r, a))?;
    }
    Ok(exit::OK)
}

fn render_compass(r: &CompassErrorResult, a: &CompassArgs) -> String {
    let mut out = format!(
        "COMPASS ERROR BY {}\nObserver   {}\nTime       {}\n\n",
        match r.method {
            CompassMethod::Azimuth => "AZIMUTH",
            CompassMethod::Amplitude => "AMPLITUDE",
        },
        observer_line(&a.site.site()),
        text::utc(r.jd_utc)
    );
    push_note(&mut out, &r.sentence);
    push_note(&mut out, &r.explanation);
    out.push('\n');
    let mut t = Table::new(&[
        ("", Align::Left),
        ("deg", Align::Right),
        ("sigma", Align::Right),
        ("", Align::Left),
    ]);
    let sig = |s: Option<f64>| s.map_or_else(|| "-".to_string(), |v| format!("{v:.3}"));
    t.row(vec![
        "true bearing".into(),
        format!("{:.3}", r.true_bearing_deg),
        "-".into(),
        format!("from {}", r.direction_source),
    ]);
    t.row(vec![
        "compass bearing".into(),
        format!("{:.3}", r.compass_bearing_deg),
        sig(a.bearing_sigma),
        "as read".into(),
    ]);
    t.row(vec![
        match r.compass {
            CompassKind::Magnetic => "compass error",
            CompassKind::Gyro => "gyro error",
        }
        .into(),
        format!("{:+.3}", r.compass_error_deg),
        sig(r.compass_error_sigma_deg),
        r.compass_error_text.clone(),
    ]);
    if let Some(v) = &r.variation {
        t.row(vec![
            "variation".into(),
            format!("{:+.3}", v.deg),
            sig(v.sigma_deg),
            format!("{} ({})", v.text, v.source),
        ]);
    }
    if let Some(d) = r.deviation_deg {
        t.row(vec![
            "deviation".into(),
            format!("{d:+.3}"),
            sig(r.deviation_sigma_deg),
            r.deviation_text.clone().unwrap_or_default(),
        ]);
    }
    out.push_str(&t.render("  "));
    if let Some(z) = &r.azimuth {
        out.push('\n');
        push_field(
            &mut out,
            "Azimuth",
            &format!(
                "GHA {}, Dec {}, altitude {}, Zn on the sphere {}, changing {:+.3} deg/min",
                text::dm360(z.gha_deg).trim_start(),
                text::dec_inline(z.dec_deg),
                text::alt_inline(z.altitude_deg),
                text::dm360(z.zn_spherical_deg).trim_start(),
                z.azimuth_rate_deg_per_min
            ),
        );
    }
    if let Some(m) = &r.amplitude {
        out.push('\n');
        push_field(
            &mut out,
            "Amplitude",
            &format!(
                "{} on the {} horizon: {}; Dec {}; celestial bearing {}; visible minus celestial \
             bearing {:+.3} deg (dip {:.1}', refraction {:.1}', SD {:.1}', HP {:.1}'); \
             {:+.1} min from the time given",
                match m.event {
                    RiseSet::Rising => "rising",
                    RiseSet::Setting => "setting",
                },
                match m.horizon {
                    AmplitudeHorizon::Visible => "visible",
                    AmplitudeHorizon::Celestial => "celestial",
                },
                m.amplitude_text.as_deref().unwrap_or("none"),
                text::dec_inline(m.dec_deg),
                m.celestial_bearing_deg
                    .map_or_else(|| "-".to_string(), |b| format!("{b:.3} deg")),
                m.visible_horizon_correction_deg,
                m.dip_arcmin,
                m.refraction_arcmin,
                m.semidiameter_arcmin,
                m.parallax_arcmin,
                m.minutes_from_given_time
            ),
        );
    }
    if !r.notes.is_empty() {
        out.push('\n');
        for n in &r.notes {
            push_note(&mut out, n);
        }
    }
    out.push('\n');
    push_note(
        &mut out,
        "Errors are true minus compass, east positive: compass least, error east \
         (CONVENTIONS 14.2). Deviation is compass error minus variation.",
    );
    out
}
