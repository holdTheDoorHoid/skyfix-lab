//! Golden text reports of the explorer commands. OWNER: cli agent.
//!
//! The text a navigator reads is a contract too: column layout, degrees and decimal
//! minutes, UTC with `Z`, the sentences that say what a number is and is not. Each case
//! below runs the real binary and compares its stdout, byte for byte, with a committed
//! file under `tests/golden/`, so a change to any report shows up as a diff in review.
//!
//! The cases use noise-free inputs whose numbers are pinned to independent references
//! elsewhere (Skyfield, USNO, Bowditch), and the text formatters never print a sign on a
//! value that rounds to zero, so floating-point noise cannot flip a character.
//!
//! After a deliberate change to a report, regenerate and review the diff:
//!
//! ```text
//! SKYFIX_WRITE_GOLDEN=1 cargo test -p skyfix-cli --test explorer_golden
//! ```

mod support;

use std::path::PathBuf;

use support::{data_dir, skyfix};

/// `(golden file, arguments)`. `$D` is replaced by the test data directory.
const CASES: &[(&str, &[&str])] = &[
    ("seasons_2026.txt", &["seasons", "--year", "2026"]),
    (
        "phases_2026_09.txt",
        &["phases", "--from", "2026-09-01", "--to", "2026-09-30"],
    ),
    (
        "sky_philadelphia.txt",
        &[
            "sky",
            "--lat",
            "39.9526",
            "--lon",
            "-75.1652",
            "--utc",
            "2026-10-01T01:30:00Z",
            "--bodies",
            "solar_system,Vega,Polaris,Sirius",
        ],
    ),
    (
        "events_philadelphia.txt",
        &[
            "events",
            "--lat",
            "39.9526",
            "--lon",
            "-75.1652",
            "--date",
            "2026-09-24",
            "--zone",
            "-04:00",
        ],
    ),
    (
        "predict_moon.txt",
        &[
            "predict",
            "--lat",
            "39.9526",
            "--lon",
            "-75.1652",
            "--utc",
            "2026-10-01T03:00:00Z",
            "--body",
            "Moon",
            "--limb",
            "lower",
            "--height-of-eye",
            "2.5",
            "--ic",
            "-2.0",
        ],
    ),
    (
        "noon_bowditch_1910.txt",
        &[
            "noon",
            "$D/noon_bowditch_1910.session.json",
            "--vessel",
            "45,10",
        ],
    ),
    (
        "polaris_bowditch_1912.txt",
        &[
            "polaris",
            "$D/polaris_bowditch_1912.session.json",
            "--dr",
            "40.766666667,-43.366666667,10",
        ],
    ),
];

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden")
}

#[test]
fn text_reports_match_their_golden_files() {
    let write = std::env::var("SKYFIX_WRITE_GOLDEN").is_ok();
    let data = data_dir().to_string_lossy().into_owned();
    let mut failures = Vec::new();
    for (name, args) in CASES {
        let args: Vec<String> = args.iter().map(|a| a.replace("$D", &data)).collect();
        let run = skyfix(&args).expect_code(0);
        let path = golden_dir().join(name);
        if write {
            std::fs::create_dir_all(golden_dir()).expect("tests/golden is writable");
            std::fs::write(&path, &run.stdout).expect("tests/golden is writable");
            continue;
        }
        let want = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "cannot read {}: {e}. Generate it with SKYFIX_WRITE_GOLDEN=1 cargo test -p \
                 skyfix-cli --test explorer_golden",
                path.display()
            )
        });
        if run.stdout != want {
            let line = want
                .lines()
                .zip(run.stdout.lines())
                .position(|(a, b)| a != b)
                .unwrap_or_else(|| want.lines().count().min(run.stdout.lines().count()));
            failures.push(format!(
                "{name}: first difference at line {}\n  golden: {:?}\n  now:    {:?}",
                line + 1,
                want.lines().nth(line).unwrap_or("<end>"),
                run.stdout.lines().nth(line).unwrap_or("<end>")
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "text reports changed (regenerate with SKYFIX_WRITE_GOLDEN=1 if on purpose):\n{}",
        failures.join("\n")
    );
}
