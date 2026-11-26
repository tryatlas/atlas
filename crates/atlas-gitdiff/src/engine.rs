//! The editor gutter's line status, from a file's `git diff`.
//!
//! A run of removed and added lines is paired line by line with the vendored
//! delta `edits::infer_edits`: an added line that pairs with a removed one is
//! a changed line, one that pairs with nothing is an added line.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

use crate::parse::{self, RawKind};
use crate::vendor::edits::infer_edits;

/// NEW-file line numbers that are added or changed, plus the new-file line
/// numbers immediately following a removal.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineStatus {
    pub added: Vec<u32>,
    pub changed: Vec<u32>,
    pub deleted_before: Vec<u32>,
}

fn token_re() -> &'static Regex {
    // delta's default `--word-diff-regex`.
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\w+").unwrap())
}

/// Classify the new file's lines from one file's unified diff (`git diff --
/// <file>`, any amount of context). An empty diff, and a binary file's, has
/// no lines to mark.
pub fn line_status(diff: &str) -> LineStatus {
    let mut out = LineStatus::default();
    let parsed = parse::parse_unified(diff);
    if parsed.is_binary {
        return out;
    }

    // A removal with no added line beside it has no new-file line of its own:
    // it waits for the next one, which the gutter draws a wedge above.
    for hunk in &parsed.hunks {
        let mut pending_delete = false;
        let mut new_ln = hunk.new_start + u32::from(hunk.new_count == 0);
        let lines = &hunk.lines;
        let mut i = 0;
        while i < lines.len() {
            if lines[i].kind == RawKind::Context {
                if pending_delete {
                    out.deleted_before.push(new_ln);
                    pending_delete = false;
                }
                new_ln += 1;
                i += 1;
                continue;
            }
            // Collect the contiguous change block (git groups all `-` lines
            // then all `+` lines, but we tolerate any interleave).
            let mut minus: Vec<&str> = Vec::new();
            let mut plus: Vec<&str> = Vec::new();
            while i < lines.len() && lines[i].kind != RawKind::Context {
                if lines[i].kind == RawKind::Minus {
                    minus.push(lines[i].text.as_str());
                } else {
                    plus.push(lines[i].text.as_str());
                }
                i += 1;
            }
            for (removed, added) in pair(&minus, &plus) {
                match (removed, added) {
                    (true, false) => pending_delete = true,
                    (_, true) => {
                        if removed {
                            out.changed.push(new_ln);
                        } else {
                            out.added.push(new_ln);
                        }
                        new_ln += 1;
                        pending_delete = false;
                    }
                    (false, false) => {}
                }
            }
        }
        if pending_delete {
            out.deleted_before.push(new_ln.max(1));
        }
    }
    out
}

/// A block's rows in order: whether each has a removed line, and an added one.
fn pair(minus: &[&str], plus: &[&str]) -> Vec<(bool, bool)> {
    let (minus, plus) = line_endings_for_pairing(minus, plus);
    let (_, _, alignment) = infer_edits(
        minus.iter().map(String::as_str).collect(),
        plus.iter().map(String::as_str).collect(),
        // The word-level marks `infer_edits` also computes (unchanged: false,
        // changed: true) are not read; only its line alignment is.
        vec![false; minus.len()],
        true,
        vec![false; plus.len()],
        true,
        token_re(),
        0.6, // delta default --max-line-distance
        0.0, // delta default naively-paired threshold
    );
    alignment
        .into_iter()
        .map(|(m, p)| (m.is_some(), p.is_some()))
        .collect()
}

/// A CRLF file's lines keep their `\r` through parsing. Where every line in a
/// change block ends the same way, the `\r` says nothing and is dropped.
/// Where the block mixes endings, it is a difference (possibly the only one),
/// so it becomes a `␍` the pairing can count: a `\r` is whitespace, which the
/// distance between two lines ignores.
fn line_endings_for_pairing(minus: &[&str], plus: &[&str]) -> (Vec<String>, Vec<String>) {
    let all = || minus.iter().chain(plus);
    let mixed = all().any(|l| l.ends_with('\r')) && all().any(|l| !l.ends_with('\r'));
    let show = |l: &&str| match l.strip_suffix('\r') {
        Some(body) if mixed => format!("{body}␍"),
        Some(body) => body.to_string(),
        None => (*l).to_string(),
    };
    (
        minus.iter().map(show).collect(),
        plus.iter().map(show).collect(),
    )
}
