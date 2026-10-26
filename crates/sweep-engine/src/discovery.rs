//! Read-only compact review snapshots. This index cannot remove files or
//! authorize an apply; callers still construct and validate an explicit plan.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use sweep_types::{
    EntryType, FilesystemIdentity, RiskCounts, RiskTier, ScanCandidate, ScanEntry, ScanPlan,
};

pub const MAX_PAGE_RECORDS: usize = 256;
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;
pub const MAX_INDEX_BYTES: usize = 64 * 1024 * 1024;
const MAX_FOLDER_WORK_BYTES: usize = 32 * 1024 * 1024;
const MAX_RECORDS: usize = 100_000;
const MAX_TEXT_BYTES: usize = 1000;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug)]
pub struct DiscoveryError(pub &'static str);
impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for DiscoveryError {}
type Result<T> = std::result::Result<T, DiscoveryError>;

#[derive(Debug, Clone, Copy, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QueryOrder {
    #[default]
    Discovery,
    Size,
    Name,
    Age,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub generation: String,
    pub revision: u64,
    pub filter: String,
    pub scope: Option<String>,
    pub risk: Option<RiskTier>,
    pub order: QueryOrder,
    pub offset: usize,
    pub limit: usize,
    pub now: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSummary {
    pub generation: String,
    pub revision: u64,
    pub candidate_count: usize,
    pub estimated_bytes: u64,
    pub bytes_partial: bool,
    pub selected_count: usize,
    pub selected_bytes: u64,
    pub selected_bytes_partial: bool,
    pub selected_risk_counts: RiskCounts,
    pub risk_counts: RiskCounts,
    /// Logical accounting for permanent storage, not process RSS.
    pub retained_bytes: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub generation: String,
    pub revision: u64,
    pub matching_count: usize,
    pub matching_bytes: u64,
    pub matching_bytes_partial: bool,
    pub next_offset: Option<usize>,
    pub candidates: Vec<ScanCandidate>,
    pub summary: IndexSummary,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub key: String,
    pub has_children: bool,
    pub own_count: usize,
    pub totals: IndexSummary,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPage {
    pub generation: String,
    pub revision: u64,
    pub scope: Option<String>,
    pub matching_count: usize,
    pub offset: usize,
    pub next_offset: Option<usize>,
    pub folders: Vec<Folder>,
    pub summary: IndexSummary,
}

#[derive(Default)]
struct FolderTotals {
    count: usize,
    bytes: u64,
    partial: bool,
    selected_count: usize,
    selected_bytes: u64,
    selected_partial: bool,
    risks: RiskCounts,
    selected_risks: RiskCounts,
    own_count: usize,
    has_children: bool,
    first_seen: usize,
}

fn child_key<'a>(key: &'a str, parent: Option<&str>) -> Option<&'a str> {
    let start = match parent {
        None => 0,
        Some("") => return None,
        Some(parent) => {
            key.strip_prefix(parent)?.strip_prefix('/')?;
            parent.len() + 1
        }
    };
    let end = key[start..].find('/').map_or(key.len(), |i| start + i);
    Some(&key[..end])
}

#[derive(Clone, Copy, Default)]
struct Span {
    offset: u32,
    len: u32,
}
struct Strings {
    text: String,
}
impl Strings {
    fn get(&self, span: Span) -> &str {
        &self.text[span.offset as usize..span.offset as usize + span.len as usize]
    }
}
struct Builder {
    strings: Strings,
    interned: HashMap<String, Span>,
    charged: usize,
    temporary: usize,
    limit: usize,
}
impl Builder {
    fn charge(&mut self, bytes: usize) -> Result<()> {
        self.charged = self
            .charged
            .checked_add(bytes)
            .ok_or(DiscoveryError("index byte counter overflow"))?;
        if self.charged > self.limit {
            return Err(DiscoveryError("compact index memory limit exceeded"));
        }
        Ok(())
    }
    fn intern(&mut self, value: &str) -> Result<Span> {
        if let Some(span) = self.interned.get(value) {
            return Ok(*span);
        }
        self.temporary = self
            .temporary
            .checked_add(value.len() * 2 + 96)
            .ok_or(DiscoveryError("index byte counter overflow"))?;
        if self.temporary > self.limit {
            return Err(DiscoveryError("compact index build memory limit exceeded"));
        }
        let span = self.append(value)?;
        self.interned.insert(value.to_owned(), span);
        Ok(span)
    }
    fn append(&mut self, value: &str) -> Result<Span> {
        // Includes spare arena capacity; temporary interning keys have their own cap.
        self.charge(
            value
                .len()
                .checked_mul(2)
                .ok_or(DiscoveryError("index byte counter overflow"))?,
        )?;
        let span = Span {
            offset: u32::try_from(self.strings.text.len())
                .map_err(|_| DiscoveryError("index string offset overflow"))?,
            len: u32::try_from(value.len())
                .map_err(|_| DiscoveryError("index string length overflow"))?,
        };
        self.strings.text.push_str(value);
        Ok(span)
    }
}
struct Record {
    active: bool,
    parent: Span,
    leaf: Span,
    name: Span,
    id: Span,
    kind: Span,
    scope: Span,
    identity: Option<[Span; 3]>,
    reasons: Vec<Span>,
    bytes: u64,
    modified: Option<u64>,
    known: Option<bool>,
    symlink: bool,
    entry_type: EntryType,
    risk: RiskTier,
    default: bool,
}

pub struct DiscoveryIndex {
    generation: String,
    revision: u64,
    strings: Strings,
    records: Vec<Record>,
    by_id: HashMap<String, usize>,
    selected: Vec<bool>,
    total_bytes: u64,
    candidate_count: usize,
    partial_count: usize,
    risk_counts: RiskCounts,
    selected_count: usize,
    selected_bytes: u64,
    selected_partial_count: usize,
    selected_risk_counts: RiskCounts,
    charged: usize,
}

fn separator(c: char) -> bool {
    c == '/' || cfg!(windows) && c == '\\'
}
// UI scope keys use '/'. Backslashes remain literal directory-name characters
// on POSIX, but both native Windows separators map to this scope namespace.
fn normalize_scope(value: &str) -> Cow<'_, str> {
    #[cfg(windows)]
    {
        Cow::Owned(value.replace('\\', "/"))
    }
    #[cfg(not(windows))]
    {
        Cow::Borrowed(value)
    }
}
fn add_bytes(total: u64, bytes: u64) -> Result<u64> {
    total
        .checked_add(bytes)
        .filter(|n| *n <= SAFE_INTEGER)
        .ok_or(DiscoveryError("index byte counter overflow"))
}

fn checked_scope(scope: Option<&str>) -> Result<Option<Cow<'_, str>>> {
    let scope = scope.map(normalize_scope);
    if scope.as_deref().is_some_and(|s| {
        s.len() > 32_768
            || (!s.is_empty() && s.split('/').any(|p| p.is_empty() || p == "." || p == ".."))
    }) {
        return Err(DiscoveryError("invalid review scope"));
    }
    Ok(scope)
}

fn within_scope(scope: &str, wanted: Option<&str>) -> bool {
    wanted.is_none_or(|wanted| {
        scope == wanted
            || (!wanted.is_empty()
                && scope
                    .strip_prefix(wanted)
                    .is_some_and(|rest| rest.starts_with('/')))
    })
}

fn risk_counter(counts: &mut RiskCounts, risk: RiskTier) -> &mut u32 {
    match risk {
        RiskTier::Safe => &mut counts.safe,
        RiskTier::Caution => &mut counts.caution,
        RiskTier::Dangerous => &mut counts.dangerous,
        RiskTier::Blocked => &mut counts.blocked,
    }
}

impl DiscoveryIndex {
    /// Consumes one snapshot. Build-time interning is dropped before queries.
    pub fn new(plan: ScanPlan, generation: String, limit: usize) -> Result<Self> {
        if generation.is_empty() || generation.len() > 80 || !generation.is_ascii() {
            return Err(DiscoveryError("invalid discovery generation"));
        }
        if plan.protocol_version != sweep_types::PROTOCOL_VERSION
            || plan.candidates.len() > MAX_RECORDS
            || plan.selected_candidate_ids.len() > plan.candidates.len()
            || plan.selected_candidate_ids.iter().any(|id| id.len() > 80)
        {
            return Err(DiscoveryError("invalid or oversized review snapshot"));
        }
        let mut builder = Builder {
            strings: Strings {
                text: String::new(),
            },
            interned: HashMap::new(),
            charged: 0,
            temporary: 0,
            limit: limit.min(MAX_INDEX_BYTES),
        };
        builder.charge(
            plan.candidates
                .len()
                .checked_mul(std::mem::size_of::<Record>() + 65)
                .ok_or(DiscoveryError("index byte counter overflow"))?,
        )?;
        let mut records = Vec::with_capacity(plan.candidates.len());
        let mut by_id = HashMap::with_capacity(plan.candidates.len());
        let mut total_bytes = 0;
        let mut partial_count = 0;
        let mut risk_counts = RiskCounts::default();
        for candidate in plan.candidates {
            if candidate.id.is_empty()
                || candidate.id.len() > 80
                || by_id.contains_key(&candidate.id)
            {
                return Err(DiscoveryError("invalid or duplicate candidate ID"));
            }
            if candidate.reasons.len() > 64
                || candidate
                    .reasons
                    .iter()
                    .any(|reason| reason.encode_utf16().count() > 1024)
            {
                return Err(DiscoveryError("candidate reason limit exceeded"));
            }
            let path = &candidate.entry.path;
            let relative = path
                .strip_prefix(&plan.target_dir)
                .filter(|s| s.starts_with(separator))
                .ok_or(DiscoveryError("candidate outside review root"))?;
            if relative.split(separator).any(|s| s == "." || s == "..") {
                return Err(DiscoveryError("noncanonical review path"));
            }
            let split = path.rfind(separator).map_or(0, |i| i + 1);
            let (parent, leaf) = path.split_at(split);
            if leaf.is_empty() {
                return Err(DiscoveryError("empty candidate leaf"));
            }
            let scope = relative
                .rsplit_once(separator)
                .map_or("", |(s, _)| s.trim_start_matches(separator));
            let scope = normalize_scope(scope);
            builder.charge(
                candidate.id.len() + candidate.reasons.len() * std::mem::size_of::<Span>(),
            )?;
            let identity = if let Some(identity) = &candidate.entry.identity {
                Some([
                    builder.intern(&identity.platform)?,
                    builder.intern(&identity.device)?,
                    builder.intern(&identity.inode)?,
                ])
            } else {
                None
            };
            let mut reasons = Vec::with_capacity(candidate.reasons.len());
            for reason in &candidate.reasons {
                reasons.push(builder.intern(reason)?);
            }
            let record = Record {
                active: true,
                parent: builder.intern(parent)?,
                leaf: builder.intern(leaf)?,
                name: builder.intern(&candidate.entry.name)?,
                id: builder.append(&candidate.id)?,
                kind: builder.intern(&candidate.kind)?,
                scope: builder.intern(&scope)?,
                identity,
                reasons,
                bytes: candidate.entry.estimated_bytes,
                modified: candidate.entry.modified_ms,
                known: candidate.entry.bytes_known,
                symlink: candidate.entry.is_symlink,
                entry_type: candidate.entry.entry_type,
                risk: candidate.risk_tier,
                default: candidate.selected_by_default,
            };
            if record.modified.is_some_and(|n| n > SAFE_INTEGER) {
                return Err(DiscoveryError("invalid candidate time"));
            }
            total_bytes = add_bytes(total_bytes, record.bytes)?;
            partial_count += usize::from(record.known == Some(false));
            match record.risk {
                RiskTier::Safe => risk_counts.safe += 1,
                RiskTier::Caution => risk_counts.caution += 1,
                RiskTier::Dangerous => risk_counts.dangerous += 1,
                RiskTier::Blocked => risk_counts.blocked += 1,
            }
            by_id.insert(candidate.id, records.len());
            records.push(record);
        }
        let selected = vec![false; records.len()];
        let candidate_count = records.len();
        let mut index = Self {
            generation,
            revision: 0,
            strings: builder.strings,
            records,
            by_id,
            selected,
            total_bytes,
            candidate_count,
            partial_count,
            risk_counts,
            selected_count: 0,
            selected_bytes: 0,
            selected_partial_count: 0,
            selected_risk_counts: RiskCounts::default(),
            charged: builder.charged,
        };
        // Initial selection is explicit; selectedByDefault is only display metadata.
        index.select_inner(&plan.selected_candidate_ids, true)?;
        Ok(index)
    }

    fn check_revision(&self, generation: &str, revision: u64) -> Result<()> {
        if generation != self.generation || revision != self.revision {
            return Err(DiscoveryError("stale discovery generation or revision"));
        }
        Ok(())
    }

    pub fn summary(&self) -> IndexSummary {
        IndexSummary {
            generation: self.generation.clone(),
            revision: self.revision,
            candidate_count: self.candidate_count,
            estimated_bytes: self.total_bytes,
            bytes_partial: self.partial_count > 0,
            selected_count: self.selected_count,
            selected_bytes: self.selected_bytes,
            selected_bytes_partial: self.selected_partial_count > 0,
            selected_risk_counts: self.selected_risk_counts.clone(),
            risk_counts: self.risk_counts.clone(),
            retained_bytes: self.charged,
        }
    }

    /// None is the whole generation; the empty key is only the target root.
    /// A scope includes descendants, never similarly prefixed siblings.
    pub fn scope_summary(
        &self,
        generation: &str,
        revision: u64,
        scope: Option<&str>,
    ) -> Result<IndexSummary> {
        self.check_revision(generation, revision)?;
        let wanted = checked_scope(scope)?;
        let mut summary = self.summary();
        summary.candidate_count = 0;
        summary.estimated_bytes = 0;
        summary.bytes_partial = false;
        summary.selected_count = 0;
        summary.selected_bytes = 0;
        summary.selected_bytes_partial = false;
        summary.risk_counts = RiskCounts::default();
        summary.selected_risk_counts = RiskCounts::default();
        for (position, record) in self.records.iter().enumerate() {
            if !record.active || !within_scope(self.strings.get(record.scope), wanted.as_deref()) {
                continue;
            }
            summary.candidate_count += 1;
            summary.estimated_bytes += record.bytes;
            summary.bytes_partial |= record.known == Some(false);
            *risk_counter(&mut summary.risk_counts, record.risk) += 1;
            if self.selected[position] {
                summary.selected_count += 1;
                summary.selected_bytes += record.bytes;
                summary.selected_bytes_partial |= record.known == Some(false);
                *risk_counter(&mut summary.selected_risk_counts, record.risk) += 1;
            }
        }
        Ok(summary)
    }

    /// Immediate children with descendant totals. The target root's own items
    /// have the empty key; expanding that row has no folder children. Ordering
    /// is largest first with first-observation ties, independent of queue changes.
    pub fn folders(
        &self,
        generation: &str,
        revision: u64,
        scope: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<FolderPage> {
        self.check_revision(generation, revision)?;
        let parent = checked_scope(scope)?;
        if offset > MAX_RECORDS || limit == 0 || limit > MAX_PAGE_RECORDS {
            return Err(DiscoveryError("folder query limit exceeded"));
        }
        let mut groups: HashMap<&str, FolderTotals> = HashMap::new();
        let mut charged = 0usize;
        for (position, record) in self.records.iter().enumerate() {
            if !record.active {
                continue;
            }
            let scope = self.strings.get(record.scope);
            let Some(key) = child_key(scope, parent.as_deref()) else {
                continue;
            };
            if !groups.contains_key(key) {
                // Hash storage, capacity growth and the eventual sort references.
                charged += std::mem::size_of::<FolderTotals>() * 2 + 96;
                if charged > MAX_FOLDER_WORK_BYTES {
                    return Err(DiscoveryError("folder aggregation memory limit exceeded"));
                }
            }
            let group = groups.entry(key).or_insert_with(|| FolderTotals {
                first_seen: position,
                ..FolderTotals::default()
            });
            group.count += 1;
            group.bytes += record.bytes;
            group.partial |= record.known == Some(false);
            group.own_count += usize::from(scope == key);
            group.has_children |= scope != key;
            *risk_counter(&mut group.risks, record.risk) += 1;
            if self.selected[position] {
                group.selected_count += 1;
                group.selected_bytes += record.bytes;
                group.selected_partial |= record.known == Some(false);
                *risk_counter(&mut group.selected_risks, record.risk) += 1;
            }
        }
        let mut ordered: Vec<_> = groups.iter().collect();
        ordered
            .sort_by(|(_, a), (_, b)| b.bytes.cmp(&a.bytes).then(a.first_seen.cmp(&b.first_seen)));
        let matching_count = ordered.len();
        let mut folders = Vec::new();
        let mut bytes = 2048 + parent.as_deref().map_or(0, |key| key.len() * 6);
        for (key, group) in ordered.into_iter().skip(offset).take(limit) {
            let charge = key.len() * 6 + 768;
            if bytes + charge > MAX_PAGE_BYTES {
                if folders.is_empty() {
                    return Err(DiscoveryError("folder exceeds reply byte limit"));
                }
                break;
            }
            bytes += charge;
            let mut totals = self.summary();
            totals.candidate_count = group.count;
            totals.estimated_bytes = group.bytes;
            totals.bytes_partial = group.partial;
            totals.selected_count = group.selected_count;
            totals.selected_bytes = group.selected_bytes;
            totals.selected_bytes_partial = group.selected_partial;
            totals.risk_counts = group.risks.clone();
            totals.selected_risk_counts = group.selected_risks.clone();
            folders.push(Folder {
                key: (*key).to_owned(),
                own_count: group.own_count,
                has_children: group.has_children,
                totals,
            });
        }
        let next = offset + folders.len();
        Ok(FolderPage {
            generation: self.generation.clone(),
            revision: self.revision,
            scope: parent.map(Cow::into_owned),
            matching_count,
            offset,
            next_offset: (next < matching_count).then_some(next),
            folders,
            summary: self.summary(),
        })
    }

    /// Atomic metadata-only bulk change with constant temporary storage. A caller
    /// must explicitly include dangerous rows; blocked rows are never queueable.
    pub fn select_scope(
        &mut self,
        generation: &str,
        revision: u64,
        scope: Option<&str>,
        selected: bool,
        include_dangerous: bool,
    ) -> Result<IndexSummary> {
        self.check_revision(generation, revision)?;
        let wanted = checked_scope(scope)?;
        if self.revision >= SAFE_INTEGER {
            return Err(DiscoveryError("discovery revision overflow"));
        }
        let mut changed = false;
        for position in 0..self.records.len() {
            let record = &self.records[position];
            if !record.active
                || !within_scope(self.strings.get(record.scope), wanted.as_deref())
                || (selected
                    && (record.risk == RiskTier::Blocked
                        || (!include_dangerous && record.risk == RiskTier::Dangerous)))
                || self.selected[position] == selected
            {
                continue;
            }
            self.set_selected(position, selected);
            changed = true;
        }
        self.revision += u64::from(changed);
        Ok(self.summary())
    }

    fn select_inner(&mut self, ids: &[String], selected: bool) -> Result<bool> {
        let mut positions = Vec::new();
        for id in ids {
            let position = *self
                .by_id
                .get(id)
                .ok_or(DiscoveryError("unknown candidate ID"))?;
            if !self.records[position].active {
                return Err(DiscoveryError("retired candidate cannot be queued"));
            }
            if selected && self.records[position].risk == RiskTier::Blocked {
                return Err(DiscoveryError("blocked candidate cannot be queued"));
            }
            positions.push(position);
        }
        let mut changed = false;
        for position in positions {
            if self.selected[position] != selected {
                changed = true;
                self.set_selected(position, selected);
            }
        }
        Ok(changed)
    }

    fn set_selected(&mut self, position: usize, selected: bool) {
        let record = &self.records[position];
        let partial = usize::from(record.known == Some(false));
        let risk = risk_counter(&mut self.selected_risk_counts, record.risk);
        if selected {
            self.selected_count += 1;
            self.selected_bytes += record.bytes;
            self.selected_partial_count += partial;
            *risk += 1;
        } else {
            self.selected_count -= 1;
            self.selected_bytes -= record.bytes;
            self.selected_partial_count -= partial;
            *risk -= 1;
        }
        self.selected[position] = selected;
    }

    /// Retire only IDs accounted for by a caller's trusted apply report.
    /// This mutates review metadata, never the filesystem. Validate the entire
    /// bounded batch before changing any row or aggregate.
    pub fn retire(
        &mut self,
        generation: &str,
        revision: u64,
        ids: &[String],
    ) -> Result<IndexSummary> {
        self.check_revision(generation, revision)?;
        if ids.len() > MAX_PAGE_RECORDS || self.revision >= SAFE_INTEGER {
            return Err(DiscoveryError(
                "retirement batch or revision limit exceeded",
            ));
        }
        let mut positions = Vec::with_capacity(ids.len());
        for id in ids {
            let position = *self
                .by_id
                .get(id)
                .ok_or(DiscoveryError("unknown candidate ID"))?;
            if !self.records[position].active || positions.contains(&position) {
                return Err(DiscoveryError("duplicate or retired candidate ID"));
            }
            positions.push(position);
        }
        for &position in &positions {
            if self.selected[position] {
                self.set_selected(position, false);
            }
            let record = &mut self.records[position];
            record.active = false;
            self.candidate_count -= 1;
            self.total_bytes -= record.bytes;
            self.partial_count -= usize::from(record.known == Some(false));
            *risk_counter(&mut self.risk_counts, record.risk) -= 1;
        }
        self.revision += u64::from(!positions.is_empty());
        Ok(self.summary())
    }

    pub fn select(
        &mut self,
        generation: &str,
        revision: u64,
        ids: &[String],
        selected: bool,
    ) -> Result<IndexSummary> {
        self.check_revision(generation, revision)?;
        if ids.len() > MAX_PAGE_RECORDS || ids.iter().any(|id| id.len() > 80) {
            return Err(DiscoveryError("selection batch limit exceeded"));
        }
        if self.revision >= SAFE_INTEGER {
            return Err(DiscoveryError("discovery revision overflow"));
        }
        if self.select_inner(ids, selected)? {
            self.revision += 1;
        }
        Ok(self.summary())
    }

    fn candidate(&self, record: &Record) -> ScanCandidate {
        let text = &self.strings;
        ScanCandidate {
            entry: ScanEntry {
                path: format!("{}{}", text.get(record.parent), text.get(record.leaf)),
                name: text.get(record.name).to_owned(),
                identity: record.identity.map(|i| FilesystemIdentity {
                    platform: text.get(i[0]).to_owned(),
                    device: text.get(i[1]).to_owned(),
                    inode: text.get(i[2]).to_owned(),
                }),
                estimated_bytes: record.bytes,
                bytes_known: record.known,
                modified_ms: record.modified,
                is_symlink: record.symlink,
                entry_type: record.entry_type,
            },
            id: text.get(record.id).to_owned(),
            kind: text.get(record.kind).to_owned(),
            risk_tier: record.risk,
            reasons: record
                .reasons
                .iter()
                .map(|s| text.get(*s).to_owned())
                .collect(),
            selected_by_default: record.default,
            project_active_ms: None,
        }
    }

    pub fn query(&self, query: &Query, cancelled: &AtomicBool) -> Result<Page> {
        self.check_revision(&query.generation, query.revision)?;
        if query.filter.len() > MAX_TEXT_BYTES
            || query.scope.as_ref().is_some_and(|s| s.len() > 32_768)
            || query.limit == 0
            || query.limit > MAX_PAGE_RECORDS
            || query.offset > MAX_RECORDS
            || query.now > SAFE_INTEGER
        {
            return Err(DiscoveryError("discovery query limit exceeded"));
        }
        let terms: Vec<_> = query
            .filter
            .to_lowercase()
            .split(filter_whitespace)
            .filter(|term| !term.is_empty())
            .map(str::to_owned)
            .collect();
        let wanted_scope = checked_scope(query.scope.as_deref())?;
        let mut matches = Vec::new();
        let mut matching_bytes = 0;
        let mut matching_partial = false;
        for (position, record) in self.records.iter().enumerate() {
            if position % 256 == 0 && cancelled.load(Ordering::Acquire) {
                return Err(DiscoveryError("discovery query cancelled"));
            }
            if !record.active {
                continue;
            }
            let scope = self.strings.get(record.scope);
            if !within_scope(scope, wanted_scope.as_deref())
                || query.risk.is_some_and(|wanted| wanted != record.risk)
            {
                continue;
            }
            if !terms.iter().all(|term| {
                matches_term(
                    term,
                    record,
                    &self.strings,
                    self.selected[position],
                    query.now,
                )
            }) {
                continue;
            }
            matching_bytes = add_bytes(matching_bytes, record.bytes)?;
            matching_partial |= record.known == Some(false);
            matches.push(position);
        }
        // Sorting is one bounded native job. It cannot mutate records or selection.
        match query.order {
            QueryOrder::Discovery => {}
            QueryOrder::Size => matches.sort_by(|a, b| {
                self.records[*b]
                    .bytes
                    .cmp(&self.records[*a].bytes)
                    .then(a.cmp(b))
            }),
            QueryOrder::Name => matches.sort_by(|a, b| {
                self.strings
                    .get(self.records[*a].name)
                    .cmp(self.strings.get(self.records[*b].name))
                    .then(a.cmp(b))
            }),
            QueryOrder::Age => matches.sort_by(|a, b| {
                self.records[*a]
                    .modified
                    .unwrap_or(u64::MAX)
                    .cmp(&self.records[*b].modified.unwrap_or(u64::MAX))
                    .then(a.cmp(b))
            }),
        }
        if cancelled.load(Ordering::Acquire) {
            return Err(DiscoveryError("discovery query cancelled"));
        }
        let matching_count = matches.len();
        let mut candidates = Vec::new();
        let mut page_bytes = 2048;
        for position in matches.into_iter().skip(query.offset).take(query.limit) {
            let record = &self.records[position];
            let characters = record.parent.len as usize
                + record.leaf.len as usize
                + record.name.len as usize
                + record.id.len as usize
                + record.kind.len as usize
                + record
                    .reasons
                    .iter()
                    .map(|span| span.len as usize)
                    .sum::<usize>()
                + record.identity.as_ref().map_or(0, |spans| {
                    spans.iter().map(|span| span.len as usize).sum::<usize>()
                });
            // JSON escaping is at most six bytes per input byte. Include fixed fields.
            let charge = characters
                .checked_mul(6)
                .and_then(|n| n.checked_add(512 + record.reasons.len() * 3))
                .ok_or(DiscoveryError("page byte counter overflow"))?;
            if page_bytes + charge > MAX_PAGE_BYTES {
                if candidates.is_empty() {
                    return Err(DiscoveryError(
                        "candidate exceeds discovery page byte limit",
                    ));
                }
                break;
            }
            page_bytes += charge;
            candidates.push(self.candidate(record));
        }
        let next = query.offset + candidates.len();
        Ok(Page {
            generation: self.generation.clone(),
            revision: self.revision,
            matching_count,
            matching_bytes,
            matching_bytes_partial: matching_partial,
            next_offset: (next < matching_count).then_some(next),
            candidates,
            summary: self.summary(),
        })
    }
}

// Match JavaScript /\s/ in the reference filter, including BOM but excluding NEL.
fn filter_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn risk_name(risk: RiskTier) -> &'static str {
    match risk {
        RiskTier::Safe => "safe",
        RiskTier::Caution => "caution",
        RiskTier::Dangerous => "dangerous",
        RiskTier::Blocked => "blocked",
    }
}

fn quantity(text: &str, units: &[(&str, f64)]) -> Option<f64> {
    let split = text.find(|c: char| !c.is_ascii_digit() && c != '.')?;
    let mut parts = text[..split].split('.');
    let integer = parts.next()?;
    if integer.is_empty() || !integer.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if parts
        .next()
        .is_some_and(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()))
        || parts.next().is_some()
    {
        return None;
    }
    let number = text[..split].parse::<f64>().ok()?;
    let unit = units.iter().find(|(unit, _)| *unit == &text[split..])?.1;
    let result = number * unit;
    Some(result)
}

fn matches_term(
    raw: &str,
    candidate: &Record,
    strings: &Strings,
    selected: bool,
    now: u64,
) -> bool {
    let negated = raw.starts_with('!') && raw.len() > 1;
    let term = if negated { &raw[1..] } else { raw };
    let bytes = candidate.bytes as f64;
    let units = [
        ("b", 1.0),
        ("k", 1024.0),
        ("kb", 1024.0),
        ("kib", 1024.0),
        ("m", 1048576.0),
        ("mb", 1048576.0),
        ("mib", 1048576.0),
        ("g", 1073741824.0),
        ("gb", 1073741824.0),
        ("gib", 1073741824.0),
        ("t", 1099511627776.0),
        ("tb", 1099511627776.0),
        ("tib", 1099511627776.0),
    ];
    let mut result = None;
    for operator in [">=", "<=", ">", "<"] {
        if let Some(value) = term
            .strip_prefix(operator)
            .and_then(|s| quantity(s, &units))
        {
            result = Some(match operator {
                ">=" => bytes >= value,
                "<=" => bytes <= value,
                ">" => bytes > value,
                _ => bytes < value,
            });
            break;
        }
    }
    if result.is_none() {
        if let Some((key, value)) = term.split_once(':').filter(|(_, v)| !v.is_empty()) {
            result = match key {
                "kind" => Some(strings.get(candidate.kind).to_lowercase().contains(value)),
                "risk" => Some(risk_name(candidate.risk) == value),
                "path" => Some(
                    format!(
                        "{}{}",
                        strings.get(candidate.parent),
                        strings.get(candidate.leaf)
                    )
                    .to_lowercase()
                    .contains(value),
                ),
                "is" => match value {
                    "queued" => Some(selected),
                    "unqueued" => Some(!selected),
                    "symlink" => Some(candidate.symlink),
                    "stub" => Some(
                        candidate
                            .reasons
                            .iter()
                            .any(|r| strings.get(*r) == "workspace-stub"),
                    ),
                    "file" => Some(candidate.entry_type == EntryType::File),
                    "dir" => Some(candidate.entry_type == EntryType::Directory),
                    _ => None,
                },
                "older" | "newer" => quantity(
                    value,
                    &[
                        ("m", 60000.0),
                        ("h", 3600000.0),
                        ("d", 86400000.0),
                        ("w", 604800000.0),
                        ("mo", 2592000000.0),
                        ("y", 31536000000.0),
                    ],
                )
                .map(|span| {
                    candidate.modified.is_some_and(|modified| {
                        let age = now as f64 - modified as f64;
                        if key == "older" {
                            age >= span
                        } else {
                            age < span
                        }
                    })
                }),
                _ => None,
            };
        }
    }
    let matched = result.unwrap_or_else(|| {
        format!(
            "{} {}{} {} {}",
            strings.get(candidate.name),
            strings.get(candidate.parent),
            strings.get(candidate.leaf),
            strings.get(candidate.kind),
            risk_name(candidate.risk)
        )
        .to_lowercase()
        .contains(term)
    });
    if negated {
        !matched
    } else {
        matched
    }
}
