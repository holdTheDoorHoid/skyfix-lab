//! Finding a scenario, for `simulate`, `experiment` and `demos`. OWNER: cli agent.
//!
//! `skyfix_sim::demos::all()` returns the eight scenarios that need no astronomy
//! provider. Two more are packaged — `philadelphia-stars-real`, which needs one, and
//! `philadelphia-stars-sextant`, which emits raw sextant readings — and
//! `docs/SIMULATOR.md` section 8 lists all ten. [`all`] here puts the missing two back,
//! beside the demo they are variants of, so `skyfix demos` matches the documentation.
//!
//! [`by_name`] defers to `skyfix_sim::demos::by_name` (which now reaches all ten) and
//! falls back to this listing, so the two can never disagree about what exists.

use std::path::Path;

use anyhow::{Context, Result, bail};
use skyfix_sim::demos;
use skyfix_sim::scenario::Scenario;

/// Every packaged scenario in demo order, including the two that `demos::all()` leaves
/// out because they need a provider or emit raw sextant readings.
pub fn all() -> Vec<Scenario> {
    let mut v = demos::all();
    // Demo 1 has three forms; keep them together, after the plain one.
    let named = demos::philadelphia_stars_named();
    let sextant = demos::philadelphia_stars_sextant();
    let at = v
        .iter()
        .position(|s| s.name == "philadelphia-stars")
        .map(|i| i + 1)
        .unwrap_or(v.len());
    v.insert(at, sextant);
    v.insert(at, named);
    v
}

/// Look a packaged scenario up by name.
pub fn by_name(name: &str) -> Option<Scenario> {
    demos::by_name(name).or_else(|| all().into_iter().find(|s| s.name == name))
}

/// Resolve `--demo NAME` or `--scenario FILE` into a scenario, refusing both and
/// neither.
pub fn resolve(demo: Option<&str>, scenario: Option<&Path>) -> Result<Scenario> {
    match (demo, scenario) {
        (Some(name), None) => by_name(name).ok_or_else(|| {
            anyhow::anyhow!(
                "no packaged demo called {name:?}. Run `skyfix demos` for the list: {}",
                all()
                    .iter()
                    .map(|s| s.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }),
        (None, Some(path)) => {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("cannot read {}", path.display()))?;
            let s: Scenario = serde_json::from_str(&text)
                .with_context(|| format!("{} is not a scenario document", path.display()))?;
            s.check()
                .map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))?;
            Ok(s)
        }
        (Some(_), Some(_)) => bail!("give --demo or --scenario, not both"),
        (None, None) => {
            bail!("give --demo NAME or --scenario FILE. `skyfix demos` lists the packaged demos.")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_ten_packaged_scenarios_are_reachable_by_name() {
        let names: Vec<String> = all().into_iter().map(|s| s.name).collect();
        assert_eq!(names.len(), 10, "{names:?}");
        for n in &names {
            assert!(by_name(n).is_some(), "{n} is listed but not findable");
        }
        assert!(names.contains(&"philadelphia-stars-sextant".to_string()));
        assert!(names.contains(&"philadelphia-stars-real".to_string()));
    }

    #[test]
    fn the_three_forms_of_demo_one_stay_together() {
        let names: Vec<String> = all().into_iter().map(|s| s.name).collect();
        let i = names
            .iter()
            .position(|n| n == "philadelphia-stars")
            .expect("demo 1");
        assert_eq!(names[i + 1], "philadelphia-stars-real");
        assert_eq!(names[i + 2], "philadelphia-stars-sextant");
    }

    #[test]
    fn resolve_refuses_both_and_neither() {
        assert!(resolve(None, None).is_err());
        assert!(resolve(Some("philadelphia-stars"), Some(Path::new("x.json"))).is_err());
        assert!(resolve(Some("no-such-demo"), None).is_err());
        assert!(resolve(Some("philadelphia-stars"), None).is_ok());
    }
}
