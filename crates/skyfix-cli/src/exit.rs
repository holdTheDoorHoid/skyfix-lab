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
}
