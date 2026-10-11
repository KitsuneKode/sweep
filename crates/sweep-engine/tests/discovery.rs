use std::sync::atomic::AtomicBool;
use sweep_engine::discovery::{DiscoveryIndex, Query, QueryOrder, MAX_PAGE_RECORDS};
use sweep_types::{EntryType, RiskTier, ScanCandidate, ScanEntry, ScanPlan};

fn snapshot(count: usize) -> ScanPlan {
    let mut plan = ScanPlan::empty("/owned/project", "2026-10-08T00:00:00.000Z");
    for i in 0..count {
        plan.candidates.push(ScanCandidate {
            entry: ScanEntry {
                identity: None,
                path: format!("/owned/project/group-{}/dist", i),
                name: "dist".to_owned(),
                estimated_bytes: i as u64 * 128,
                bytes_known: Some(i != 2),
                modified_ms: (i != 1).then_some(i as u64 * 60_000),
                is_symlink: false,
                entry_type: EntryType::Directory,
            },
            id: format!("candidate-{i}"),
            kind: "dist".to_owned(),
            risk_tier: if i == 3 {
                RiskTier::Blocked
            } else {
                RiskTier::Safe
            },
            reasons: vec!["default-pattern".to_owned()],
            selected_by_default: true,
        });
    }
    plan
}

fn query() -> Query {
    Query {
        generation: "generation-one".to_owned(),
        revision: 0,
        filter: String::new(),
        scope: None,
        risk: None,
        order: QueryOrder::Discovery,
        offset: 0,
        limit: 2,
        now: 10_000_000,
    }
}

#[test]
fn pages_preserve_snapshot_fields_and_do_not_change_selection() {
    let plan = snapshot(7);
    let expected = plan.candidates.clone();
    let index = DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024)
        .unwrap_or_else(|e| panic!("index: {e}"));
    let first = index
        .query(&query(), &AtomicBool::new(false))
        .unwrap_or_else(|e| panic!("page: {e}"));
    assert_eq!(first.candidates, expected[..2]);
    assert_eq!(first.matching_count, 7);
    assert_eq!(first.next_offset, Some(2));
    assert_eq!(first.summary.selected_count, 0);
    let mut next = query();
    next.offset = 2;
    assert_eq!(
        index
            .query(&next, &AtomicBool::new(false))
            .unwrap_or_else(|e| panic!("page: {e}"))
            .candidates,
        expected[2..4]
    );
    assert_eq!(
        first.candidates,
        expected[..2],
        "previous page is immutable"
    );
}

#[test]
fn queue_mutation_is_atomic_revisioned_and_blocked_ids_never_queue() {
    let mut index = DiscoveryIndex::new(snapshot(7), "generation-one".to_owned(), 64 * 1024 * 1024)
        .unwrap_or_else(|e| panic!("index: {e}"));
    assert!(index
        .select(
            "generation-one",
            0,
            &["candidate-0".to_owned(), "candidate-3".to_owned()],
            true
        )
        .is_err());
    assert_eq!(index.summary().selected_count, 0);
    assert!(index
        .select(
            "generation-one",
            0,
            &["candidate-0".to_owned(), "missing".to_owned()],
            true
        )
        .is_err());
    assert_eq!(index.summary().selected_count, 0);
    let summary = index
        .select(
            "generation-one",
            0,
            &["candidate-0".to_owned(), "candidate-2".to_owned()],
            true,
        )
        .unwrap_or_else(|e| panic!("select: {e}"));
    assert_eq!(summary.selected_count, 2);
    assert!(summary.selected_bytes_partial);
    assert_eq!(summary.revision, 1);
    assert!(index.query(&query(), &AtomicBool::new(false)).is_err());
    assert!(index.select("old-generation", 1, &[], false).is_err());
    let mut queued = query();
    queued.revision = 1;
    queued.filter = "is:queued".to_owned();
    let page = index
        .query(&queued, &AtomicBool::new(false))
        .unwrap_or_else(|e| panic!("page: {e}"));
    assert_eq!(
        page.candidates
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        ["candidate-0", "candidate-2"]
    );
}

#[test]
fn filters_scopes_unknown_times_and_cancellation_are_explicit() {
    let mut plan = snapshot(8);
    plan.candidates[0].entry.path = "/owned/project/a\\b/dist".to_owned();
    plan.candidates[1].entry.path = "/owned/project/a/b/dist".to_owned();
    let index = DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024)
        .unwrap_or_else(|e| panic!("index: {e}"));
    let mut request = query();
    request.scope = Some("a\\b".to_owned());
    assert_eq!(
        index
            .query(&request, &AtomicBool::new(false))
            .unwrap_or_else(|e| panic!("page: {e}"))
            .matching_count,
        1
    );
    request.scope = None;
    request.filter = "kind:dist >128B !risk:blocked".to_owned();
    request.limit = 8;
    let page = index
        .query(&request, &AtomicBool::new(false))
        .unwrap_or_else(|e| panic!("page: {e}"));
    assert_eq!(page.matching_count, 5);
    request.filter = "older:1m".to_owned();
    assert_eq!(
        index
            .query(&request, &AtomicBool::new(false))
            .unwrap_or_else(|e| panic!("page: {e}"))
            .matching_count,
        7
    );
    assert!(index.query(&request, &AtomicBool::new(true)).is_err());
    request.limit = MAX_PAGE_RECORDS + 1;
    assert!(index.query(&request, &AtomicBool::new(false)).is_err());
    assert!(DiscoveryIndex::new(snapshot(8), "generation-one".to_owned(), 64).is_err());
}

#[test]
fn malformed_snapshots_and_noop_selection_are_bounded() {
    let mut plan = snapshot(1);
    plan.candidates[0].reasons = vec![String::new(); 65];
    assert!(DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024).is_err());
    let mut plan = snapshot(2);
    plan.selected_candidate_ids = vec!["candidate-0".to_owned(); 3];
    assert!(DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024).is_err());
    let mut plan = snapshot(2);
    plan.candidates[1].id = plan.candidates[0].id.clone();
    assert!(DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024).is_err());
    let mut plan = snapshot(2);
    plan.candidates[1].entry.estimated_bytes = 9_007_199_254_740_992;
    assert!(DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024).is_err());
    let mut plan = snapshot(2);
    plan.candidates[1].entry.path = "/owned/other/dist".to_owned();
    assert!(DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024).is_err());
    let mut index = DiscoveryIndex::new(snapshot(2), "generation-one".to_owned(), 64 * 1024 * 1024)
        .unwrap_or_else(|e| panic!("index: {e}"));
    let ids = ["candidate-0".to_owned()];
    assert_eq!(
        index
            .select("generation-one", 0, &ids, false)
            .unwrap_or_else(|e| panic!("select: {e}"))
            .revision,
        0
    );
    assert_eq!(
        index
            .select("generation-one", 0, &ids, true)
            .unwrap_or_else(|e| panic!("select: {e}"))
            .revision,
        1
    );
    assert_eq!(
        index
            .select("generation-one", 1, &ids, true)
            .unwrap_or_else(|e| panic!("select: {e}"))
            .revision,
        1
    );
}

#[test]
fn unicode_names_and_filter_whitespace_match_the_js_reference() {
    let mut plan = snapshot(4);
    plan.candidates[0].entry.path = "/owned/project/東京/dist".to_owned();
    let expected = plan.candidates[0].clone();
    let index = DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024)
        .unwrap_or_else(|e| panic!("index: {e}"));
    let mut request = query();
    request.filter = "東京".to_owned();
    let page = index
        .query(&request, &AtomicBool::new(false))
        .unwrap_or_else(|e| panic!("page: {e}"));
    assert_eq!(page.candidates, vec![expected]);
    request.filter = "kind:dist\u{feff}!risk:blocked".to_owned();
    assert_eq!(
        index
            .query(&request, &AtomicBool::new(false))
            .unwrap_or_else(|e| panic!("page: {e}"))
            .matching_count,
        3
    );
    request.filter = "kind:dist\u{0085}!risk:blocked".to_owned();
    assert_eq!(
        index
            .query(&request, &AtomicBool::new(false))
            .unwrap_or_else(|e| panic!("page: {e}"))
            .matching_count,
        0
    );
}

#[test]
fn escaped_metadata_obeys_the_actual_serialized_page_budget() {
    let mut plan = snapshot(10);
    for candidate in &mut plan.candidates {
        candidate.reasons = vec!["\u{0001}".repeat(1024); 64];
    }
    let index = DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024)
        .unwrap_or_else(|e| panic!("index: {e}"));
    let mut request = query();
    request.limit = MAX_PAGE_RECORDS;
    let page = index
        .query(&request, &AtomicBool::new(false))
        .unwrap_or_else(|e| panic!("page: {e}"));
    assert_eq!(page.candidates.len(), 2);
    assert_eq!(page.next_offset, Some(2));
    let json = serde_json::to_vec(&page).unwrap_or_else(|e| panic!("serialize: {e}"));
    assert!(json.len() < sweep_engine::discovery::MAX_PAGE_BYTES);
}
