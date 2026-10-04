use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use sweep_types::ScanLimits;

/// Conservative logical accounting, not a process RSS measurement.
pub struct ResourceBudget {
    limits: ScanLimits,
    candidates: AtomicUsize,
    directories: AtomicUsize,
    queued: AtomicUsize,
    identities: AtomicUsize,
    paths: AtomicUsize,
    retained: AtomicUsize,
    failed: AtomicBool,
    error: Mutex<Option<String>>,
    sizing: Mutex<(usize, usize, usize, usize)>, // identities, queue, paths, charges
}

impl ResourceBudget {
    pub fn new(limits: ScanLimits) -> Self {
        let budget = Self {
            limits,
            candidates: AtomicUsize::new(0),
            directories: AtomicUsize::new(0),
            queued: AtomicUsize::new(0),
            identities: AtomicUsize::new(0),
            paths: AtomicUsize::new(0),
            retained: AtomicUsize::new(0),
            failed: AtomicBool::new(false),
            error: Mutex::new(None),
            sizing: Mutex::new((0, 0, 0, 0)),
        };
        if [
            limits.max_candidates,
            limits.max_directories,
            limits.max_queued_dirs,
            limits.max_identities,
            limits.max_path_bytes,
            limits.max_retained_bytes,
        ]
        .contains(&0)
        {
            budget.fail("invalid zero scan limit");
        }
        budget
    }

    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }

    pub fn fail(&self, resource: &str) {
        let mut error = self.error.lock().unwrap_or_else(|p| p.into_inner());
        if error.is_none() {
            *error = Some(format!("Scan resource limit exceeded ({resource}); scan is incomplete. Scan a smaller subtree."));
        }
        self.failed.store(true, Ordering::Release);
    }

    pub fn error(&self) -> Option<String> {
        self.error.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn charge(&self, counter: &AtomicUsize, amount: usize, limit: u32, name: &str) -> bool {
        if self.failed() {
            return false;
        }
        // A CAS loop works on both the supported local compiler and newer
        // compilers that deprecate fetch_update in favor of try_update.
        let mut old = counter.load(Ordering::Acquire);
        loop {
            let Some(next) = old
                .checked_add(amount)
                .filter(|&next| next <= limit as usize)
            else {
                self.fail(name);
                return false;
            };
            match counter.compare_exchange_weak(old, next, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return true,
                Err(current) => old = current,
            }
        }
    }

    fn path(&self, bytes: usize, overhead: usize) -> bool {
        let Some(retained) = bytes.checked_mul(4).and_then(|n| n.checked_add(overhead)) else {
            self.fail("path counter overflow");
            return false;
        };
        self.charge(
            &self.paths,
            bytes,
            self.limits.max_path_bytes,
            "maxPathBytes",
        ) && self.charge(
            &self.retained,
            retained,
            self.limits.max_retained_bytes,
            "maxRetainedBytes",
        )
    }

    /// `extra_bytes` covers the other retained string fields (id, name, kind,
    /// reasons) so a plan/stream of huge-field candidates is metered by what
    /// actually stays in memory, not just the path.
    pub fn candidate(&self, path_bytes: usize, extra_bytes: usize) -> bool {
        self.charge(
            &self.candidates,
            1,
            self.limits.max_candidates,
            "maxCandidates",
        ) && self.path(
            path_bytes,
            extra_bytes.saturating_mul(4).saturating_add(1024),
        )
    }

    /// Charge a queued directory job: live queue slot plus retained path
    /// bytes. Runs at discovery push; `dequeue_directory` releases the slot
    /// when the job is popped.
    pub fn queue_dir(&self, path_bytes: usize) -> bool {
        self.charge(
            &self.queued,
            1,
            self.limits.max_queued_dirs,
            "maxQueuedDirs",
        ) && self.path(path_bytes, 128)
    }

    /// Charge the cumulative maxDirectories counter. Runs only after the
    /// (dev,ino) dedup admits a dir - JS parity: an inode alias is a skip,
    /// not an admission, so it must not drain the lifetime budget.
    pub fn admit_directory(&self) -> bool {
        self.charge(
            &self.directories,
            1,
            self.limits.max_directories,
            "maxDirectories",
        )
    }

    pub fn directory(&self, path_bytes: usize) -> bool {
        self.queue_dir(path_bytes) && self.admit_directory()
    }

    pub fn dequeue_directory(&self) {
        self.queued.fetch_sub(1, Ordering::AcqRel);
    }

    pub fn identity(&self) -> bool {
        self.charge(
            &self.identities,
            1,
            self.limits.max_identities,
            "maxIdentities",
        ) && self.charge(
            &self.retained,
            128,
            self.limits.max_retained_bytes,
            "maxRetainedBytes",
        )
    }

    /// Per-job caps for transient sizing structures. Sizing re-walks subtrees
    /// the scan already admitted, so it must not charge the scan-wide counters
    /// again - it is bounded by these local caps instead.
    pub fn sizing_caps(&self) -> (usize, usize) {
        (
            self.limits.max_identities as usize,
            self.limits.max_queued_dirs as usize,
        )
    }

    /// Shared live sizing reservations. Failure is partial sizing, not fatal
    /// discovery exhaustion. Keep this lock around bookkeeping only.
    pub fn sizing_identity(&self) -> bool {
        let mut used = self.sizing.lock().unwrap_or_else(|p| p.into_inner());
        if used.0 >= self.limits.max_identities as usize
            || used
                .3
                .checked_add(128)
                .is_none_or(|n| n > self.limits.max_retained_bytes as usize)
        {
            return false;
        }
        used.0 += 1;
        used.3 += 128;
        true
    }

    pub fn release_sizing_identities(&self, count: usize) {
        let mut used = self.sizing.lock().unwrap_or_else(|p| p.into_inner());
        used.0 -= count;
        used.3 -= count * 128;
    }

    pub fn sizing_directory(&self, bytes: usize) -> bool {
        let Some(retained) = bytes.checked_mul(4).and_then(|n| n.checked_add(128)) else {
            return false;
        };
        let mut used = self.sizing.lock().unwrap_or_else(|p| p.into_inner());
        if used.1 >= self.limits.max_queued_dirs as usize
            || used
                .2
                .checked_add(bytes)
                .is_none_or(|n| n > self.limits.max_path_bytes as usize)
            || used
                .3
                .checked_add(retained)
                .is_none_or(|n| n > self.limits.max_retained_bytes as usize)
        {
            return false;
        }
        used.1 += 1;
        used.2 += bytes;
        used.3 += retained;
        true
    }

    pub fn release_sizing_directories(&self, count: usize, bytes: usize) {
        let mut used = self.sizing.lock().unwrap_or_else(|p| p.into_inner());
        used.1 -= count;
        used.2 -= bytes;
        used.3 -= count * 128 + bytes * 4;
    }
}

impl Default for ResourceBudget {
    fn default() -> Self {
        Self::new(ScanLimits::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_sizing_limits_are_shared_reusable_and_nonfatal() {
        let budget = ResourceBudget::new(ScanLimits {
            max_identities: 1,
            max_queued_dirs: 1,
            max_path_bytes: 4,
            max_retained_bytes: 256,
            ..ScanLimits::default()
        });
        assert!(budget.sizing_identity());
        assert!(!budget.sizing_identity());
        assert!(!budget.sizing_directory(1)); // shared estimated memory limit
        budget.release_sizing_identities(1);
        assert!(budget.sizing_directory(4));
        assert!(!budget.sizing_directory(1));
        budget.release_sizing_directories(1, 4);
        assert!(!budget.sizing_directory(5));
        assert!(budget.sizing_identity());
        budget.release_sizing_identities(1);
        assert!(!budget.failed());
    }
    #[test]
    fn queue_slots_reuse_but_first_failure_sticks() {
        let budget = ResourceBudget::new(ScanLimits {
            max_queued_dirs: 1,
            ..ScanLimits::default()
        });
        assert!(budget.directory(1));
        budget.dequeue_directory();
        assert!(budget.directory(1));
        assert!(!budget.directory(1));
        assert!(!budget.candidate(1, 0));
        assert!(budget.error().is_some_and(|s| s.contains("maxQueuedDirs")));
    }
    #[test]
    fn identities_memory_and_invalid_limits_fail() {
        let budget = ResourceBudget::new(ScanLimits {
            max_identities: 1,
            ..ScanLimits::default()
        });
        assert!(budget.identity());
        assert!(!budget.identity());
        let budget = ResourceBudget::new(ScanLimits {
            max_retained_bytes: 1024,
            ..ScanLimits::default()
        });
        assert!(!budget.candidate(1, 0));
        assert!(ResourceBudget::new(ScanLimits {
            max_candidates: 0,
            ..ScanLimits::default()
        })
        .failed());
    }
}
