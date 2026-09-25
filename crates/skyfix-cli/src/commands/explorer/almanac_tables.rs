//! The almanac's other tables and its three-day openings: `almanac-opening`,
//! `almanac-increments`, `almanac-arc-to-time`, `almanac-altitude`, `almanac-planets`
//! and `almanac-polaris`. OWNER: cli3 agent.
//!
//! Engines: `skyfix_almanac::{opening, tables}` through the WASM adapter's
//! `skyfix_wasm::almanac_tables::native`; wire format EXPLORER_API.md "Expansion
//! programme — almanac tables and three-day pages"; definitions CONVENTIONS 13.9.1.
//! Display and teaching only: sight reduction never reads these tables. The text prints
//! each table's `printed` values, rounded as the printed Nautical Almanac rounds; the JSON
//! carries the numbers beside them.

use anyhow::Result;
use skyfix_almanac::tables::{
    AltitudeTables, ArcToTime, CriticalTable, IncrementsMinute, PlanetCorrections, PolarisTable,
};
use skyfix_core::calendar::Calendar;
use skyfix_wasm::almanac_tables::native;

use super::args::{FormatArgs, calendar_choice, parse_date};
use super::sun::YearFlag;
use super::wire::{Align, Table, call, emit_json, push_note};
use crate::exit;
use crate::report;

/// `--calendar` as the exports take it: `""` for the display rule.
fn calendar_arg() -> &'static str {
    match calendar_choice() {
        Some(Calendar::Julian) => "julian",
        Some(Calendar::Gregorian) => "gregorian",
        None => "",
    }
}

fn notes(out: &mut String, how_to_use: &str, example: Option<&str>, notes: &[String]) {
    out.push('\n');
    push_note(out, &format!("How to use: {how_to_use}"));
    if let Some(e) = example {
        push_note(out, &format!("Example: {e}"));
    }
    for n in notes {
        push_note(out, n);
    }
}

/// A critical table as rows: the argument's interval and the value(s) that hold in it.
fn critical(t: &CriticalTable) -> String {
    let mut cols = vec![(t.argument.as_str(), Align::Left)];
    for c in &t.columns {
        cols.push((c.as_str(), Align::Right));
    }
    let mut table = Table::new(&cols);
    for (k, values) in t.values.iter().enumerate() {
        let mut row = vec![format!(
            "{} to {}",
            t.boundaries[k].printed,
            t.boundaries[k + 1].printed
        )];
        row.extend(values.iter().map(|v| v.printed.clone()));
        table.row(row);
    }
    table.render("  ")
}

// ---------------------------------------------------------------------------
// almanac-opening
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct OpeningArgs {
    /// A UT date of the opening, YYYY-MM-DD (any year: -0584-05-28), in the calendar of
    /// --calendar (Julian before 1582-10-15 by default); the opening groups its three
    /// dates from 1 January in that calendar.
    #[arg(long, value_name = "YYYY-MM-DD", value_parser = parse_date, allow_hyphen_values = true)]
    pub date: super::args::Date,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_opening(a: &OpeningArgs) -> Result<u8> {
    // The export takes the wire's proleptic Gregorian date.
    let wire = skyfix_core::calendar::CivilDateTime::from_jd(a.date.jd0(), Calendar::Gregorian)
        .map(|c| c.date_string())
        .unwrap_or_default();
    let o = call(native::opening(&wire, calendar_arg()))?;
    if a.format.is_json() {
        emit_json(&o)?;
        return Ok(exit::OK);
    }
    let mut out = format!("THE NAUTICAL ALMANAC'S OPENING  {}\n", o.date);
    super::wire::push_field(
        &mut out,
        "Dates",
        &format!(
            "{} ({} calendar)",
            o.dates
                .iter()
                .map(|d| format!("{} {}", d.date, d.weekday))
                .collect::<Vec<_>>()
                .join(", "),
            match o.calendar {
                Calendar::Julian => "Julian",
                Calendar::Gregorian => "Gregorian",
            }
        ),
    );
    for day in &o.days {
        out.push('\n');
        out.push_str(&crate::commands::almanac::render(day));
    }
    out.push_str(&format!(
        "\nMOONRISE AND MOONSET  {} to {}, by day of the month\n",
        o.moon_dates.first().map_or("", String::as_str),
        o.moon_dates.last().map_or("", String::as_str)
    ));
    let mut cols = vec![("Lat", Align::Left)];
    let labels: Vec<String> = o
        .moon_dates
        .iter()
        .flat_map(|d| {
            let dd = &d[d.len().saturating_sub(2)..];
            [format!("rise {dd}"), format!("set {dd}")]
        })
        .collect();
    for l in &labels {
        cols.push((l.as_str(), Align::Right));
    }
    let mut t = Table::new(&cols);
    for r in &o.moon_rows {
        let mut row = vec![r.label.clone()];
        for (rise, set) in r.moonrise.iter().zip(&r.moonset) {
            row.push(rise.printed.clone());
            row.push(set.printed.clone());
        }
        t.row(row);
    }
    out.push_str(&t.render("  "));
    out.push_str("\nPlanets' SHA at 00h of the middle date\n");
    for p in &o.planet_sha_00h {
        out.push_str(&format!("  {:<8} {}\n", p.body, p.printed.gha));
    }
    for e in &o.errors {
        out.push_str(&format!("  not computed: {}: {}\n", e.body, e.message));
    }
    out.push('\n');
    // The daily pages printed their own notes; add the opening's.
    for n in o
        .notes
        .iter()
        .filter(|n| !o.days.iter().any(|d| d.notes.contains(n)))
    {
        push_note(&mut out, n);
    }
    report::emit(&out)?;
    Ok(exit::OK)
}

// ---------------------------------------------------------------------------
// almanac-increments
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct IncrementsArgs {
    /// The minute of time, 0 to 59.
    #[arg(long, value_name = "M")]
    pub minute: u32,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_increments(a: &IncrementsArgs) -> Result<u8> {
    let t = call(native::increments_minute(a.minute))?;
    if a.format.is_json() {
        emit_json(&t)?;
    } else {
        report::emit(&render_increments(&t))?;
    }
    Ok(exit::OK)
}

fn render_increments(t: &IncrementsMinute) -> String {
    let mut out = format!("INCREMENTS AND CORRECTIONS  {}m\n\n", t.minute);
    let mut table = Table::new(&[
        ("s", Align::Right),
        ("Sun and planets", Align::Right),
        ("Aries", Align::Right),
        ("Moon", Align::Right),
    ]);
    for r in &t.rows {
        table.row(vec![
            format!("{:02}", r.second),
            r.sun_planets.printed.clone(),
            r.aries.printed.clone(),
            r.moon.printed.clone(),
        ]);
    }
    out.push_str(&table.render("  "));
    out.push_str("\nv or d corrections\n");
    // Three side-by-side columns, as the page prints them.
    let rows = t.corrections.len().div_ceil(3);
    let mut table = Table::new(&[
        ("v or d", Align::Right),
        ("corr", Align::Right),
        ("v or d", Align::Right),
        ("corr", Align::Right),
        ("v or d", Align::Right),
        ("corr", Align::Right),
    ]);
    for i in 0..rows {
        let mut row = Vec::new();
        for k in 0..3 {
            match t.corrections.get(i + k * rows) {
                Some(c) => {
                    row.push(c.v_printed.clone());
                    row.push(c.correction.printed.clone());
                }
                None => row.extend([String::new(), String::new()]),
            }
        }
        table.row(row);
    }
    out.push_str(&table.render("  "));
    notes(&mut out, &t.how_to_use, Some(&t.example), &t.notes);
    out
}

// ---------------------------------------------------------------------------
// almanac-arc-to-time
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct ArcToTimeArgs {
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_arc_to_time(a: &ArcToTimeArgs) -> Result<u8> {
    let t = native::arc_time();
    if a.format.is_json() {
        emit_json(&t)?;
    } else {
        report::emit(&render_arc_to_time(&t))?;
    }
    Ok(exit::OK)
}

fn render_arc_to_time(t: &ArcToTime) -> String {
    let mut out = String::from("CONVERSION OF ARC TO TIME\n\nDegrees (h m)\n");
    let blocks = 6;
    let per = t.degrees.len().div_ceil(blocks);
    let cols: Vec<(&str, Align)> = (0..blocks)
        .flat_map(|_| [("deg", Align::Right), ("h m", Align::Right)])
        .collect();
    let mut table = Table::new(&cols);
    for i in 0..per {
        let mut row = Vec::new();
        for b in 0..blocks {
            match t.degrees.get(i + b * per) {
                Some(d) => row.extend([d.deg.to_string(), d.printed.clone()]),
                None => row.extend([String::new(), String::new()]),
            }
        }
        table.row(row);
    }
    out.push_str(&table.render("  "));
    out.push_str("\nMinutes of arc (m s), with 0.00', 0.25', 0.50' and 0.75'\n");
    let mut table = Table::new(&[
        ("'", Align::Right),
        ("0.00", Align::Right),
        ("0.25", Align::Right),
        ("0.50", Align::Right),
        ("0.75", Align::Right),
    ]);
    for r in &t.arcminutes {
        let mut row = vec![r.arcmin.to_string()];
        row.extend(r.printed.iter().cloned());
        table.row(row);
    }
    out.push_str(&table.render("  "));
    notes(&mut out, &t.how_to_use, Some(&t.example), &t.notes);
    out
}

// ---------------------------------------------------------------------------
// almanac-altitude
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct AltitudeArgs {
    /// With --pressure: the exact additional corrections for this air temperature, C.
    #[arg(
        long,
        value_name = "C",
        allow_negative_numbers = true,
        requires = "pressure"
    )]
    pub temperature: Option<f64>,
    /// With --temperature: ... and this pressure, hPa.
    #[arg(long, value_name = "HPA", requires = "temperature")]
    pub pressure: Option<f64>,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_altitude(a: &AltitudeArgs) -> Result<u8> {
    let conditions = match (a.temperature, a.pressure) {
        (Some(t), Some(p)) => {
            serde_json::json!({"temperature_c": t, "pressure_hpa": p}).to_string()
        }
        _ => String::new(),
    };
    let t = call(native::altitude(&conditions))?;
    if a.format.is_json() {
        emit_json(&t)?;
    } else {
        report::emit(&render_altitude(&t))?;
    }
    Ok(exit::OK)
}

fn render_altitude(t: &AltitudeTables) -> String {
    let mut out = String::from("ALTITUDE CORRECTION TABLES\n");
    push_note(
        &mut out,
        &format!(
            "Refraction {} at {} hPa and {} C; the Sun's SD {}' (October to March) and {}' \
             (April to September), HP {:.3}'.",
            t.refraction.model,
            t.refraction.pressure_hpa,
            t.refraction.temperature_c,
            t.sun_sd_oct_mar_arcmin,
            t.sun_sd_apr_sep_arcmin,
            t.sun_hp_arcmin
        ),
    );
    out.push_str("\nSun, October to March (apparent altitude)\n");
    out.push_str(&critical(&t.sun_oct_mar));
    out.push_str("\nSun, April to September\n");
    out.push_str(&critical(&t.sun_apr_sep));
    out.push_str("\nStars and planets\n");
    out.push_str(&critical(&t.stars_planets));
    out.push_str("\nDip (height of eye, metres)\n");
    out.push_str(&critical(&t.dip.metres));
    if let Some(c) = &t.additional.conditions {
        out.push_str(&format!(
            "\nAdditional corrections for {} C and {} hPa (factor {:.4}, zone {})\n",
            c.temperature_c,
            c.pressure_hpa,
            c.factor,
            c.zone.as_deref().unwrap_or("outside A to N")
        ));
        let mut table = Table::new(&[("app. alt", Align::Left), ("corr", Align::Right)]);
        for (row, corr) in t.additional.rows.iter().zip(&c.corrections) {
            table.row(vec![row.printed_alt.clone(), corr.printed.clone()]);
        }
        out.push_str(&table.render("  "));
    }
    out.push('\n');
    push_note(
        &mut out,
        "--format json has the low-altitude rows, the dip in feet, the additional corrections \
         for every zone and the Moon's two-part table.",
    );
    for h in &t.how_to_use {
        push_note(&mut out, h);
    }
    for n in &t.notes {
        push_note(&mut out, n);
    }
    out
}

// ---------------------------------------------------------------------------
// almanac-planets
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct PlanetsArgs {
    #[command(flatten)]
    pub year: YearFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_planets(a: &PlanetsArgs) -> Result<u8> {
    let t = call(native::planets(f64::from(a.year.year), calendar_arg()))?;
    if a.format.is_json() {
        emit_json(&t)?;
    } else {
        report::emit(&render_planets(&t))?;
    }
    Ok(exit::OK)
}

fn render_planets(t: &PlanetCorrections) -> String {
    let mut out = format!(
        "ADDITIONAL CORRECTIONS FOR VENUS AND MARS {}\n",
        skyfix_core::calendar::format_year(t.year)
    );
    for (name, periods) in [("Venus", &t.venus), ("Mars", &t.mars)] {
        for p in periods {
            out.push_str(&format!(
                "\n{name}, {}-{:02}-{:02} to {}-{:02}-{:02}: HP {:.1}'\n",
                skyfix_core::calendar::format_year(p.from.year),
                p.from.month,
                p.from.day,
                skyfix_core::calendar::format_year(p.to.year),
                p.to.month,
                p.to.day,
                p.hp_arcmin
            ));
            out.push_str(&critical(&p.table));
        }
    }
    for e in &t.errors {
        out.push_str(&format!("  not computed: {}: {}\n", e.body, e.message));
    }
    notes(&mut out, &t.how_to_use, None, &t.notes);
    out
}

// ---------------------------------------------------------------------------
// almanac-polaris
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct PolarisArgs {
    #[command(flatten)]
    pub year: YearFlag,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_polaris(a: &PolarisArgs) -> Result<u8> {
    let t = call(native::polaris(f64::from(a.year.year), calendar_arg()))?;
    if a.format.is_json() {
        emit_json(&t)?;
    } else {
        report::emit(&render_polaris(&t))?;
    }
    Ok(exit::OK)
}

fn render_polaris(t: &PolarisTable) -> String {
    let mut out = format!(
        "POLARIS (POLE STAR) TABLES {}\nMean place SHA {}, Dec {}; polar distance {:.3}'; the \
         formula's own error up to {:.4}'\n",
        skyfix_core::calendar::format_year(t.year),
        t.printed_mean.sha,
        t.printed_mean.dec,
        t.polar_distance_arcmin,
        t.formula_error_arcmin
    );
    // Six columns of LHA Aries at a time, as the book's page holds twelve.
    for block in t.columns.chunks(6) {
        let heads: Vec<String> = block
            .iter()
            .map(|c| format!("{}-{}", c.from_deg, c.from_deg + 9))
            .collect();
        let mut cols = vec![("", Align::Left)];
        for h in &heads {
            cols.push((h.as_str(), Align::Right));
        }
        out.push_str("\nLHA Aries\n");
        let mut table = Table::new(&cols);
        let n0 = block[0].a0.len();
        for i in 0..n0 {
            let mut row = vec![format!("a0 {i}")];
            row.extend(block.iter().map(|c| c.a0[i].printed.clone()));
            table.row(row);
        }
        for (i, lat) in t.a1_latitudes.iter().enumerate() {
            let mut row = vec![format!("a1 lat {lat}")];
            row.extend(block.iter().map(|c| c.a1[i].printed.clone()));
            table.row(row);
        }
        for i in 0..block[0].a2.len() {
            let mut row = vec![format!("a2 month {}", i + 1)];
            row.extend(block.iter().map(|c| c.a2[i].printed.clone()));
            table.row(row);
        }
        for (i, lat) in t.azimuth_latitudes.iter().enumerate() {
            let mut row = vec![format!("Az lat {lat}")];
            row.extend(block.iter().map(|c| c.azimuth[i].printed.clone()));
            table.row(row);
        }
        out.push_str(&table.render("  "));
    }
    if let Some(e) = &t.example {
        out.push('\n');
        push_note(
            &mut out,
            &format!(
                "Example: {} (the table's latitude {:.6}, the rigorous one {:.6}).",
                e.text, e.latitude_deg, e.rigorous_latitude_deg
            ),
        );
    }
    for w in &t.warnings {
        push_note(&mut out, &format!("Warning: {w}"));
    }
    notes(&mut out, &t.how_to_use, None, &t.notes);
    out
}
