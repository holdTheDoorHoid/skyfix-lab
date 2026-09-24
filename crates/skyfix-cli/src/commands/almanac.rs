//! `skyfix almanac --date YYYY-MM-DD [--format text|json]`. OWNER: almanac agent.
//!
//! The daily pages of a nautical almanac for one UT date (`skyfix_almanac::pages`,
//! CONVENTIONS 13.9): the left page (Aries, the four navigational planets, the stars)
//! and the right page (Sun, Moon, twilight, sunrise, sunset, moonrise, moonset), laid out
//! in plain text as the printed almanac lays them out, with every number exactly as
//! `--format json` carries it under `printed`.
//!
//! Plain text only: no colour, no terminal escapes (the report module's rule). The
//! printed almanac shades a negative equation of time; text cannot, so it prints a
//! minus sign instead.

use anyhow::{Result, anyhow};
use skyfix_almanac::pages::{AlmanacDay, TableTime, almanac_day};
use skyfix_ephemeris::body::Sky;

use crate::exit;
use crate::report;

/// `--format` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum AlmanacFormat {
    /// The two pages, laid out in columns.
    #[default]
    Text,
    /// The `AlmanacDay` document (docs/EXPLORER_API.md), raw and printed values.
    Json,
}

pub fn run(date: &str, format: AlmanacFormat) -> Result<u8> {
    let day = almanac_day(&Sky::new(), date).map_err(|e| anyhow!("{e}"))?;
    match format {
        AlmanacFormat::Json => report::emit_line(&serde_json::to_string_pretty(&day)?)?,
        AlmanacFormat::Text => report::emit(&render(&day))?,
    }
    Ok(exit::OK)
}

/// `183 12.4` -> `183 12.4`, `2 07.4` -> `  2 07.4`: degrees right-aligned in 3.
fn gha(s: &str) -> String {
    match s.split_once(' ') {
        Some((d, m)) => format!("{d:>3} {m}"),
        None => format!("{s:>8}"),
    }
}

/// `N 2 18.0` -> `N  2 18.0`: degrees right-aligned in 2.
fn dec(s: &str) -> String {
    let parts: Vec<&str> = s.split(' ').collect();
    match parts.as_slice() {
        [h, d, m] => format!("{h} {d:>2} {m}"),
        _ => format!("{s:>9}"),
    }
}

fn t(x: &TableTime) -> String {
    format!("{:>6}", x.printed)
}

/// Both pages as plain text.
pub fn render(day: &AlmanacDay) -> String {
    let mut o = String::new();
    let title = format!(
        "{} ({})   Greenwich hour angles and declinations for 00h-23h UT",
        day.date,
        day.weekday.to_uppercase()
    );
    o.push_str(&format!("SKYFIX LAB DAILY PAGES   {title}\n"));
    o.push_str("Simulation and analysis workbench. Not a navigation instrument.\n\n");

    // ---- Left page -------------------------------------------------------------------
    o.push_str("LEFT PAGE: ARIES, PLANETS, STARS\n\n");
    let mut h1 = format!("{:<4}{:>9}", "UT", "ARIES");
    let mut h2 = format!("{:<4}{:>9}", "", "GHA");
    for p in &day.planets {
        h1.push_str(&format!(
            "   {:<18}",
            format!("{} {}", p.body.to_uppercase(), p.printed.magnitude)
        ));
        h2.push_str(&format!("   {:>8} {:>9}", "GHA", "Dec"));
    }
    o.push_str(&format!("{h1}\n{h2}\n"));
    for r in &day.hours {
        if r.hour % 6 == 0 && r.hour > 0 {
            o.push('\n');
        }
        let mut line = format!("{:02}  {:>9}", r.hour, gha(&r.aries.printed.gha));
        for p in &r.planets {
            line.push_str(&format!(
                "   {} {}",
                gha(&p.printed.gha),
                dec(&p.printed.dec)
            ));
        }
        o.push_str(&format!("{}\n", line.trim_end()));
    }
    let mut foot = format!("{:<4}{:>9}", "", "");
    for p in &day.planets {
        foot.push_str(&format!(
            "   {:<18}",
            format!("v {:>4}  d {:>4}", p.printed.v, p.printed.d)
        ));
    }
    o.push_str(&format!("{}\n", foot.trim_end()));
    o.push_str(&format!(
        "Mer. Pass. of Aries {}\n\n",
        day.aries.mer_pass.printed
    ));

    o.push_str(&format!(
        "{:<11}{:>9}  {:<11}\n",
        "PLANETS", "SHA", "Mer. Pass."
    ));
    for p in &day.planets {
        o.push_str(&format!(
            "{:<11}{:>9}  {:>6}\n",
            p.body,
            gha(&p.printed.sha),
            p.mer_pass.printed
        ));
    }
    o.push('\n');

    o.push_str("STARS at 12h UT\n");
    let half = day.stars.len().div_ceil(2);
    let star = |i: usize| -> String {
        day.stars.get(i).map_or(String::new(), |s| {
            format!(
                "{:<16}{:>9} {:>10}",
                s.body,
                gha(&s.printed.sha),
                dec(&s.printed.dec)
            )
        })
    };
    o.push_str(&format!(
        "{:<16}{:>9} {:>10}      {:<16}{:>9} {:>10}\n",
        "Name", "SHA", "Dec", "Name", "SHA", "Dec"
    ));
    for i in 0..half {
        let line = format!("{}      {}", star(i), star(i + half));
        o.push_str(&format!("{}\n", line.trim_end()));
    }
    o.push('\n');

    // ---- Right page ------------------------------------------------------------------
    o.push_str("RIGHT PAGE: SUN, MOON, TWILIGHT, SUNRISE, MOONRISE\n\n");
    o.push_str(&format!("{:<4}{:^20}   {:^38}\n", "UT", "SUN", "MOON"));
    o.push_str(&format!(
        "{:<4}{:>9} {:>10}   {:>8} {:>5} {:>10} {:>5} {:>5}\n",
        "", "GHA", "Dec", "GHA", "v", "Dec", "d", "HP"
    ));
    for r in &day.hours {
        if r.hour % 6 == 0 && r.hour > 0 {
            o.push('\n');
        }
        let moon = r.moon.as_ref().map_or_else(
            || "Moon not available".to_string(),
            |m| {
                format!(
                    "{} {:>5} {:>10} {:>5} {:>5}",
                    gha(&m.printed.gha),
                    m.printed.v,
                    dec(&m.printed.dec),
                    m.printed.d,
                    m.printed.hp
                )
            },
        );
        o.push_str(&format!(
            "{:02}  {:>9} {:>10}   {}\n",
            r.hour,
            gha(&r.sun.printed.gha),
            dec(&r.sun.printed.dec),
            moon
        ));
    }
    o.push_str(&format!(
        "{:<4}SD {:>4}  d {:>4}          {}\n\n",
        "",
        day.sun.printed.sd,
        day.sun.printed.d,
        day.moon
            .as_ref()
            .map_or(String::new(), |m| format!("SD {}", m.printed.sd))
    ));

    let dates = &day.rise_set.moon_dates;
    let short = |d: &String| d.get(8..10).unwrap_or(d).to_string();
    o.push_str(&format!(
        "{:<6} {:^13} {:>7}   {:^13}\n",
        "Lat.", "Twilight", "Sunrise", "Moonrise"
    ));
    o.push_str(&format!(
        "{:<6} {:>6} {:>6} {:>7}   {:>6} {:>6}\n",
        "",
        "Naut.",
        "Civil",
        "",
        short(&dates[0]),
        dates.get(1).map_or(String::new(), short)
    ));
    for (i, r) in day.rise_set.rows.iter().enumerate() {
        if i > 0 && i % 5 == 0 {
            o.push('\n');
        }
        o.push_str(&format!(
            "{:<6} {} {} {:>7}   {} {}\n",
            r.label,
            t(&r.nautical_dawn),
            t(&r.civil_dawn),
            r.sunrise.printed,
            t(&r.moonrise[0]),
            r.moonrise.get(1).map_or(String::new(), t)
        ));
    }
    o.push('\n');
    o.push_str(&format!(
        "{:<6} {:>7} {:^13}   {:^13}\n",
        "Lat.", "Sunset", "Twilight", "Moonset"
    ));
    o.push_str(&format!(
        "{:<6} {:>7} {:>6} {:>6}   {:>6} {:>6}\n",
        "",
        "",
        "Civil",
        "Naut.",
        short(&dates[0]),
        dates.get(1).map_or(String::new(), short)
    ));
    for (i, r) in day.rise_set.rows.iter().enumerate() {
        if i > 0 && i % 5 == 0 {
            o.push('\n');
        }
        o.push_str(&format!(
            "{:<6} {:>7} {} {}   {} {}\n",
            r.label,
            r.sunset.printed,
            t(&r.civil_dusk),
            t(&r.nautical_dusk),
            t(&r.moonset[0]),
            r.moonset.get(1).map_or(String::new(), t)
        ));
    }
    o.push('\n');

    let eot = |s: f64, printed: &str| {
        if s < 0.0 {
            format!("-{printed}")
        } else {
            format!(" {printed}")
        }
    };
    o.push_str(&format!(
        "SUN   Eqn. of Time 00h {}   12h {}   Mer. Pass. {}\n",
        eot(day.sun.eot_00h_s, &day.sun.printed.eot_00h),
        eot(day.sun.eot_12h_s, &day.sun.printed.eot_12h),
        day.sun.mer_pass.printed
    ));
    if let Some(m) = &day.moon {
        let phase = m.phase.as_ref().map_or(String::new(), |p| {
            let name = serde_json::to_value(p.kind)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.replace('_', " ")))
                .unwrap_or_default();
            format!("   {name} at {}", &p.utc[11..16])
        });
        o.push_str(&format!(
            "MOON  Mer. Pass. Upper {}   Lower {}   Age {} d   {} % illuminated{phase}\n",
            m.mer_pass_upper.printed,
            m.mer_pass_lower.printed,
            m.printed.age,
            m.printed.illuminated
        ));
    }
    o.push('\n');

    for note in &day.notes {
        for line in report::wrap(note, 88, "  ") {
            o.push_str(&line);
            o.push('\n');
        }
    }
    if !day.errors.is_empty() {
        o.push_str("\nNot computed:\n");
        for e in &day.errors {
            for line in report::wrap(&format!("{}: {}", e.body, e.message), 88, "  ") {
                o.push_str(&line);
                o.push('\n');
            }
        }
    }
    // No trailing blanks: the output is diffed and pasted.
    let mut out: String = o.lines().map(str::trim_end).collect::<Vec<_>>().join("\n");
    out.push('\n');
    out
}
