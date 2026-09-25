//! Coverage tiers for the explorer: `explorer_coverage` and `tier_at`.
//!
//! OWNER: deeptime agent (expansion programme). Wire format: docs/EXPLORER_API.md,
//! "`explorer_coverage()` — tiers" and "Coverage tiers as built (deeptime agent)";
//! definitions: CONVENTIONS 15.1 and `skyfix_ephemeris::tiers`.
//!
//! Both tiers ship in the core module: the validated tier (1550-01-01 to 2650-01-22),
//! where the accuracy figures of docs/ACCURACY.md hold and bodies are offered for sights,
//! and the labelled tier (2000 BC to AD 3000), display only, measured per century
//! against JPL DE441. The `deep-time` pack of the original plan was not needed (the
//! two-tier series set is smaller than the one-tier JSON it replaced), so nothing here
//! depends on a pack being loaded; `packs_loaded` still reports what the packs
//! dispatcher holds, for the interface.

use wasm_bindgen::prelude::*;

use crate::to_js;

/// The native layer: plain Rust, tested without a browser.
pub mod native {
    use serde::{Deserialize, Serialize};
    use skyfix_core::time::parse_utc;
    use skyfix_ephemeris::moon::MoonProvider;
    use skyfix_ephemeris::planets::PlanetProvider;
    use skyfix_ephemeris::stars::StarProvider;
    use skyfix_ephemeris::sun::SunProvider;
    use skyfix_ephemeris::tiers::{self, CoverageTier, TierPolicy};
    use skyfix_ephemeris::{AstroProvider, Coverage};

    /// One provider group of `explorer_coverage`.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct CoverageGroup {
        pub name: String,
        pub provider: String,
        /// The provider's documented accuracy over the validated tier; `null` when it
        /// declares none.
        pub accuracy_arcmin: Option<f64>,
        /// `accuracy_arcmin` is finite and at most 0.1' (CONVENTIONS 13.7): only then is
        /// the group offered for sights (in the validated tier).
        pub validated: bool,
        pub notes: String,
        /// Canonical names of the bodies this group covers.
        pub bodies: Vec<String>,
        /// The validated tier, then the labelled one, each with its measured accuracy.
        pub tiers: Vec<CoverageTier>,
    }

    /// `explorer_coverage` result.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct ExplorerCoverage {
        /// The outermost instants every group answers: the labelled tier's bounds,
        /// since both tiers are in the core module.
        pub start_utc: String,
        pub end_utc: String,
        /// The validated tier (CONVENTIONS 15.1).
        pub validated_start_utc: String,
        pub validated_end_utc: String,
        /// Names of the data packs loaded in this page session.
        pub packs_loaded: Vec<String>,
        pub groups: Vec<CoverageGroup>,
    }

    /// The largest `accuracy_arcmin` a group may declare and still be offered for
    /// sights: the 0.1' target of CONVENTIONS 13.7.
    pub const VALIDATED_ACCURACY_ARCMIN: f64 = 0.1;

    fn group(name: &str, provider: &str, c: Coverage, tiers: Vec<CoverageTier>) -> CoverageGroup {
        let a = c.accuracy_arcmin;
        CoverageGroup {
            name: name.to_string(),
            provider: provider.to_string(),
            accuracy_arcmin: a.is_finite().then_some(a),
            validated: a.is_finite() && a <= VALIDATED_ACCURACY_ARCMIN,
            notes: c.notes,
            bodies: c.bodies,
            tiers,
        }
    }

    /// The explorer's coverage: every group with both tiers (the display path answers
    /// the labelled tier; navigation paths refuse it).
    pub fn explorer_coverage() -> ExplorerCoverage {
        let policy = TierPolicy::WithLabelled;
        let sun = SunProvider::new().with_policy(policy);
        let moon = MoonProvider::new().with_policy(policy);
        let planets = PlanetProvider::new().with_policy(policy);
        let stars = StarProvider::new().with_policy(policy);
        let parts = [
            ("Sun", sun.name().to_string(), sun.coverage(), sun.tiers()),
            (
                "Moon",
                moon.name().to_string(),
                moon.coverage(),
                moon.tiers(),
            ),
            (
                "Planets",
                planets.name().to_string(),
                planets.coverage(),
                planets.tiers(),
            ),
            (
                "Stars",
                stars.name().to_string(),
                stars.coverage(),
                stars.tiers(),
            ),
        ];
        // The intersection of the groups' ranges; a range that does not parse is ignored.
        let mut start: Option<(f64, String)> = None;
        let mut end: Option<(f64, String)> = None;
        for (_, _, c, _) in &parts {
            if let Ok(s) = parse_utc(&c.start_utc)
                && start.as_ref().is_none_or(|(v, _)| s > *v)
            {
                start = Some((s, c.start_utc.clone()));
            }
            if let Ok(e) = parse_utc(&c.end_utc)
                && end.as_ref().is_none_or(|(v, _)| e < *v)
            {
                end = Some((e, c.end_utc.clone()));
            }
        }
        ExplorerCoverage {
            start_utc: start.map(|s| s.1).unwrap_or_default(),
            end_utc: end.map(|e| e.1).unwrap_or_default(),
            validated_start_utc: tiers::VALIDATED_START_UTC.to_string(),
            validated_end_utc: tiers::VALIDATED_END_UTC.to_string(),
            packs_loaded: crate::packs::loaded_names(),
            groups: parts
                .into_iter()
                .map(|(n, p, c, t)| group(n, &p, c, t))
                .collect(),
        }
    }

    /// The coverage tier of an instant on the app's clock: `"validated"`,
    /// `"labelled"` or `"outside"` (NaN is outside).
    pub fn tier_at(jd_utc: f64) -> &'static str {
        tiers::tier_at(jd_utc).as_str()
    }
}

/// The coverage tier of `jd_utc` (EXPLORER_API "`explorer_coverage()` — tiers"):
/// `"validated"` (1550-01-01 to 2650-01-22), `"labelled"` (2000 BC to AD 3000, display
/// only) or `"outside"`.
#[wasm_bindgen]
pub fn tier_at(jd_utc: f64) -> String {
    native::tier_at(jd_utc).to_string()
}

/// `explorer_coverage` with the tiers, as a JS value (the export lives in
/// `explorer.rs`, which calls [`native::explorer_coverage`]).
pub fn explorer_coverage_js() -> Result<JsValue, JsValue> {
    to_js(&native::explorer_coverage())
}

#[cfg(test)]
mod tests {
    use super::native::*;
    use skyfix_core::time::parse_utc;
    use skyfix_ephemeris::tiers::{self, Tier};

    #[test]
    fn coverage_reports_both_tiers_and_validates_the_validated_one() {
        let c = explorer_coverage();
        assert_eq!(c.start_utc, tiers::LABELLED_START_UTC);
        assert_eq!(c.end_utc, tiers::LABELLED_END_UTC);
        assert_eq!(c.validated_start_utc, "1550-01-01T00:00:00Z");
        assert_eq!(c.validated_end_utc, "2650-01-22T00:00:00Z");
        assert_eq!(c.groups.len(), 4);
        for g in &c.groups {
            assert!(g.validated, "{}", g.name);
            assert_eq!(g.tiers.len(), 2, "{}", g.name);
            assert_eq!(g.tiers[0].tier, Tier::Validated);
            assert_eq!(g.tiers[0].accuracy_arcmin, g.accuracy_arcmin);
            assert_eq!(g.tiers[1].tier, Tier::Labelled);
            let (v, l) = (
                g.tiers[0].accuracy_arcmin.unwrap(),
                g.tiers[1].accuracy_arcmin.unwrap(),
            );
            assert!(l >= v && l <= 1.0, "{}: {v} {l}", g.name);
            assert!(g.tiers[1].notes.as_deref().unwrap().contains("Delta T"));
        }
        // The wire names of the contract.
        let v = serde_json::to_value(&c).unwrap();
        for key in [
            "start_utc",
            "end_utc",
            "validated_start_utc",
            "validated_end_utc",
            "packs_loaded",
        ] {
            assert!(v.get(key).is_some(), "{key}");
        }
        assert_eq!(v["groups"][1]["tiers"][1]["tier"], "labelled");
        assert!(v["groups"][0]["tiers"][0].get("notes").is_none());
    }

    #[test]
    fn tier_at_splits_the_line_where_the_contract_says() {
        let at = |s: &str| tier_at(parse_utc(s).unwrap());
        assert_eq!(at("2026-10-01T01:30:00Z"), "validated");
        assert_eq!(at("1550-01-01T00:00:00Z"), "validated");
        assert_eq!(at("2650-01-22T00:00:00Z"), "validated");
        assert_eq!(at("1549-12-31T23:59:59Z"), "labelled");
        assert_eq!(at("2650-01-22T00:00:01Z"), "labelled");
        assert_eq!(at("-0584-05-28T12:00:00Z"), "labelled");
        assert_eq!(at("-2000-01-01T00:00:00Z"), "labelled");
        assert_eq!(at("3000-12-31T23:59:59Z"), "labelled");
        assert_eq!(at("-2001-12-31T23:59:59Z"), "outside");
        assert_eq!(at("3001-01-01T00:00:00Z"), "outside");
        assert_eq!(tier_at(f64::NAN), "outside");
    }
}
