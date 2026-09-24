//! Plain-text formatting shared by every subcommand. OWNER: cli agent.
//!
//! Two rules hold everywhere in here:
//!
//! 1. **Degrees and arcminutes on screen, never radians** (CONVENTIONS section 1).
//!    Positions are printed twice: decimal degrees for copying into another tool, and
//!    degrees + decimal arcminutes with a hemisphere letter for reading off a chart.
//! 2. **No colour and no terminal escapes.** The output is meant to be piped, diffed
//!    and pasted into an issue, and `docs/CLI.md` quotes it verbatim.
//!
//! [`warning_sentence`] turns every [`Warning`] variant into one plain sentence. Its
//! match is exhaustive on purpose: adding a variant to the core enum breaks this build
//! until someone writes the sentence, which is the only reliable way to stop a caveat
//! from silently disappearing from the report.

use skyfix_core::types::{
    AltitudeKind, CorrectionKind, LatLon, Warning,
};
use skyfix_core::units::NM_M;

// ---------------------------------------------------------------------------
// Angles and positions
// ---------------------------------------------------------------------------

/// Latitude as `"39 57.16' N"`: two degree digits, decimal arcminutes, hemisphere.
pub fn format_lat(deg: f64) -> String {
    deg_arcmin(deg, 2, 'N', 'S')
}

/// Longitude as `"075 09.91' W"`: three degree digits, decimal arcminutes, hemisphere.
pub fn format_lon(deg: f64) -> String {
    deg_arcmin(deg, 3, 'E', 'W')
}

/// Degrees + decimal arcminutes with a hemisphere letter.
///
/// Rounding is done once, on the total arcminutes, so a value a hair under a whole
/// degree carries into the degrees instead of printing an impossible `60.00'`.
fn deg_arcmin(deg: f64, width: usize, positive: char, negative: char) -> String {
    if !deg.is_finite() {
        return format!("{deg} (not a finite angle)");
    }
    let hemisphere = if deg < 0.0 { negative } else { positive };
    let total_arcmin = (deg.abs() * 60.0 * 100.0).round() / 100.0;
    let d = (total_arcmin / 60.0).floor();
    let m = total_arcmin - d * 60.0;
    let d = d as i64;
    format!("{d:0width$} {m:05.2}' {hemisphere}")
}

/// `"39 57.16' N, 075 09.91' W"`.
pub fn format_position(p: LatLon) -> String {
    format!("{}, {}", format_lat(p.lat_deg), format_lon(p.lon_deg))
}

/// `"39.952600, -75.165200"`. Six decimals is about 0.11 m, finer than any fix here.
pub fn format_position_decimal(p: LatLon) -> String {
    format!("{:.6}, {:.6}", p.lat_deg, p.lon_deg)
}

/// Metres and the same length in nautical miles, e.g. `"1852 m (1.000 NM)"`.
pub fn metres_and_nm(m: f64) -> String {
    format!("{m:.1} m ({:.3} NM)", m / NM_M)
}

/// An intercept with the traditional toward/away letter (CONVENTIONS section 3).
pub fn intercept(nm: f64) -> String {
    let letter = if nm >= 0.0 { "T" } else { "A" };
    let sense = if nm >= 0.0 { "toward" } else { "away" };
    format!("{:.2} NM {letter} ({sense})", nm.abs())
}

// ---------------------------------------------------------------------------
// Enum names (the on-screen spelling, matching the JSON spelling)
// ---------------------------------------------------------------------------

/// Exhaustive by design: a new correction step must be named before this compiles.
pub fn correction_kind_name(kind: CorrectionKind) -> &'static str {
    match kind {
        CorrectionKind::IndexCorrection => "index_correction",
        CorrectionKind::Dip => "dip",
        CorrectionKind::ArtificialHorizonHalving => "artificial_horizon_halving",
        CorrectionKind::Refraction => "refraction",
        CorrectionKind::Semidiameter => "semidiameter",
        CorrectionKind::Parallax => "parallax",
    }
}

fn altitude_kind_name(kind: AltitudeKind) -> &'static str {
    skyfix_core::corrections::kind_name(kind)
}

// ---------------------------------------------------------------------------
// Text layout
// ---------------------------------------------------------------------------

/// Pad `s` on the right to `width` display columns (ASCII-ish; star names are ASCII).
pub fn pad(s: &str, width: usize) -> String {
    let n = s.chars().count();
    if n >= width {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(width - n))
    }
}

/// Wrap `text` to `width` columns, prefixing every line with `indent`.
///
/// Whitespace-only input yields no lines at all, so an empty note prints nothing
/// rather than a lonely indent.
pub fn wrap(text: &str, width: usize, indent: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if current.is_empty() {
            current.push_str(word);
        } else if current.chars().count() + 1 + word.chars().count() <= width {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(format!("{indent}{current}"));
            current = word.to_string();
        }
    }
    if !current.is_empty() {
        lines.push(format!("{indent}{current}"));
    }
    lines
}

/// Write a finished report to stdout, treating a closed pipe as success.
///
/// Every command builds its whole result as a string and hands it here. That is partly
/// so tests can assert on the text without a subprocess, and partly because
/// `skyfix catalog | head` closes stdout early: with bare `println!` the process then
/// panics with "failed printing to stdout: Broken pipe", which looks like a defect in
/// the tool rather than the ordinary end of a pipeline.
pub fn emit(text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    match lock.write_all(text.as_bytes()).and_then(|()| lock.flush()) {
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}

/// [`emit`] with a trailing newline, for reports built without one.
pub fn emit_line(text: &str) -> std::io::Result<()> {
    emit(&format!("{text}\n"))
}

/// Collapse every run of whitespace to one space.
///
/// A wrapped report can break a phrase across two lines, so a test (or a `grep`) that
/// looks for wording must flatten the text first: where the line break falls is a
/// formatting detail, not part of the contract.
pub fn flatten(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One CSV field, quoted in the RFC 4180 way when it needs to be.
pub fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) || s.starts_with(' ') || s.ends_with(' ') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// `Some(x)` as a fixed-precision number, `None` as `"-"`. Keeps table columns aligned.
pub fn opt_num(v: Option<f64>, decimals: usize) -> String {
    match v {
        Some(x) => format!("{x:.decimals$}"),
        None => "-".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/// One plain sentence for a machine-readable [`Warning`] (CONVENTIONS section 12).
///
/// The match below has no wildcard arm. That is the guard: a `Warning` variant added in
/// `skyfix-core` stops this crate compiling until it is given a sentence here, so no
/// caveat can be added to the core and silently vanish from the CLI's report.
pub fn warning_sentence(w: &Warning) -> String {
    let s = match w {
        Warning::LowAltitudeRefraction {
            id,
            apparent_altitude_deg,
            sigma_added_arcmin,
        } => {
            if *sigma_added_arcmin > 0.0 {
                format!(
                    "Sight {id} was taken at an apparent altitude of {apparent_altitude_deg:.2} \
                     degrees, where the refraction model is least reliable, so \
                     {sigma_added_arcmin:.2} arcminutes were added in quadrature to its \
                     uncertainty"
                )
            } else {
                format!(
                    "Sight {id} was taken at an apparent altitude of {apparent_altitude_deg:.2} \
                     degrees, low enough that the refraction model is less reliable; its \
                     uncertainty was left unchanged"
                )
            }
        }
        Warning::DipNotApplicable { id, horizon } => format!(
            "Sight {id} was taken against the {} horizon, which has no dip to correct for",
            skyfix_core::corrections::horizon_name(*horizon)
        ),
        Warning::AlreadyCorrected { id, kind, ignored } => {
            let list: Vec<&str> = ignored
                .iter()
                .map(|k| correction_kind_name(*k))
                .collect();
            if list.is_empty() {
                format!(
                    "Sight {id} is recorded as {} and needs no further correction",
                    altitude_kind_name(*kind)
                )
            } else {
                format!(
                    "Sight {id} is recorded as {}, so these supplied correction parameters were \
                     ignored rather than applied a second time: {}",
                    altitude_kind_name(*kind),
                    list.join(", ")
                )
            }
        }
        Warning::LimbIgnoredForStar { id } => format!(
            "Sight {id} names a limb, but only the Sun has a disc here, so the limb was ignored"
        ),
        Warning::SuppliedDirectionUsed { id } => format!(
            "Sight {id} carries its own geocentric direction, which was used instead of any \
             ephemeris provider"
        ),
        Warning::EphemerisCoverageLimited { provider, coverage } => format!(
            "The ephemeris provider {provider} covers only {coverage}, and refuses anything \
             outside that range"
        ),
        Warning::PoorGeometry {
            condition_number,
            max_azimuth_gap_deg,
        } => format!(
            "The sight geometry is poor: condition number {condition_number:.1} with a \
             {max_azimuth_gap_deg:.0} degree gap between azimuths, so the fix is far weaker \
             across that gap than along it"
        ),
        Warning::ClockDegenerateWithLongitude { sigma_east_m } => format!(
            "Clock error and longitude are the same quantity for these sights, so the clock \
             offset was not estimated; the stated uncertainty was propagated instead as \
             {sigma_east_m:.0} metres of extra east-west uncertainty"
        ),
        Warning::PriorUsed { sigma_nm, shift_m } => format!(
            "A position prior with a 1-sigma radius of {sigma_nm} NM was part of this solution \
             and moved the fix {shift_m:.0} metres from what the observations alone give"
        ),
        Warning::RobustWeightsApplied { downweighted_ids } => {
            if downweighted_ids.is_empty() {
                "Robust (Huber) weighting was applied, and no sight needed downweighting, so \
                 the covariance is the ordinary one"
                    .to_string()
            } else {
                format!(
                    "Robust (Huber) weighting downweighted {}, so the covariance and ellipse \
                     below are approximate rather than exact",
                    downweighted_ids.join(", ")
                )
            }
        }
        Warning::EllipseSuppressed { reason } => {
            format!("No 95 % error ellipse is reported, because {reason}")
        }
        Warning::PosteriorScalingSkipped { dof } => format!(
            "Posterior scaling was asked for but skipped: {dof} degrees of freedom cannot \
             establish a noise level, and three are the minimum"
        ),
        Warning::DuplicateObservation { ids } => format!(
            "These records share a body, an instant and an altitude, and are being treated as \
             independent measurements: {}",
            ids.join(", ")
        ),
        Warning::NotConverged { iterations } => {
            format!("The solver did not converge within {iterations} iterations")
        }
        Warning::Other { message } => message.clone(),
    };
    ensure_period(s)
}

fn ensure_period(mut s: String) -> String {
    let s_trimmed = s.trim_end();
    if s_trimmed.is_empty() {
        return String::new();
    }
    s.truncate(s_trimmed.len());
    if !s.ends_with('.') && !s.ends_with('!') && !s.ends_with('?') {
        s.push('.');
    }
    s
}

/// Warnings as an indented bullet list, or nothing at all when there are none.
pub fn warning_block(warnings: &[Warning], out: &mut String) {
    if warnings.is_empty() {
        return;
    }
    out.push_str("\nWarnings\n");
    for w in warnings {
        for (i, line) in wrap(&warning_sentence(w), 86, "    ").into_iter().enumerate() {
            if i == 0 {
                out.push_str("  - ");
                out.push_str(line.trim_start());
            } else {
                out.push_str(&line);
            }
            out.push('\n');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::types::{AltitudeKind, HorizonMode};

    #[test]
    fn degrees_and_arcminutes_match_the_chart_convention() {
        assert_eq!(format_lat(39.9526), "39 57.16' N");
        assert_eq!(format_lon(-75.1652), "075 09.91' W");
        assert_eq!(format_lat(0.0), "00 00.00' N");
    }

    #[test]
    fn hemisphere_letters_and_widths() {
        assert_eq!(format_lat(-33.8688), "33 52.13' S");
        assert_eq!(format_lon(151.2093), "151 12.56' E");
        assert_eq!(format_lon(0.0), "000 00.00' E");
        assert_eq!(format_lat(90.0), "90 00.00' N");
        assert_eq!(format_lon(-180.0), "180 00.00' W");
    }

    #[test]
    fn rounding_carries_into_the_degrees_instead_of_printing_sixty() {
        // 39.999 99 deg is 39 deg 59.9994', which must not print as "39 60.00'".
        assert_eq!(format_lat(39.99999), "40 00.00' N");
        assert_eq!(format_lon(-0.0000001), "000 00.00' W");
    }

    #[test]
    fn non_finite_angles_say_so_rather_than_printing_nonsense() {
        assert!(format_lat(f64::NAN).contains("not a finite angle"));
        assert!(format_lon(f64::INFINITY).contains("not a finite angle"));
    }

    #[test]
    fn position_prints_both_forms() {
        let p = LatLon {
            lat_deg: 39.9526,
            lon_deg: -75.1652,
        };
        assert_eq!(format_position(p), "39 57.16' N, 075 09.91' W");
        assert_eq!(format_position_decimal(p), "39.952600, -75.165200");
    }

    #[test]
    fn intercepts_carry_toward_and_away() {
        assert_eq!(intercept(2.5), "2.50 NM T (toward)");
        assert_eq!(intercept(-2.5), "2.50 NM A (away)");
        assert_eq!(intercept(0.0), "0.00 NM T (toward)");
    }

    #[test]
    fn metres_are_shown_with_their_nautical_miles() {
        assert_eq!(metres_and_nm(1852.0), "1852.0 m (1.000 NM)");
    }

    #[test]
    fn wrapping_respects_the_width_and_drops_empty_text() {
        // The indent is not counted against the width; "four five" is exactly 9.
        let lines = wrap("one two three four five", 9, "  ");
        assert_eq!(lines, vec!["  one two", "  three", "  four five"]);
        assert_eq!(wrap("one two three four five", 8, "  "), vec!["  one two", "  three", "  four", "  five"]);
        assert!(wrap("   ", 20, "  ").is_empty());
        assert_eq!(flatten(&lines.join("\n")), "one two three four five");
    }

    #[test]
    fn csv_fields_quote_only_when_they_must() {
        assert_eq!(csv_field("Vega"), "Vega");
        assert_eq!(csv_field("Rigil Kentaurus"), "Rigil Kentaurus");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    /// Every `Warning` variant, so an unmapped one is caught here as well as by the
    /// exhaustive match in [`warning_sentence`].
    fn every_warning_variant() -> Vec<Warning> {
        vec![
            Warning::LowAltitudeRefraction {
                id: "obs-1".into(),
                apparent_altitude_deg: 3.2,
                sigma_added_arcmin: 1.0,
            },
            Warning::DipNotApplicable {
                id: "obs-1".into(),
                horizon: HorizonMode::ArtificialReflected,
            },
            Warning::AlreadyCorrected {
                id: "obs-1".into(),
                kind: AltitudeKind::ObservedHo,
                ignored: vec![CorrectionKind::Dip, CorrectionKind::Refraction],
            },
            Warning::LimbIgnoredForStar { id: "obs-1".into() },
            Warning::SuppliedDirectionUsed { id: "obs-1".into() },
            Warning::EphemerisCoverageLimited {
                provider: "p".into(),
                coverage: "1990..2060".into(),
            },
            Warning::PoorGeometry {
                condition_number: 42.0,
                max_azimuth_gap_deg: 200.0,
            },
            Warning::ClockDegenerateWithLongitude {
                sigma_east_m: 350.0,
            },
            Warning::PriorUsed {
                sigma_nm: 20.0,
                shift_m: 120.0,
            },
            Warning::RobustWeightsApplied {
                downweighted_ids: vec!["obs-3".into()],
            },
            Warning::EllipseSuppressed {
                reason: "the result is ambiguous".into(),
            },
            Warning::PosteriorScalingSkipped { dof: 1 },
            Warning::DuplicateObservation {
                ids: vec!["obs-1".into(), "obs-2".into()],
            },
            Warning::NotConverged { iterations: 50 },
            Warning::Other {
                message: "something else".into(),
            },
        ]
    }

    #[test]
    fn every_warning_variant_has_a_plain_sentence() {
        let all = every_warning_variant();
        // Bump this when `Warning` gains a variant; the exhaustive match in
        // `warning_sentence` will have stopped the build first.
        assert_eq!(all.len(), 15, "add the new Warning variant to this test");
        for w in &all {
            let s = warning_sentence(w);
            assert!(!s.is_empty(), "{w:?} produced an empty sentence");
            assert!(s.ends_with('.'), "{w:?} -> {s:?} does not end a sentence");
            assert!(
                !s.contains('{') && !s.contains('}'),
                "{w:?} -> {s:?} looks like a debug dump, not a sentence"
            );
            // `Other` carries a message written by whoever raised it, often naming a
            // field ("observer.pressure_hpa 500 is outside..."), so it is the one
            // variant whose sentence may legitimately start lower case.
            if !matches!(w, Warning::Other { .. }) {
                assert!(
                    s.chars().next().is_some_and(|c| c.is_uppercase()),
                    "{w:?} -> {s:?} does not start a sentence"
                );
            }
        }
    }

    #[test]
    fn robust_weighting_sentence_distinguishes_no_downweighting() {
        let none = warning_sentence(&Warning::RobustWeightsApplied {
            downweighted_ids: vec![],
        });
        assert!(none.contains("no sight needed downweighting"), "{none}");
        let some = warning_sentence(&Warning::RobustWeightsApplied {
            downweighted_ids: vec!["obs-3".into()],
        });
        assert!(some.contains("obs-3"), "{some}");
    }

    #[test]
    fn warning_block_is_empty_when_there_is_nothing_to_say() {
        let mut out = String::new();
        warning_block(&[], &mut out);
        assert!(out.is_empty());
        warning_block(&[Warning::NotConverged { iterations: 50 }], &mut out);
        assert!(out.contains("Warnings"), "{out}");
        assert!(out.contains("did not converge"), "{out}");
    }
}
