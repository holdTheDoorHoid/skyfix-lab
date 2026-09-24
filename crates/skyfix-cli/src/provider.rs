//! Choosing an astronomy provider. OWNER: cli agent.
//!
//! Everything here is written against [`AstroProvider`] and
//! [`skyfix_core::reduce::DirectionSource`], never against a concrete provider type, so
//! that the providers still to be merged (`skyfix_ephemeris::sun::SunProvider` and the
//! composite/fixture-pack providers) are wired in by editing [`providers`] and
//! [`auto_source`] and nothing else.
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

use skyfix_core::reduce::{DirectionSource, SuppliedOnly};
use skyfix_ephemeris::stars::StarProvider;
use skyfix_ephemeris::{AstroProvider, Coverage, ProviderSource, catalog};

/// `--ephemeris` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
pub enum EphemerisChoice {
    /// Use a supplied `geocentric` block when the observation has one, otherwise the
    /// best provider in this build.
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

/// The direction source for a reduction.
///
/// A supplied `geocentric` block always wins over a provider — that rule lives in
/// `skyfix_core::reduce::reduce_observation`, not here — so `auto` differs from
/// `supplied` only in what happens when a block is absent.
pub fn direction_source(choice: EphemerisChoice) -> Box<dyn DirectionSource> {
    match choice {
        EphemerisChoice::Auto => auto_source(),
        EphemerisChoice::Supplied => Box::new(SuppliedOnly),
    }
}

/// The best provider this build has.
///
/// WIRING POINT: when `SunProvider` and the composite provider are merged this becomes
/// `Box::new(ProviderSource(CompositeProvider::new(...)))` and nothing else in the CLI
/// changes.
fn auto_source() -> Box<dyn DirectionSource> {
    Box::new(ProviderSource(StarProvider::new()))
}

/// A provider and its self-declared coverage, for `skyfix coverage`.
pub struct ProviderInfo {
    pub name: String,
    pub coverage: Coverage,
}

/// Every provider compiled into this build, best first.
///
/// WIRING POINT: push `SunProvider` and any fixture pack here as they are merged.
pub fn providers() -> Vec<ProviderInfo> {
    let star = StarProvider::new();
    vec![ProviderInfo {
        name: star.name().to_string(),
        coverage: star.coverage(),
    }]
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
/// WIRING POINT: the `Sun` arm becomes `SunProvider::name()` once that provider is
/// merged.
pub fn provider_for(body: &str) -> BodyProvider {
    if skyfix_core::reduce::is_sun(body) {
        return BodyProvider::Missing(
            "no Sun provider in this build; supply a geocentric block for Sun sights".to_string(),
        );
    }
    let star = StarProvider::new();
    if catalog::find(body).is_some() {
        BodyProvider::Available(star.name().to_string())
    } else {
        BodyProvider::Missing("not in the star catalogue".to_string())
    }
}

/// A one-line coverage summary for the `EphemerisCoverageLimited` warning, emitted once
/// per run when a provider was actually consulted.
pub fn coverage_summary(name: &str) -> Option<String> {
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
    fn auto_uses_the_star_provider_in_this_build() {
        assert_eq!(
            direction_source(EphemerisChoice::Auto).name(),
            skyfix_ephemeris::stars::PROVIDER_NAME
        );
    }

    #[test]
    fn stars_resolve_and_the_sun_says_why_it_does_not() {
        assert!(provider_for("Vega").is_available());
        assert!(provider_for("HIP 91262").is_available());
        let sun = provider_for("Sun");
        assert!(!sun.is_available());
        assert!(sun.describe().contains("geocentric"), "{}", sun.describe());
    }

    #[test]
    fn coverage_summary_is_found_by_provider_name() {
        let s = coverage_summary(skyfix_ephemeris::stars::PROVIDER_NAME)
            .expect("the star provider must be listed");
        assert!(s.contains("1990-01-01"), "{s}");
        assert!(s.contains("arcminutes"), "{s}");
        assert!(coverage_summary("nothing like this").is_none());
    }
}
