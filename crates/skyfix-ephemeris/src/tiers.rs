//! Coverage tiers (CONVENTIONS section 15.1): which dates a provider answers for and
//! how far its numbers can be trusted there.
//!
//! OWNER: deeptime agent (expansion programme).
//!
//! - **validated**, 1550-01-01 to 2650-01-22, the span of JPL DE440: the accuracy
//!   figures in `docs/ACCURACY.md` hold, backed by fixture tests; bodies are offered
//!   for sights.
//! - **labelled**, -2000-01-01 to 3000-12-31 (proleptic Gregorian, astronomical year
//!   numbering): positions are computed with the same series (their longer prefix), the
//!   long-term precession and the corrections fitted to DE441; their accuracy is
//!   measured per century and tabulated ("Historical accuracy"), and every time shown
//!   there carries the Delta T uncertainty. Display only: no sights, no planner, no
//!   predicted readings.
//! - **outside**: refused.
//!
//! Both tiers ship in the core module (the `deep-time` pack of the original plan turned
//! out unnecessary: the whole two-tier series set is 257 KB raw, smaller than the JSON
//! it replaces). A provider built with [`TierPolicy::ValidatedOnly`] (every `new()`)
//! refuses the labelled tier exactly as it used to refuse dates outside 1990-2060, so
//! every navigation path keeps its guarantees; the explorer's display path builds its
//! providers with [`TierPolicy::WithLabelled`].
//!
//! Two clocks meet here. The *tier* of an instant is decided on the app's clock
//! (`jd_utc`, UTC or UT per CONVENTIONS 15.2). The *model switches* (the longer series
//! prefix, the long-term precession, the planet-correction blend) are keyed on TT at the
//! same Julian dates, so they fall a few minutes (1550) to about half an hour (2650) of
//! Delta T away from the tier edges; each switch moves a position by far less than the
//! tier's accuracy (the largest, the precession model, by 7 mas at 1550 and 15 mas at
//! 2650).

use serde::{Deserialize, Serialize};

use crate::EphemerisError;

/// First instant of the validated tier: 1550-01-01T00:00:00Z.
pub const VALIDATED_START_UTC: &str = "1550-01-01T00:00:00Z";
/// Last instant of the validated tier: 2650-01-22T00:00:00Z (DE440 ends three days
/// later, which leaves room for light-time).
pub const VALIDATED_END_UTC: &str = "2650-01-22T00:00:00Z";
/// First instant of the labelled tier, 2001 BC January 1 (proleptic Gregorian).
pub const LABELLED_START_UTC: &str = "-2000-01-01T00:00:00Z";
/// Last instant of the labelled tier.
pub const LABELLED_END_UTC: &str = "3000-12-31T23:59:59Z";

/// [`VALIDATED_START_UTC`] as a Julian date.
pub const JD_VALIDATED_START: f64 = 2_287_185.5;
/// [`VALIDATED_END_UTC`] as a Julian date.
pub const JD_VALIDATED_END: f64 = 2_688_973.5;
/// [`LABELLED_START_UTC`] as a Julian date.
pub const JD_LABELLED_START: f64 = 990_574.5;
/// [`LABELLED_END_UTC`] as a Julian date (one second before 3001-01-01T00:00Z).
pub const JD_LABELLED_END: f64 = 2_817_152.5 - 1.0 / 86_400.0;

/// The tier of an instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Validated,
    Labelled,
    Outside,
}

impl Tier {
    /// `"validated"`, `"labelled"` or `"outside"`, the wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Validated => "validated",
            Tier::Labelled => "labelled",
            Tier::Outside => "outside",
        }
    }
}

/// The tier of `jd_utc` (the app's clock). NaN is outside.
pub fn tier_at(jd_utc: f64) -> Tier {
    if (JD_VALIDATED_START..=JD_VALIDATED_END).contains(&jd_utc) {
        Tier::Validated
    } else if (JD_LABELLED_START..=JD_LABELLED_END).contains(&jd_utc) {
        Tier::Labelled
    } else {
        Tier::Outside
    }
}

/// True when the model should use its validated-tier form at `jd_tt` (Terrestrial
/// Time): the shorter series prefix, IAU 2006 precession, the DE440 corrections.
pub fn validated_model_at_tt(jd_tt: f64) -> bool {
    (JD_VALIDATED_START..=JD_VALIDATED_END).contains(&jd_tt)
}

/// Which tiers a provider instance answers for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TierPolicy {
    /// The validated tier only: the default, and what every navigation path uses.
    #[default]
    ValidatedOnly,
    /// The validated and the labelled tier: the explorer's display path.
    WithLabelled,
}

impl TierPolicy {
    /// The first instant answered.
    pub fn start_utc(self) -> &'static str {
        match self {
            TierPolicy::ValidatedOnly => VALIDATED_START_UTC,
            TierPolicy::WithLabelled => LABELLED_START_UTC,
        }
    }

    /// The last instant answered.
    pub fn end_utc(self) -> &'static str {
        match self {
            TierPolicy::ValidatedOnly => VALIDATED_END_UTC,
            TierPolicy::WithLabelled => LABELLED_END_UTC,
        }
    }

    /// `(first, last)` Julian dates answered.
    pub fn jd_range(self) -> (f64, f64) {
        match self {
            TierPolicy::ValidatedOnly => (JD_VALIDATED_START, JD_VALIDATED_END),
            TierPolicy::WithLabelled => (JD_LABELLED_START, JD_LABELLED_END),
        }
    }

    /// Refuse `jd_utc` unless this policy answers it; the tier otherwise.
    pub fn check(self, provider: &str, jd_utc: f64) -> Result<Tier, EphemerisError> {
        if !jd_utc.is_finite() {
            return Err(EphemerisError::Data(
                "jd_utc is not a finite Julian date".to_string(),
            ));
        }
        let (lo, hi) = self.jd_range();
        if jd_utc < lo || jd_utc > hi {
            return Err(EphemerisError::OutOfCoverage {
                provider: provider.to_string(),
                jd_utc,
                coverage: format!("{} .. {}", self.start_utc(), self.end_utc()),
            });
        }
        Ok(tier_at(jd_utc))
    }
}

/// One tier of a provider group's coverage (EXPLORER_API "explorer_coverage() —
/// tiers"): the span, the worst error measured over it and, for the labelled tier, a
/// note on what else applies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CoverageTier {
    pub tier: Tier,
    pub start_utc: String,
    pub end_utc: String,
    /// Worst direction error measured over the span against JPL DE440 (validated) or
    /// DE441 (labelled), arcminutes; `None` when not measured.
    pub accuracy_arcmin: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// The two tiers of a provider that answers both, with its measured accuracies.
pub fn coverage_tiers(
    policy: TierPolicy,
    validated_arcmin: f64,
    labelled_arcmin: f64,
    labelled_notes: &str,
) -> Vec<CoverageTier> {
    let mut v = vec![CoverageTier {
        tier: Tier::Validated,
        start_utc: VALIDATED_START_UTC.to_string(),
        end_utc: VALIDATED_END_UTC.to_string(),
        accuracy_arcmin: Some(validated_arcmin),
        notes: None,
    }];
    if policy == TierPolicy::WithLabelled {
        v.push(CoverageTier {
            tier: Tier::Labelled,
            start_utc: LABELLED_START_UTC.to_string(),
            end_utc: LABELLED_END_UTC.to_string(),
            accuracy_arcmin: Some(labelled_arcmin),
            notes: Some(labelled_notes.to_string()),
        });
    }
    v
}

/// The note every labelled tier carries.
pub const LABELLED_NOTE: &str = "outside the validated tier: accuracy measured per century \
     against JPL DE441 (docs/ACCURACY.md, \"Historical accuracy\"); every time shown carries \
     the Delta T uncertainty; display only, not offered for sights";

#[cfg(test)]
mod tests {
    use super::*;
    use skyfix_core::time::civil_to_jd;

    #[test]
    fn the_constants_are_the_dates_they_name() {
        assert_eq!(civil_to_jd(1550, 1, 1), JD_VALIDATED_START);
        assert_eq!(civil_to_jd(2650, 1, 22), JD_VALIDATED_END);
        assert_eq!(civil_to_jd(-2000, 1, 1), JD_LABELLED_START);
        assert_eq!(
            civil_to_jd(3000, 12, 31) + 86_399.0 / 86_400.0,
            JD_LABELLED_END
        );
    }

    #[test]
    fn tiers_split_the_line() {
        assert_eq!(tier_at(2_461_310.5), Tier::Validated);
        assert_eq!(tier_at(JD_VALIDATED_START), Tier::Validated);
        assert_eq!(tier_at(JD_VALIDATED_END), Tier::Validated);
        assert_eq!(tier_at(JD_VALIDATED_START - 1e-6), Tier::Labelled);
        assert_eq!(tier_at(JD_VALIDATED_END + 1e-6), Tier::Labelled);
        assert_eq!(tier_at(JD_LABELLED_START), Tier::Labelled);
        assert_eq!(tier_at(JD_LABELLED_END), Tier::Labelled);
        assert_eq!(tier_at(JD_LABELLED_START - 1e-6), Tier::Outside);
        assert_eq!(tier_at(JD_LABELLED_END + 1e-6), Tier::Outside);
        assert_eq!(tier_at(f64::NAN), Tier::Outside);
        assert_eq!(
            serde_json::to_string(&Tier::Labelled).unwrap(),
            "\"labelled\""
        );
    }

    #[test]
    fn policies_refuse_what_they_do_not_answer() {
        let v = TierPolicy::ValidatedOnly;
        let l = TierPolicy::WithLabelled;
        assert_eq!(v.check("p", 2_461_310.5).unwrap(), Tier::Validated);
        assert!(matches!(
            v.check("p", JD_VALIDATED_START - 1.0),
            Err(EphemerisError::OutOfCoverage { .. })
        ));
        assert_eq!(
            l.check("p", JD_VALIDATED_START - 1.0).unwrap(),
            Tier::Labelled
        );
        assert!(matches!(
            l.check("p", JD_LABELLED_START - 1.0),
            Err(EphemerisError::OutOfCoverage { .. })
        ));
        assert!(matches!(
            l.check("p", f64::NAN),
            Err(EphemerisError::Data(_))
        ));
        assert_eq!(TierPolicy::default(), TierPolicy::ValidatedOnly);
        assert_eq!(coverage_tiers(v, 0.01, 0.1, "n").len(), 1);
        let t = coverage_tiers(l, 0.01, 0.1, "n");
        assert_eq!(t.len(), 2);
        assert_eq!(t[1].tier, Tier::Labelled);
        assert_eq!(t[1].start_utc, LABELLED_START_UTC);
    }
}
