/// Discovery and sizing coexist during progressive scans. Account for both
/// pools instead of allocating eight sizing workers on a one-CPU machine.
/// Two workers retain I/O overlap on small devices; larger allowances leave
/// one CPU outside these pools, subject to the existing sixteen-worker cap.
fn worker_counts(available: usize) -> (usize, usize) {
    let total = available.saturating_sub(1).clamp(2, 16);
    (total / 2, total.div_ceil(2))
}

pub(crate) fn scan_workers() -> (usize, usize) {
    let available = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    worker_counts(available)
}

#[cfg(test)]
mod tests {
    use super::worker_counts;

    #[test]
    fn overlapping_pools_respect_small_and_large_cpu_allowances() {
        assert_eq!(worker_counts(0), (1, 1));
        assert_eq!(worker_counts(1), (1, 1));
        assert_eq!(worker_counts(2), (1, 1));
        for available in 3..=128 {
            let (walk, size) = worker_counts(available);
            assert!((1..=8).contains(&walk));
            assert!((1..=8).contains(&size));
            assert!(walk + size < available);
            assert!(walk + size <= 16);
        }
        assert_eq!(worker_counts(usize::MAX), (8, 8));
    }
}
