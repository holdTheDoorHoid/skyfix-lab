//! Deep time: `explorer-coverage` (the two coverage tiers) and `tier-at` (the tier of an
//! instant). OWNER: cli3 agent.
//!
//! The deeptime agent's exports `explorer_coverage` and `tier_at`
//! (`skyfix_wasm::coverage::native`; EXPLORER_API.md "`explorer_coverage()` — tiers" and
//! "Expansion programme — coverage tiers as built"; CONVENTIONS 15.1): the **validated**
//! tier, 1550-01-01 to 2650-01-22, where the accuracy figures of docs/ACCURACY.md hold and
//! bodies are offered for sights; the **labelled** tier, 2000 BC to AD 3000, display only,
//! every time shown carrying the Delta-T uncertainty; and **outside**. `skyfix coverage`
//! is the sight providers' own coverage (the `coverage` export), a different question.

use anyhow::Result;
use skyfix_core::calendar::Calendar;
use skyfix_ephemeris::tiers::Tier;
use skyfix_wasm::coverage::native::{self as wasm_coverage, ExplorerCoverage};

use super::args::FormatArgs;
use super::text;
use super::timescales::WhenArg;
use super::wire::{Align, Table, emit_json, push_field, push_note};
use crate::exit;
use crate::report;

// ---------------------------------------------------------------------------
// explorer-coverage
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct CoverageArgs {
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_coverage(a: &CoverageArgs) -> Result<u8> {
    let c = wasm_coverage::explorer_coverage();
    if a.format.is_json() {
        emit_json(&c)?;
    } else {
        report::emit(&render_coverage(&c))?;
    }
    Ok(exit::OK)
}

fn tier_words(t: Tier) -> &'static str {
    match t {
        Tier::Validated => "validated",
        Tier::Labelled => "labelled",
        Tier::Outside => "outside",
    }
}

fn render_coverage(c: &ExplorerCoverage) -> String {
    let mut out = String::from("THE EXPLORER'S COVERAGE\n");
    push_field(
        &mut out,
        "Display",
        &format!(
            "{} to {}: the sky, the day's events, the Moon's phases, the seasons and the sun \
             tools answer both tiers",
            c.start_utc, c.end_utc
        ),
    );
    push_field(
        &mut out,
        "Validated",
        &format!(
            "{} to {}: sights, predicted readings, the planner and the other engines answer \
             this tier only",
            c.validated_start_utc, c.validated_end_utc
        ),
    );
    push_field(
        &mut out,
        "Packs",
        &if c.packs_loaded.is_empty() {
            "none loaded (no pack is needed for either tier)".to_string()
        } else {
            c.packs_loaded.join(", ")
        },
    );
    out.push('\n');
    let mut t = Table::new(&[
        ("group", Align::Left),
        ("tier", Align::Left),
        ("from", Align::Left),
        ("to", Align::Left),
        ("worst '", Align::Right),
        ("sights", Align::Left),
    ]);
    for g in &c.groups {
        for (i, tier) in g.tiers.iter().enumerate() {
            t.row(vec![
                if i == 0 {
                    g.name.clone()
                } else {
                    String::new()
                },
                tier_words(tier.tier).to_string(),
                tier.start_utc.clone(),
                tier.end_utc.clone(),
                tier.accuracy_arcmin
                    .map_or_else(|| "-".to_string(), |a| format!("{a}")),
                if tier.tier == Tier::Validated && g.validated {
                    "offered"
                } else {
                    "no"
                }
                .to_string(),
            ]);
        }
    }
    out.push_str(&t.render("  "));
    out.push('\n');
    push_note(
        &mut out,
        "worst ' is the worst direction error measured over the tier (GHA or Dec, \
         arcminutes): against JPL DE440 in the validated tier, per century against DE441 in \
         the labelled one (docs/ACCURACY.md, \"Historical accuracy\"). In the labelled tier \
         every time shown carries the Delta-T uncertainty (skyfix time-info), and nothing \
         there is offered for sights. The groups' providers and notes are in --format json.",
    );
    out
}

// ---------------------------------------------------------------------------
// tier-at
// ---------------------------------------------------------------------------

#[derive(clap::Args, Debug)]
pub struct TierArgs {
    #[command(flatten)]
    pub when: WhenArg,
    #[command(flatten)]
    pub format: FormatArgs,
}

pub fn run_tier(a: &TierArgs) -> Result<u8> {
    let jd = a.when.jd()?;
    let tier = wasm_coverage::tier_at(jd);
    if a.format.is_json() {
        // The export returns the tier's name, a JSON string.
        emit_json(tier)?;
        return Ok(exit::OK);
    }
    let c = wasm_coverage::explorer_coverage();
    let meaning = match tier {
        "validated" => format!(
            "inside {} to {}: the accuracy figures of docs/ACCURACY.md hold, and bodies are \
             offered for sights",
            c.validated_start_utc, c.validated_end_utc
        ),
        "labelled" => format!(
            "a historical or far-future estimate ({} to {}): positions for display, each time \
             with its Delta-T uncertainty (skyfix time-info); no sights, predicted readings or \
             plans",
            c.start_utc, c.end_utc
        ),
        _ => format!(
            "outside the years the core covers ({} to {}): nothing is computed",
            c.start_utc, c.end_utc
        ),
    };
    let mut out = String::from("COVERAGE TIER\n");
    push_field(&mut out, "Instant", &text::utc(jd));
    // The tiers' bounds are the wire's proleptic Gregorian dates: an instant shown in the
    // Julian calendar is given in that one too, or 1549-12-25 (Julian) would seem to lie
    // before a tier that starts on 1550-01-01 and contains it.
    if text::display_calendar(jd) != Calendar::Gregorian {
        let wire = skyfix_core::time::format_utc(text::round_to_second(jd));
        push_field(
            &mut out,
            "Gregorian",
            &format!(
                "{} (proleptic, as are the bounds below)",
                wire.replace(".000Z", "Z")
            ),
        );
    }
    push_field(&mut out, "Tier", &format!("{tier}: {meaning}"));
    report::emit(&out)?;
    Ok(exit::OK)
}
