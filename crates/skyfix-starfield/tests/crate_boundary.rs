//! CONVENTIONS 13.6: the star field is display-only. No crate on the navigation path
//! may depend on it, so it can never become a direction source for `reduce`, `solve`,
//! the planner's navigation candidates or an accuracy claim.

#[test]
fn no_navigation_crate_depends_on_the_star_field() {
    for krate in [
        "skyfix-core",
        "skyfix-ephemeris",
        "skyfix-sim",
        "skyfix-almanac",
    ] {
        let path = format!("{}/../{krate}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
        let manifest = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert!(
            !manifest.contains("skyfix-starfield"),
            "{krate} must not depend on skyfix-starfield (CONVENTIONS 13.6)"
        );
    }
}
