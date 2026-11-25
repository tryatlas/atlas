//! The editor gutter's line status, through the crate's public interface:
//! a file's `git diff` in, the new file's added and changed lines out, plus
//! the lines that follow a removal.

use atlas_gitdiff::{line_status, LineStatus};

fn status(diff: &str) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let LineStatus {
        added,
        changed,
        deleted_before,
    } = line_status(diff);
    (added, changed, deleted_before)
}

const NONE: Vec<u32> = Vec::new();

#[test]
fn a_clean_file_has_no_marks() {
    assert_eq!(status(""), (NONE, NONE, NONE));
}

#[test]
fn a_rewritten_line_is_changed_and_a_new_one_added() {
    // `-U0`, as the gutter asks for it.
    let diff =
        "@@ -2 +2 @@ fn f\n-let two = 2;\n+let two = 22;\n@@ -12,0 +13 @@ twelve\n+thirteen\n";
    assert_eq!(status(diff), (vec![13], vec![2], NONE));
}

#[test]
fn a_new_file_is_added_throughout() {
    let diff = "--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n";
    assert_eq!(status(diff), (vec![1, 2, 3], NONE, NONE));
}

#[test]
fn a_removal_marks_the_line_that_follows_it() {
    // With context, the next new-file line is in the hunk.
    let diff = "@@ -1,4 +1,2 @@\n keep\n-gone\n-too\n after\n";
    assert_eq!(status(diff), (NONE, NONE, vec![2]));
}

#[test]
fn a_removal_without_following_context_keeps_its_new_file_boundary() {
    // Preserve the position after line one, including at EOF. The editor can
    // anchor that boundary to its last line instead of losing the removal.
    assert_eq!(
        status("@@ -2,2 +1,0 @@\n-gone\n-too\n"),
        (NONE, NONE, vec![2])
    );
    assert_eq!(
        status("@@ -1,2 +1 @@\n keep\n-last\n"),
        (NONE, NONE, vec![2])
    );
}

#[test]
fn a_replacement_with_nothing_in_common_is_added_not_changed() {
    let diff = "@@ -1 +1 @@\n-alpha beta gamma\n+something else entirely\n";
    assert_eq!(status(diff), (vec![1], NONE, NONE));
}

#[test]
fn a_block_pairs_each_line_with_the_one_it_became() {
    // Two lines rewritten around one that is new: the similar ones pair.
    let diff = "@@ -1,2 +1,3 @@\n-let first = 1;\n-let second = 2;\n+let first = 10;\n+brand new\n+let second = 20;\n";
    assert_eq!(status(diff), (vec![2], vec![1, 3], NONE));
}

#[test]
fn lines_removed_after_a_changed_one_mark_the_line_that_follows() {
    let diff = "@@ -1,4 +1,2 @@\n-let a = 1;\n-dropped line\n-another\n+let a = 2;\n ctx\n";
    assert_eq!(status(diff), (NONE, vec![1], vec![2]));
}

#[test]
fn a_crlf_file_reads_like_any_other() {
    let diff = "@@ -1,3 +1,3 @@\n a\r\n-let b = 1;\r\n+let b = 2;\r\n c\r\n";
    assert_eq!(status(diff), (NONE, vec![2], NONE));
}

#[test]
fn a_line_ending_change_is_a_change() {
    assert_eq!(
        status("@@ -1,2 +1,2 @@\n-x\r\n+x\n y\r\n"),
        (NONE, vec![1], NONE)
    );
}

#[test]
fn a_blank_lines_ending_change_is_an_added_line() {
    // Nothing but the line ending to compare, so the two do not pair.
    assert_eq!(
        status("@@ -1,2 +1,2 @@\n-\r\n+\n y\r\n"),
        (vec![1], NONE, NONE)
    );
}

#[test]
fn a_binary_file_has_no_marks() {
    let diff = "diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n";
    assert_eq!(status(diff), (NONE, NONE, NONE));
}

#[test]
fn a_conflicted_file_is_read_against_its_first_parent() {
    let diff = "diff --cc f\n@@@ -1,3 -1,3 +1,3 @@@\n  one\n- let x = 2;\n -let x = 3;\n++let x = 4;\n  three\n";
    assert_eq!(status(diff), (NONE, vec![2], NONE));
}
