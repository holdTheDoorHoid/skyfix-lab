//! `skyfix catalog` and `skyfix coverage`. OWNER: cli agent.
//!
//! `catalog` answers "may I write this body name in a session, and will anything answer
//! for it?" — those are two different questions (see [`crate::provider`]), and the
//! listing keeps them apart rather than pretending a name the validator accepts is a
//! name the build can compute.
//!
//! `coverage` prints each provider's own declaration of what it covers, to what
//! accuracy, and on what data, verbatim. Nothing here paraphrases a provider's notes.

use anyhow::Result;
use serde::Serialize;
use skyfix_ephemeris::Coverage;

use crate::exit;
use crate::provider;
use crate::report;

#[derive(Serialize)]
struct BodyRow {
    body: String,
    available: bool,
    provider: Option<String>,
    note: Option<String>,
}

#[derive(Serialize)]
struct CatalogJson {
    bodies: Vec<BodyRow>,
}

pub fn run_catalog(json: bool) -> Result<u8> {
    let rows: Vec<BodyRow> = provider::known_bodies()
        .into_iter()
        .map(|body| {
            let resolved = provider::provider_for(body);
            let available = resolved.is_available();
            let text = resolved.describe().to_string();
            BodyRow {
                body: body.to_string(),
                available,
                provider: available.then(|| text.clone()),
                note: (!available).then_some(text),
            }
        })
        .collect();

    if json {
        report::emit_line(&serde_json::to_string_pretty(&CatalogJson {
            bodies: rows,
        })?)?;
        return Ok(exit::OK);
    }

    let mut out = format!("{}{}\n", report::pad("BODY", 20), "PROVIDER");
    for r in &rows {
        let right = match (&r.provider, &r.note) {
            (Some(p), _) => p.clone(),
            (None, Some(n)) => format!("none: {n}"),
            (None, None) => "none".to_string(),
        };
        out.push_str(&format!("{}{}\n", report::pad(&r.body, 20), right));
    }
    let available = rows.iter().filter(|r| r.available).count();
    out.push('\n');
    for line in report::wrap(
        &format!(
            "{} body name(s) accepted in a session file; {available} answerable by a provider in \
             this build. A name with no provider is still legal when the observation supplies its \
             own geocentric block.",
            rows.len()
        ),
        88,
        "",
    ) {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str(
        "\"HIP <number>\" is accepted as a name too and resolves against the star catalogue.\n",
    );
    report::emit(&out)?;
    Ok(exit::OK)
}

#[derive(Serialize)]
struct ProviderRow {
    name: String,
    coverage: Coverage,
}

pub fn run_coverage(json: bool) -> Result<u8> {
    let providers = provider::providers();
    if json {
        let rows: Vec<ProviderRow> = providers
            .into_iter()
            .map(|p| ProviderRow {
                name: p.name,
                coverage: p.coverage,
            })
            .collect();
        report::emit_line(&serde_json::to_string_pretty(&rows)?)?;
        return Ok(exit::OK);
    }

    let mut out = String::new();
    for (i, p) in providers.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&format!("{}\n", p.name));
        out.push_str(&format!(
            "  dates     {} .. {}\n",
            p.coverage.start_utc, p.coverage.end_utc
        ));
        out.push_str(&format!(
            "  accuracy  {} arcmin\n",
            p.coverage.accuracy_arcmin
        ));
        out.push_str(&format!("  bodies    {}\n", p.coverage.bodies.len()));
        for (j, line) in report::wrap(&p.coverage.notes, 76, "            ")
            .into_iter()
            .enumerate()
        {
            if j == 0 {
                out.push_str(&format!("  notes     {}\n", line.trim_start()));
            } else {
                out.push_str(&format!("{line}\n"));
            }
        }
    }
    out.push('\n');
    for line in report::wrap(
        "`--ephemeris auto` tries these in the order listed and reports the most informative \
         failure when none of them can answer. An observation that supplies its own geocentric \
         block bypasses all of them, and the reduction says so for that sight.",
        88,
        "",
    ) {
        out.push_str(&line);
        out.push('\n');
    }
    report::emit(&out)?;
    Ok(exit::OK)
}
