//! Exit codes. OWNER: cli agent.
//!
//! Documented in `docs/CLI.md`; scripts depend on them, so they never change meaning.
//! Codes compose by taking the largest one a run earned, so a session with a rejected
//! sight that also fails to solve reports the solve failure (3), not the rejection (2).

/// Everything asked for was done.
pub const OK: u8 = 0;
/// Bad command line, unreadable file, unparseable session, or a validation error.
pub const USAGE: u8 = 1;
/// One or more sights were rejected; whatever could be reduced was still printed.
pub const SIGHTS_REJECTED: u8 = 2;
/// The solve failed, or `--require-unique` was given and the result was not unique.
pub const SOLVE_FAILED: u8 = 3;
/// The subcommand exists but is not wired up in this build.
///
/// Reserved, and currently unreachable: every subcommand has been wired since the
/// planner merge, so nothing returns this today. It is kept — and `docs/CLI.md` still
/// documents it — so that a subcommand landing ahead of its engine reuses this code
/// instead of inventing a sixth number, and so a script that already branches on 4 keeps
/// meaning what it meant.
#[allow(dead_code, reason = "reserved exit code; see the doc comment")]
pub const NOT_WIRED: u8 = 4;

/// The worse of two outcomes. Higher codes describe worse outcomes by construction.
pub fn worse(a: u8, b: u8) -> u8 {
    a.max(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worse_picks_the_higher_code() {
        assert_eq!(worse(OK, SIGHTS_REJECTED), SIGHTS_REJECTED);
        assert_eq!(worse(SIGHTS_REJECTED, SOLVE_FAILED), SOLVE_FAILED);
        assert_eq!(worse(OK, OK), OK);
    }

    /// The documented codes, in the documented order. `docs/CLI.md` prints this table,
    /// and scripts branch on it, so the numbers are a contract rather than an enum.
    #[test]
    fn the_codes_are_the_documented_ones() {
        assert_eq!(
            [OK, USAGE, SIGHTS_REJECTED, SOLVE_FAILED, NOT_WIRED],
            [0, 1, 2, 3, 4]
        );
        assert_eq!(worse(SIGHTS_REJECTED, NOT_WIRED), NOT_WIRED);
    }
}
