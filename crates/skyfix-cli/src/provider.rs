//! Choosing an astronomy provider. OWNER: cli agent.
//!
//! Everything here is written against [`AstroProvider`] and
//! [`skyfix_core::reduce::DirectionSource`], never against a concrete provider type, so
//! a provider added to `skyfix-ephemeris` is wired in by editing [`auto_provider`] and
//! nothing else.
//!
//! Two independent things are often confused, so they are named apart here:
//!
//! * **A body name being legal** — `validate` accepts `"Sun"` and every catalogue star
//!   whether or not a provider in this build can answer for it, because an observation
//!   may supply its own `geocentric` block and then no provider is consulted at all
//!   (CONVENTIONS section 10).
//! * **A body being answerable** — whether some merged provider will actually return a
//!   direction. That is what `skyfix catalog` reports, and it is why a body can be
//!   valid and still be rejected at reduction time.
//!
//! `auto` is a [`CompositeProvider`], which tries its members in order and reports the
//! most informative failure. `ReducedSight::direction_source` therefore shows the
//! composite's name rather than the member that answered, because
//! `DirectionSource::name()` is asked without a body. Per-body attribution lives in
//! `skyfix catalog`, which is the right place for it.

use std::sync::OnceLock;

use skyfix_core::reduce::{DirectionSource, SuppliedOnly};
use skyfix_ephemeris::fixture_pack::CompositeProvider;
use skyfix_ephemeris::stars::StarProvider;
use skyfix_ephemeris::sun::SunProvider;
use skyfix_ephemeris::{AstroProvider, Coverage, ProviderSource, catalog};

/// The name the composite reports for a direction it resolved.
pub const AUTO_PROVIDER_NAME: &str = "skyfix-auto";

/// `--ephemeris` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum EphemerisChoice {
    /// Use a supplied `geocentric` block when the observation has one, otherwise every
    /// provider in this build, in order.
    #[default]
    Auto,
    /// Supplied directions only: an observation without a `geocentric` block is
    /// rejected, which is how the "first numerical slice" fixtures are tested.
    Supplied,
}

impl EphemerisChoice {
    pub fn name(self) -> &'static str {
        match self {
            EphemerisChoice::Auto => "auto",
            EphemerisChoice::Supplied => "supplied",
        }
    }
}

/// Every computed provider in this build, in priority order.
///
/// WIRING POINT: a new provider goes here and everything else follows. The
/// `FixturePackProvider` is deliberately absent: it is built from a pack the caller
/// supplies, and this build bundles none.
pub fn auto_provider() -> CompositeProvider {
    CompositeProvider::new(AUTO_PROVIDER_NAME)
        .with(SunProvider::new())
        .with(StarProvider::new())
}

/// The direction source for a reduction.
///
/// A supplied `geocentric` block always wins over a provider — that rule lives in
/// `skyfix_core::reduce::reduce_observation`, not here — so `auto` differs from
/// `supplied` only in what happens when a block is absent.
pub fn direction_source(choice: EphemerisChoice) -> Box<dyn DirectionSource> {
    match choice {
        EphemerisChoice::Auto => Box::new(ProviderSource(auto_provider())),
        EphemerisChoice::Supplied => Box::new(SuppliedOnly),
    }
}

/// A provider and its self-declared coverage, for `skyfix coverage`.
pub struct ProviderInfo {
    pub name: String,
    pub coverage: Coverage,
}

/// Each member of the composite with its coverage, in the order the composite tries
/// them.
pub fn providers() -> Vec<ProviderInfo> {
    let sun = SunProvider::new();
    let star = StarProvider::new();
    vec![
        ProviderInfo {
            name: sun.name().to_string(),
            coverage: sun.coverage(),
        },
        ProviderInfo {
            name: star.name().to_string(),
            coverage: star.coverage(),
        },
    ]
}

/// `(provider name, its body names folded to lowercase)`, computed once. Building a
/// `Coverage` allocates its whole notes paragraph, and `skyfix catalog` asks about
/// every body in the catalogue.
fn body_index() -> &'static [(String, Vec<String>)] {
    static INDEX: OnceLock<Vec<(String, Vec<String>)>> = OnceLock::new();
    INDEX.get_or_init(|| {
        providers()
            .into_iter()
            .map(|p| {
                let bodies = p
                    .coverage
                    .bodies
                    .iter()
                    .map(|b| b.trim().to_lowercase())
                    .collect();
                (p.name, bodies)
            })
            .collect()
    })
}

/// Bodies the CLI will accept in a session file: the union of the Sun and the star
/// catalogue (CONVENTIONS section 10). `"HIP <number>"` is always accepted too, by the
/// core's own rule in `session::validate`.
pub fn known_bodies() -> Vec<&'static str> {
    let mut v = vec!["Sun"];
    v.extend(catalog::names());
    v
}

/// Which provider would answer for a body, or why none would.
pub enum BodyProvider {
    Available(String),
    /// No provider in this build covers it; the string says what to do about it.
    Missing(String),
}

impl BodyProvider {
    pub fn describe(&self) -> &str {
        match self {
            BodyProvider::Available(name) => name,
            BodyProvider::Missing(reason) => reason,
        }
    }

    pub fn is_available(&self) -> bool {
        matches!(self, BodyProvider::Available(_))
    }
}

/// Resolve a body name to the provider that would supply its direction.
///
/// Matching is on each provider's declared `Coverage::bodies`, so this stays correct
/// when a provider is added; `"HIP <number>"` is resolved through the star catalogue
/// first, since no provider lists HIP designations by name.
pub fn provider_for(body: &str) -> BodyProvider {
    let wanted = match catalog::find(body) {
        Some(star) => star.name.trim().to_lowercase(),
        None => body.trim().to_lowercase(),
    };
    for (name, bodies) in body_index() {
        if bodies.contains(&wanted) {
            return BodyProvider::Available(name.clone());
        }
    }
    BodyProvider::Missing(
        "no provider in this build covers it; supply a geocentric block for these sights"
            .to_string(),
    )
}

/// A one-line coverage summary for the `EphemerisCoverageLimited` warning, emitted once
/// per run when a provider was actually consulted.
///
/// For the composite the summary is the *intersection* of its members' windows, which
/// is the only window every body is available in.
pub fn coverage_summary(name: &str) -> Option<String> {
    if name == AUTO_PROVIDER_NAME {
        let all = providers();
        let start = all.iter().map(|p| p.coverage.start_utc.clone()).max()?;
        let end = all.iter().map(|p| p.coverage.end_utc.clone()).min()?;
        let worst = all
            .iter()
            .map(|p| p.coverage.accuracy_arcmin)
            .fold(0.0f64, f64::max);
        return Some(format!(
            "{start} .. {end} for every body, documented to {worst} arcminutes"
        ));
    }
    providers().into_iter().find(|p| p.name == name).map(|p| {
        format!(
            "{} .. {}, documented to {} arcminutes",
            p.coverage.start_utc, p.coverage.end_utc, p.coverage.accuracy_arcmin
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_bodies_lead_with_the_sun_and_include_the_catalogue() {
        let b = known_bodies();
        assert_eq!(b[0], "Sun");
        assert!(b.contains(&"Vega"), "catalogue names are missing");
        assert!(b.contains(&"Polaris"), "Polaris is missing");
        assert_eq!(b.len(), catalog::names().len() + 1);
    }

    #[test]
    fn supplied_only_names_itself_supplied() {
        assert_eq!(
            direction_source(EphemerisChoice::Supplied).name(),
            skyfix_core::reduce::SUPPLIED_DIRECTION_SOURCE
        );
    }

    #[test]
    fn auto_is_the_composite() {
        assert_eq!(
            direction_source(EphemerisChoice::Auto).name(),
            AUTO_PROVIDER_NAME
        );
        assert_eq!(
            auto_provider().provider_names(),
            vec![SunProvider::NAME, skyfix_ephemeris::stars::PROVIDER_NAME]
        );
    }

    #[test]
    fn auto_answers_for_the_sun_and_for_stars() {
        let s = direction_source(EphemerisChoice::Auto);
        let jd = skyfix_core::time::parse_utc("2026-10-01T01:30:00Z").unwrap();
        let sun = s.direction("Sun", jd).expect("the Sun provider is merged");
        assert!(sun.semidiameter_arcmin > 15.0, "{sun:?}");
        let vega = s
            .direction("Vega", jd)
            .expect("the star provider is merged");
        assert_eq!(vega.semidiameter_arcmin, 0.0);
        assert!(s.direction("Betelgeuse Minor", jd).is_err());
    }

    #[test]
    fn every_body_resolves_to_the_provider_that_declares_it() {
        assert_eq!(
            provider_for("Sun").describe(),
            skyfix_ephemeris::sun::SunProvider::NAME
        );
        assert_eq!(
            provider_for("Vega").describe(),
            skyfix_ephemeris::stars::PROVIDER_NAME
        );
        // HIP 91262 is Vega; no provider lists HIP names, so the catalogue resolves it.
        assert_eq!(
            provider_for("HIP 91262").describe(),
            skyfix_ephemeris::stars::PROVIDER_NAME
        );
        assert!(!provider_for("Deimos").is_available());
    }

    #[test]
    fn every_known_body_is_answerable_in_this_build() {
        for body in known_bodies() {
            assert!(
                provider_for(body).is_available(),
                "{body} is accepted by the validator but nothing can compute it"
            );
        }
    }

    #[test]
    fn the_auto_coverage_summary_is_the_intersection() {
        let s = coverage_summary(AUTO_PROVIDER_NAME).expect("auto is summarised");
        assert!(s.contains("1990-01-01"), "{s}");
        assert!(s.contains("every body"), "{s}");
        assert!(coverage_summary("nothing like this").is_none());
    }
}
