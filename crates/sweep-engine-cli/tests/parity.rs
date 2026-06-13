mod parity_support;

/// `node_modules-only` — minimal fixture with a single `node_modules` directory.
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

/// `basic` — multiple default-pattern artifacts (seed-fixture basic scenario shape).
#[test]
#[ignore = "TODO: implement full default-pattern parity for basic fixture"]
fn parity_basic_fixture() {
    let _golden = parity_support::load_golden_plan("basic");
    let _actual = parity_support::run_rust_scan_normalized("basic");
}

/// `monorepo` — nested packages with mixed artifacts.
#[test]
#[ignore = "TODO: implement monorepo fixture walk parity"]
fn parity_monorepo_fixture() {
    let _golden = parity_support::load_golden_plan("monorepo");
    let _actual = parity_support::run_rust_scan_normalized("monorepo");
}
