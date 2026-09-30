mod parity_support;

/// `node_modules-only` - minimal fixture with a single `node_modules` directory.
#[test]
fn parity_node_modules_only_matches_golden() {
    let golden = parity_support::load_golden_plan("node_modules-only");
    let actual = parity_support::run_rust_scan_normalized("node_modules-only");

    assert_eq!(
        actual, golden,
        "rust scan plan should match committed JS golden fixture"
    );
    insta::assert_json_snapshot!("node_modules_only", &actual);
}

/// `basic` - multiple default-pattern artifacts (seed-fixture basic scenario shape).
#[test]
fn parity_basic_matches_golden() {
    let golden = parity_support::load_golden_plan("basic");
    let actual = parity_support::run_rust_scan_normalized("basic");

    assert_eq!(
        actual, golden,
        "rust scan plan should match committed JS golden fixture"
    );
    insta::assert_json_snapshot!("basic", &actual);
}

/// `monorepo` - nested packages with mixed artifacts.
#[test]
fn parity_monorepo_matches_golden() {
    let golden = parity_support::load_golden_plan("monorepo");
    let actual = parity_support::run_rust_scan_normalized("monorepo");

    assert_eq!(
        actual, golden,
        "rust scan plan should match committed JS golden fixture"
    );
    insta::assert_json_snapshot!("monorepo", &actual);
}

/// `workspace-matrix` - multi-package workspace with several artifact kinds.
#[test]
fn parity_workspace_matrix_matches_golden() {
    let golden = parity_support::load_golden_plan("workspace-matrix");
    let actual = parity_support::run_rust_scan_normalized("workspace-matrix");

    assert_eq!(
        actual, golden,
        "rust scan plan should match committed JS golden fixture"
    );
    insta::assert_json_snapshot!("workspace_matrix", &actual);
}

/// `risk-mix` - safe directories plus a symlink matching a default pattern.
#[test]
fn parity_risk_mix_matches_golden() {
    let golden = parity_support::load_golden_plan("risk-mix");
    let actual = parity_support::run_rust_scan_normalized("risk-mix");

    assert_eq!(
        actual, golden,
        "rust scan plan should match committed JS golden fixture"
    );
    insta::assert_json_snapshot!("risk_mix", &actual);
}

/// `opt-in-patterns` - catalog opt-ins (`dist`, `build`, `*.egg-info`) enabled
/// on top of defaults. Opt-ins must land `dangerous` + `opt-in-pattern` on both
/// engines and never be pre-selected.
#[test]
fn parity_opt_in_patterns_matches_golden() {
    let extras = parity_support::fixture_extra_patterns("opt-in-patterns");
    let extra_refs: Vec<&str> = extras.iter().map(String::as_str).collect();
    let golden = parity_support::load_golden_plan("opt-in-patterns");
    let actual = parity_support::run_rust_scan_normalized_with("opt-in-patterns", &extra_refs);

    assert_eq!(
        actual, golden,
        "rust scan plan should match committed JS golden fixture"
    );
    insta::assert_json_snapshot!("opt_in_patterns", &actual);
}
