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
            project_active_ms: None,
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
fn folder_pages_keep_root_items_prefix_boundaries_and_live_totals() {
    let mut plan = snapshot(4);
    for (candidate, path) in plan.candidates.iter_mut().zip([
        "/owned/project/a/dist",
        "/owned/project/a/child/dist",
        "/owned/project/ab/dist",
        "/owned/project/dist",
    ]) {
        candidate.entry.path = path.into();
    }
    let mut index = DiscoveryIndex::new(plan, "generation-one".into(), 64 * 1024 * 1024)
        .unwrap_or_else(|error| panic!("index: {error}"));
    let root = index
        .folders("generation-one", 0, None, 0, 2)
        .unwrap_or_else(|error| panic!("folders: {error}"));
    assert_eq!(root.matching_count, 3);
    assert_eq!(root.next_offset, Some(2));
    assert_eq!(root.folders[0].key, "");
    assert_eq!(root.folders[0].own_count, 1);
    assert_eq!(root.folders[1].key, "ab");
    let tail = index
        .folders("generation-one", 0, None, 2, 2)
        .unwrap_or_else(|error| panic!("tail: {error}"));
    assert_eq!(tail.folders[0].key, "a");
    assert_eq!(tail.folders[0].own_count, 1);
    assert!(tail.folders[0].has_children);
    assert_eq!(tail.folders[0].totals.candidate_count, 2);
    assert_eq!(tail.next_offset, None);
    let nested = index
        .folders("generation-one", 0, Some("a"), 0, 256)
        .unwrap_or_else(|error| panic!("nested: {error}"));
    assert_eq!(nested.matching_count, 1);
    assert_eq!(nested.folders[0].key, "a/child");
    assert_eq!(nested.folders[0].own_count, 1);
    assert!(!nested.folders[0].has_children);
    assert_eq!(
        index
            .folders("generation-one", 0, Some(""), 0, 256)
            .unwrap_or_else(|error| panic!("root items: {error}"))
            .matching_count,
        0
    );
    index
        .select("generation-one", 0, &["candidate-1".into()], true)
        .unwrap_or_else(|error| panic!("select: {error}"));
    let selected = index
        .folders("generation-one", 1, Some("a"), 0, 256)
        .unwrap_or_else(|error| panic!("selected: {error}"));
    assert_eq!(selected.folders[0].totals.selected_count, 1);
    index
        .retire("generation-one", 1, &["candidate-1".into()])
        .unwrap_or_else(|error| panic!("retire: {error}"));
    assert!(index
        .folders("generation-one", 2, Some("a"), 0, 256)
        .unwrap_or_else(|error| panic!("retired: {error}"))
        .folders
        .is_empty());
    assert!(index.folders("generation-one", 1, None, 0, 256).is_err());
    assert!(index
        .folders("generation-one", 2, Some("a/"), 0, 256)
        .is_err());
    assert!(index
        .folders("generation-one", 2, Some("../a"), 0, 256)
        .is_err());
    assert_eq!(index.summary().revision, 2);
}

#[test]
fn wide_folder_pages_are_bounded_and_never_omit_the_remaining_page() {
    let index = DiscoveryIndex::new(snapshot(1000), "generation-one".into(), 64 * 1024 * 1024)
        .unwrap_or_else(|error| panic!("index: {error}"));
    let mut offset = 0;
    let mut seen = std::collections::HashSet::new();
    loop {
        let page = index
            .folders("generation-one", 0, None, offset, MAX_PAGE_RECORDS)
            .unwrap_or_else(|error| panic!("page: {error}"));
        assert!(page.folders.len() <= MAX_PAGE_RECORDS);
        assert_eq!(page.matching_count, 1000);
        for folder in page.folders {
            assert!(seen.insert(folder.key));
        }
        match page.next_offset {
            Some(next) => {
                assert!(next > offset);
                offset = next;
            }
            None => break,
        }
    }
    assert_eq!(seen.len(), 1000);
    assert!(index
        .folders("generation-one", 0, None, 0, MAX_PAGE_RECORDS + 1)
        .is_err());
    assert!(index.folders("generation-one", 0, None, 0, 0).is_err());
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
        if cfg!(windows) { 2 } else { 1 }
    );
    request.scope = Some("a".to_owned());
    assert_eq!(
        index
            .query(&request, &AtomicBool::new(false))
            .unwrap_or_else(|e| panic!("parent scope: {e}"))
            .matching_count,
        if cfg!(windows) { 2 } else { 1 }
    );
    request.scope = Some("a/b".to_owned());
    assert_eq!(
        index
            .query(&request, &AtomicBool::new(false))
            .unwrap_or_else(|e| panic!("slash scope: {e}"))
            .matching_count,
        if cfg!(windows) { 2 } else { 1 }
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

#[test]
fn retirement_updates_global_totals_and_cannot_be_requeued() {
    let mut plan = snapshot(7);
    plan.selected_candidate_ids = vec!["candidate-1".to_owned(), "candidate-2".to_owned()];
    let mut index = DiscoveryIndex::new(plan, "generation-one".to_owned(), 64 * 1024 * 1024)
        .unwrap_or_else(|e| panic!("index: {e}"));
    let before = index.summary();
    assert_eq!(before.selected_risk_counts.safe, 2);
    let summary = index
        .retire("generation-one", 0, &["candidate-2".to_owned()])
        .unwrap_or_else(|e| panic!("retire: {e}"));
    assert_eq!(summary.candidate_count, 6);
    assert_eq!(summary.estimated_bytes, before.estimated_bytes - 256);
    assert!(!summary.bytes_partial);
    assert!(!summary.selected_bytes_partial);
    assert_eq!(summary.selected_count, 1);
    assert_eq!(summary.selected_bytes, 128);
    assert_eq!(summary.selected_risk_counts.safe, 1);
    assert_eq!(summary.risk_counts.safe, 5);
    assert_eq!(
        summary.retained_bytes, before.retained_bytes,
        "retention stays conservative"
    );
    assert!(index.query(&query(), &AtomicBool::new(false)).is_err());
    let mut request = query();
    request.revision = 1;
    request.limit = 7;
    let page = index
        .query(&request, &AtomicBool::new(false))
        .unwrap_or_else(|e| panic!("page: {e}"));
    assert_eq!(page.matching_count, 6);
    assert!(page
        .candidates
        .iter()
        .all(|candidate| candidate.id != "candidate-2"));
    assert!(index
        .select("generation-one", 1, &["candidate-2".to_owned()], true)
        .is_err());
    assert!(index
        .retire("generation-one", 1, &["candidate-2".to_owned()])
        .is_err());
    assert_eq!(index.summary().revision, 1);
}

#[test]
fn retirement_validates_whole_batch_and_unknown_or_duplicate_ids_leave_totals_intact() {
    let mut index = DiscoveryIndex::new(snapshot(7), "generation-one".to_owned(), 64 * 1024 * 1024)
        .unwrap_or_else(|e| panic!("index: {e}"));
    for ids in [
        vec!["candidate-0".to_owned(), "missing".to_owned()],
        vec!["candidate-0".to_owned(); 2],
        vec!["candidate-0".to_owned(); MAX_PAGE_RECORDS + 1],
    ] {
        assert!(index.retire("generation-one", 0, &ids).is_err());
        assert_eq!(index.summary().candidate_count, 7);
        assert_eq!(index.summary().revision, 0);
    }
    assert!(index.retire("other-generation", 0, &[]).is_err());
    assert_eq!(
        index
            .retire("generation-one", 0, &[])
            .unwrap_or_else(|e| panic!("retire: {e}"))
            .revision,
        0
    );
    for i in 0..7 {
        index
            .retire("generation-one", i, &[format!("candidate-{i}")])
            .unwrap_or_else(|e| panic!("retire: {e}"));
    }
    let summary = index.summary();
    assert_eq!(summary.candidate_count, 0);
    assert_eq!(summary.estimated_bytes, 0);
    assert!(!summary.bytes_partial);
    assert_eq!(summary.risk_counts.safe + summary.risk_counts.blocked, 0);
}

#[test]
fn scope_bulk_changes_are_atomic_and_keep_hidden_rows_and_root_distinct(
) -> Result<(), sweep_engine::discovery::DiscoveryError> {
    let mut plan = snapshot(600);
    for (i, candidate) in plan.candidates.iter_mut().enumerate() {
        let scope = if i == 0 {
            ""
        } else if i < 500 {
            "a/nested/"
        } else {
            "ab/"
        };
        candidate.entry.path = format!("/owned/project/{scope}node_modules-{i}");
        candidate.risk_tier = match i {
            599 => RiskTier::Blocked,
            598 => RiskTier::Dangerous,
            597 => RiskTier::Caution,
            _ => RiskTier::Safe,
        };
    }
    let mut index = DiscoveryIndex::new(plan, "g".into(), 64 * 1024 * 1024)?;
    assert_eq!(index.scope_summary("g", 0, Some(""))?.candidate_count, 1);
    let a = index.scope_summary("g", 0, Some("a"))?;
    assert_eq!(a.candidate_count, 499);
    assert!(a.bytes_partial);
    let selected = index.select_scope("g", 0, Some("a"), true, false)?;
    assert_eq!(selected.selected_count, 499);
    assert_eq!(selected.revision, 1);
    assert_eq!(index.scope_summary("g", 1, Some("ab"))?.selected_count, 0);
    assert!(index.select_scope("g", 1, Some("a/"), true, true).is_err());
    assert!(index.select_scope("wrong", 1, None, false, false).is_err());
    assert!(index.select_scope("g", 0, None, false, false).is_err());
    assert_eq!(index.summary().selected_count, 499);
    let all = index.select_scope("g", 1, None, true, false)?;
    assert_eq!(all.selected_count, 598);
    assert_eq!(all.selected_risk_counts.dangerous, 0);
    assert_eq!(index.select_scope("g", 2, None, true, false)?.revision, 2);
    let dangerous = index.select_scope("g", 2, Some("ab"), true, true)?;
    assert_eq!(dangerous.selected_count, 599);
    assert_eq!(dangerous.selected_risk_counts.blocked, 0);
    index.retire("g", 3, &["candidate-2".into()])?;
    let a = index.scope_summary("g", 4, Some("a"))?;
    assert_eq!(a.candidate_count, 498);
    assert!(!a.bytes_partial);
    assert!(!a.selected_bytes_partial);
    let clear = index.select_scope("g", 4, None, false, false)?;
    assert_eq!(clear.selected_count, 0);
    assert_eq!(clear.selected_bytes, 0);
    assert_eq!(clear.selected_risk_counts.dangerous, 0);
    let none = index.scope_summary("g", 5, Some("missing"))?;
    assert_eq!(none.candidate_count, 0);
    assert_eq!(none.selected_count, 0);
    Ok(())
}
