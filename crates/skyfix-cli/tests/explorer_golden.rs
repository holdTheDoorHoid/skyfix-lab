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
    (
        "phases_2026_09_zone.txt",
        &[
            "phases",
            "--from",
            "2026-09-01",
            "--to",
            "2026-09-30",
            "--zone",
            "-04:00",
        ],
    ),
    // Eclipses: the listing and two local reports, pinned to NASA's canon, USNO and
    // Skyfield in skyfix-almanac (docs/ACCURACY.md section 12).
    (
        "eclipses_2024_2026_dallas.txt",
        &[
            "eclipses",
            "--from",
            "2024-01-01",
            "--to",
            "2026-12-31",
            "--lat",
            "32.78",
            "--lon",
            "-96.80",
        ],
    ),
    (
        "eclipse_2024_04_08_dallas.txt",
        &[
            "eclipse",
            "2024-04-08-solar",
            "--lat",
            "32.78",
            "--lon",
            "-96.80",
        ],
    ),
    (
        "eclipse_2025_03_14_london.txt",
        &[
            "eclipse",
            "2025-03-14-lunar",
            "--lat",
            "51.5074",
            "--lon",
            "-0.1278",
        ],
    ),
    (
        "planet_events_2026.txt",
        &[
            "planet-events",
            "--from",
            "2026-01-01",
            "--to",
            "2026-12-31",
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

/// The worked examples in docs/CLI.md's explorer chapter are real output. Every
/// `$ skyfix ...` line there is run, and every quoted line after it must appear in the
/// command's stdout, in order. `...` on a line of its own marks lines left out; a line
/// ending in ` ...` is quoted only up to there.
#[test]
fn the_documented_explorer_examples_are_real_output() {
    let doc = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/CLI.md"),
    )
    .expect("docs/CLI.md");
    let start = doc
        .find("## The sky, almanac events and the navigation methods")
        .expect("the explorer chapter");
    let end = start
        + doc[start..]
            .find("## Other things worth running")
            .expect("the next chapter");
    let chapter = &doc[start..end];
    let data = data_dir().to_string_lossy().into_owned();

    let mut examples = 0;
    let mut in_block = false;
    let mut lines = chapter.lines();
    // (command, expected lines) pairs, gathered block by block.
    let mut cases: Vec<(String, Vec<String>)> = Vec::new();
    while let Some(line) = lines.next() {
        if line.starts_with("```console") {
            in_block = true;
            continue;
        }
        if in_block && line.starts_with("```") {
            in_block = false;
            continue;
        }
        if !in_block {
            continue;
        }
        if let Some(cmd) = line.strip_prefix("$ ") {
            let mut cmd = cmd.to_string();
            while cmd.ends_with('\\') {
                cmd.pop();
                cmd.push_str(lines.next().expect("a continued command").trim());
                cmd.push(' ');
            }
            cases.push((cmd, Vec::new()));
        } else if let Some((_, expected)) = cases.last_mut() {
            expected.push(line.to_string());
        }
    }
    for (cmd, expected) in cases {
        let args: Vec<String> = cmd
            .split_whitespace()
            .skip(1) // "skyfix"
            .map(|a| a.replace("$D", &data))
            .collect();
        let run = skyfix(&args).expect_code(0);
        let mut got = run.stdout.lines();
        for want in expected {
            if want.trim() == "..." {
                continue;
            }
            let want = want.strip_suffix(" ...").unwrap_or(&want).trim_end();
            assert!(
                got.any(|g| g.starts_with(want)),
                "docs/CLI.md: `{cmd}` no longer prints {want:?} (in this order)\n\
                 --- stdout ---\n{}",
                run.stdout
            );
        }
        examples += 1;
    }
    assert!(
        examples >= 10,
        "only {examples} examples were found and checked"
    );
}
