# Traversal Architecture & Engine Optimization: Research, Diagnosis, and Target Design

Execution lives in [.plans/traversal-engine.md](../.plans/traversal-engine.md).
Section 6 of this note is not the schedule. Primary-source corrections are
in [.reference/filesystem-traversal.md](../.reference/filesystem-traversal.md).

- **Status:** Active Reference / Architectural Proposal
- **Author:** Antigravity Engineering
- **Date:** 2026-10-01
- **Target:** Rust Engine (`crates/sweep-*`) & JS Engine (`packages/core/src/scanner*`)

---

## 1. Executive Summary & Ground Truth

### The Problem

We set out to build a Rust engine (`crates/sweep-engine`, `crates/sweep-fs`, `crates/sweep-engine-cli`) to give `sweep` native speed, low overhead, and rock-solid memory safety. However, on larger real-world trees, the Rust backend can feel **slower, heavier, and less responsive** than the JS backend.

### Why is this happening?

The perception that _"our Rust backend is making things worse"_ is grounded in real architectural bottlenecks:

1. **The Sizing Inversion (The Biggest Bottleneck):** While the JS engine scans files in JS, it **does not size large trees in JS**. On Linux and macOS, JS delegates directory sizing to GNU/BSD `du -sb` via batched subprocesses. GNU `du` is written in C, uses direct kernel buffers (`getdents64`), and issues almost zero memory allocations. By contrast, the Rust engine replaced `du` with a **naive, in-process recursive walk (`apparent_size`)** that issues an `lstat` syscall and allocates a `Utf8PathBuf` on the heap for **every single file** inside dependencies. For a 300,000-file tree, Rust issues 300,000 individual `lstat` syscalls and heap allocations across 8 threads, completely drowning in syscall and allocation overhead.
2. **The IPC Pipe Tax:** The Rust engine runs as a separate CLI subprocess (`sweep-engine scan`). Communicating via an OS pipe using NDJSON requires Rust to serialize tens of thousands of JSON lines, stream them through a 64 KB kernel pipe buffer, and force Bun/Node to decode UTF-8 chunks, split lines, parse JSON objects in V8, and trigger heavy garbage collection.
3. **Rayon Fork-Join per Directory:** In `crates/sweep-fs/src/lib.rs`, `walk_dir` calls `subdirs.par_iter().map(...).collect()` at **every directory node**. For directories with only 1 or 2 subfolders, the task-stealing and allocation overhead dwarfs the actual directory read.
4. **Global Mutex Contention:** Every single directory visited by any Rayon worker thread acquires a single global `Mutex<HashSet<(u64, u64)>>` for inode cycle detection. On multi-core CPUs, threads spend substantial time waiting on lock contention.
5. **Redundant Syscalls:** On Unix, `mark_dir` and `is_reparse_point_or_symlink` perform up to 3 `lstat` syscalls per directory even though `read_dir`'s `d_type` already knows whether the entry is a directory or symlink.

Meanwhile, the JS engine has its own severe scaling flaws:

- **Unbounded Async Tasks:** JS creates `mapPool(childDirs, 16)` per directory, resulting in exponential branching where thousands of concurrent promises starve Node/Bun's fixed libuv threadpool (default 4 threads).
- **Catastrophic Regex Backtracking:** Translating globs directly to regexes causes exponential backtracking that can stall scans for seconds.

By adopting the proven architectures of state-of-the-art tools (**GNU `du`**, **BurntSushi's `ignore` / `ripgrep`**, **`fd`**, **`dust`**, and **`jwalk`**), we can make both our Rust and JS engines best-in-class: faster, memory-lean, safe from leaks and symlink races, and mathematically correct.

---

## 2. Dissecting the Gold Standard: What Makes `du`, `fd`, and `ripgrep` So Fast?

To build the fastest possible traversal engine, we must understand the engineering decisions behind the tools that dominate performance benchmarks.

### 2.1 GNU `du` (Coreutils)

_Primary Source: GNU Coreutils `src/du.c` and gnulib `lib/fts.c`_

1. **`fts` File Tree Stream & Directory File Descriptors (`dirfd`):**
   Instead of concatenating and resolving string paths at every depth (`/a/b/c/d/...`), `fts` maintains open directory file descriptors and uses `fstatat(dirfd, filename, &statbuf, AT_SYMLINK_NOFOLLOW)`. This saves the kernel from re-walking the path hierarchy from root on every syscall.
2. **Trusting `d_type`:**
   GNU `du` reads directory streams using `getdents64`. On modern filesystems (ext4, xfs, btrfs, APFS), the directory block stores the entry type (`DT_DIR`, `DT_REG`, `DT_LNK`). `du` only issues `stat`/`fstatat` when size is strictly required or when `d_type == DT_UNKNOWN`.
3. **Selective Hardlink Deduplication (The `st_nlink` Insight):**
   Double-counting hardlinks (e.g. in `pnpm` stores or deduplicated caches) inflates apparent size by gigabytes. But keeping a hash table of every inode visited consumes immense RAM.
   - **`du`'s secret:** It checks `st_nlink`. If `st_nlink <= 1`, the file **cannot** be a hardlink alias. It records the size and immediately discards the inode.
   - Only when `st_nlink > 1` does `du` look up or insert `(st_dev, st_ino)` into its hash table. Because 99.9% of files in typical trees have `nlink == 1`, `du`'s memory footprint remains nearly flat.
4. **Physical Blocks vs Apparent Size:**
   Standard `du` calculates `st_blocks * 512`, representing physical disk allocation (accounting for filesystem block size and sparse file holes). `du -b` sums `st_size` (apparent bytes).

### 2.2 `ripgrep` & `fd` (`ignore::WalkParallel`)

_Primary Source: `BurntSushi/ripgrep` (`ignore/src/walk.rs`)_

1. **Work-Stealing Deque Concurrency (Not Fork-Join):**
   Rather than recursive Rayon parallel iterators, `WalkParallel` uses a fixed thread pool paired with **`crossbeam-deque`**:
   - Each worker thread maintains a local work deque of directories.
   - When a thread reads a directory, it pushes child directories to its local deque.
   - Threads pop work from their own deque (depth-first, cache-hot).
   - When a thread runs out of work, it **steals** from the back of other threads' deques.
   - This eliminates thread creation/join churn and keeps CPU cores evenly saturated regardless of tree shape.
2. **Zero-Allocation Path Management:**
   Workers do **not** allocate `PathBuf` for every file. Each worker thread maintains **one reusable path buffer** on the stack/thread state. As it enters a directory, it calls `path.push(name)`. When it leaves, it calls `path.pop()`.
3. **Pruning on Raw Byte Slices (`&[u8]` / `&OsStr`):**
   Filename filtering occurs against the raw directory entry name **before** any path concatenation, UTF-8 validation, or `stat` syscall. If a folder is `.git` or matches an ignore pattern, the subtree is skipped immediately at zero syscall cost.
4. **Bounded Lock-Free Streaming Channels:**
   Results are pushed into a bounded `crossbeam-channel`. The consumer (e.g. renderer or serializer) drains the channel. If the consumer is slow, the channel backpressures the workers, naturally capping memory usage.

### 2.3 `dust` (`du-dust`) & `jwalk`

1. **`jwalk`:** Specifically created because standard `walkdir` is single-threaded and Rayon fork-join has too much overhead for shallow trees. It batches directory entries into chunks before sending across channels, amortizing synchronization overhead.
2. **`dust`:** Uses `rayon` only across top-level branches, then walks subtrees with optimized path-buffers and fast `FxHashSet` (using `rustc-hash`, not slow cryptographically secure SipHash) for tracking visited inodes.

---

## 3. Deep Diagnosis: What is Holding `sweep` Back?

### 3.1 The Rust Backend Bottlenecks

```
Current Rust Pipeline (Bottlenecks Highlighted):
┌───────────────────────────────┐
│ Rayon par_iter at every dir   │ ──► Fine-grained scheduling overhead on shallow dirs
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│ Global Mutex<HashSet<dev,ino>>│ ──► Lock contention across all 8-16 worker threads
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│ Redundant lstat syscalls      │ ──► mark_dir + is_reparse_point_or_symlink (ignores d_type)
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│ Naive apparent_size Walk      │ ──► 300,000 lstat syscalls + PathBuf allocations in node_modules
└──────────────┬────────────────┘
               ▼
┌───────────────────────────────┐
│ NDJSON stdout OS Pipe to Node │ ──► String serialization + pipe ping-pong + V8 JSON.parse GC thrash
└───────────────────────────────┘
```

#### Detailed Breakdown:

1. **The Naive In-Process Sizer (`apparent_size` in `crates/sweep-fs/src/lib.rs:604`):**

   ```rust
   for item in read_dir.flatten() {
       let Ok(child) = Utf8PathBuf::from_path_buf(item.path()) else { continue; };
       let Ok(child_meta) = fs::symlink_metadata(child.as_std_path()) else { continue; };
       total += inner(&child_meta, &child);
   }
   ```

   - For every single file in every dependency, it allocates a new `Utf8PathBuf` (heap string allocation) and executes an `lstat` syscall.
   - For a monorepo with 30 `node_modules` folders containing 400,000 files, Rust performs **400,000 `lstat` syscalls and 400,000 heap allocations**.
   - JS, by contrast, spawns 4 concurrent `du -sb` commands. GNU `du` scans those directories in compiled C with zero allocations, making JS seem significantly faster at sizing!

2. **Rayon Task Overhead in `walk_matched_entries_with_hooks` (`crates/sweep-fs/src/lib.rs:410`):**

   ```rust
   let child_results: Vec<WalkResult> = subdirs
       .par_iter()
       .map(|subdir| walk_dir(ctx, subdir, depth + 1))
       .collect();
   for child in child_results {
       result.entries.extend(child.entries);
       ...
   }
   ```

   - If a directory has 1 or 2 subdirectories, invoking `subdirs.par_iter()` creates tasks, closures, and steals work inside Rayon's threadpool.
   - Each level returns a `WalkResult` containing a `Vec<WalkEntry>`, which is repeatedly extended and reallocated as the recursion unwinds.

3. **Global Inode Mutex Contention (`crates/sweep-fs/src/lib.rs:242`):**

   ```rust
   match visited.lock() {
       Ok(mut guard) => guard.insert((meta.dev(), meta.ino())),
       Err(_) => true,
   }
   ```

   - Every directory processed by any Rayon thread must lock the same `std::sync::Mutex`. On 16-core systems, worker threads spend substantial CPU time waiting for this mutex.

4. **Redundant Syscalls on Linux/macOS:**
   - In `walk_dir`, `read_dir` returns `DirEntry`, whose `file_type()` already provides `d_type` without an extra syscall.
   - Yet line 360 calls `is_reparse_point_or_symlink(&full_path)`, which executes `fs::symlink_metadata` again.
   - Then when entering that directory, line 312 calls `mark_dir`, which executes `fs::symlink_metadata` a third time!

5. **Subprocess IPC & Serialization Bottleneck:**
   - When running via `apps/cli` (`--engine rust`), Rust writes candidate events as NDJSON strings over stdout.
   - Node reads from the OS pipe, decodes UTF-8, splits strings, and calls `JSON.parse` for each candidate.
   - For 50,000 candidates, this generates ~25 MB of JSON text, millions of string allocations in V8, and severe GC pauses.

---

### 3.2 The JS Backend Bottlenecks

1. **Unbounded Concurrency & Threadpool Starvation (`packages/core/src/scanner.ts:532`):**

   ```typescript
   if (childDirs.length > 0) {
     await mapPool(childDirs, TRAVERSAL_CONCURRENCY, (child) => walkDir(child));
   }
   ```

   - `mapPool` with concurrency 16 is created **per directory frame**.
   - If a directory has 16 subdirs, each having 16 subdirs, there are $16 \times 16 = 256$ concurrent promises in flight.
   - Node's `libuv` default thread pool has only **4 threads** for filesystem I/O. Having thousands of pending `readdir`/`lstat` promises causes massive queuing, latency spikes, and event-loop lag.

2. **Catastrophic Regex Backtracking in Glob Translation (`packages/core/src/config.ts:382`):**
   - Naive conversion of user ignore patterns (`**`, `*`, `?`) to JavaScript `RegExp` without anchor bounding or atomic grouping leads to catastrophic backtracking on path matching.
   - A single pathological pattern was demonstrated in the audit to take over 1.1 seconds for a single filename.

3. **Memory Footprint of Inode Strings:**
   - `visitedDirs` stores visited directories as strings: `Set<"${dev}:${ino}">`. For deep monorepos, keeping tens of thousands of formatted strings in the V8 heap wastes memory and adds GC pressure.

---

## 4. Edge Cases, Security & P99 Invariants

Any high-performance rewrite must preserve `sweep`'s core rule: **Trust first. Correctness over convenience.**

| Edge Case                              | Risk                                                                                                                              | How to Solve Correctly                                                                                                                                             |
| :------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hardlink Duplication**               | Scanning a project with `pnpm` or hardlinked caches counts the same file hundreds of times, falsely inflating sizes by gigabytes. | Use `st_nlink`: if `nlink <= 1`, do not track. If `nlink > 1`, deduplicate via `FxHashSet<(u64, u64)>` (inode + device).                                           |
| **Symlink Loops & Cycles**             | Recursive symlinks or bind mounts can cause infinite recursion.                                                                   | Track visited directory `(dev, ino)`. Never follow symlinks when calculating apparent size or descending candidate paths.                                          |
| **Windows Reparse Points & Junctions** | Directory junctions on NTFS can point to root or ancestors. `is_symlink()` is false on Windows for junctions.                     | Check NTFS reparse point attribute (`FILE_ATTRIBUTE_REPARSE_POINT = 0x400`). Treat directory reparse points as symlinks (do not descend).                          |
| **Case-Folding Collisions**            | macOS (APFS) and Windows (NTFS) fold case (`.GIT` == `.git`, `node_modules` == `Node_Modules`). Linux (ext4) is case-sensitive.   | Use case-insensitive matching on Windows and macOS; exact byte-matching on Linux.                                                                                  |
| **Path Length Limits**                 | Deep monorepo paths exceed Windows `MAX_PATH` (260 characters).                                                                   | Use UNC verbatim prefix (`\\?\`) on Windows so paths up to 32,767 characters do not trigger `ERROR_BUFFER_OVERFLOW`.                                               |
| **Uncooperative Cancellation**         | Killing Rust with `SIGKILL` during delete leaves half-deleted directories without an audit log or report.                         | Use cooperative cancellation: catch `SIGINT`/cancellation flag, stop dispatching new deletions, finish in-flight jobs, and emit an accurate partial `ApplyReport`. |
| **Cross-Device Boundaries**            | Scans could accidentally wander into network mounts or mounted drives.                                                            | Track `st_dev`. Allow users to configure `--one-file-system` to block crossing mount points.                                                                       |

---

## 5. Target Architecture: The Best of Both Worlds

We can achieve a dramatic performance leap by modernizing both engines according to their respective strengths.

```
Target Engine Architecture:

┌────────────────────────────────────────────────────────┐
│               Rust Engine 2.0                          │
│                                                        │
│  [ crossbeam-deque Work-Stealing Traversal Pool ]      │
│     │                                                  │
│     ├── Zero-allocation PathBuf stack per thread       │
│     ├── Dirent d_type inspection (Zero lstat on dirs)  │
│     ├── Sharded / Thread-local Inode Cycle Cache       │
│     │                                                  │
│     ▼                                                  │
│  [ Ultra-Fast In-Process Sizer 2.0 ]                   │
│     ├── Selective Hardlink Dedupe (only if nlink > 1)  │
│     ├── Fast Dirfd / Openat buffer reuse               │
│     ├── Direct byte summation without PathBuf clones   │
│     │                                                  │
│     ▼                                                  │
│  [ Bounded crossbeam-channel ]                         │
│     │                                                  │
│     ├── Batched Chunk Streaming (~64 candidates/flush) │
│     └── Direct N-API / Bun FFI Bridge (Zero-Copy)      │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│               JS Engine 2.0                            │
│                                                        │
│  [ Global Bounded Async Work Queue (Max 16-32) ]       │
│     ├── Single queue across entire tree recursion      │
│     ├── Protects libuv threadpool from starvation      │
│     │                                                  │
│  [ Non-Backtracking Glob Matcher ]                     │
│     ├── Split into exact prefixes, extensions & globs  │
│     │                                                  │
│  [ Numeric BigInt Inode Set ]                          │
│     └── (BigInt(dev) << 64n) | BigInt(ino)             │
└────────────────────────────────────────────────────────┘
```

### 5.1 Modernizing the Rust Engine

#### A. Traversal: Replace Rayon Fork-Join with `crossbeam-deque`

Instead of calling `subdirs.par_iter()` at every directory node:

1. Spin up a worker pool sized to `num_cpus::get()`.
2. Each worker has a local `crossbeam_deque::Worker<Utf8PathBuf>`.
3. Workers push child directories to their local deque and pop them LIFO (depth-first traversal maximizes cache locality).
4. When a thread's deque is empty, it steals from the FIFO end of peer deques (`crossbeam_deque::Stealer`).
5. Maintain a **single reusable path buffer** per thread rather than allocating `PathBuf` for every entry.

#### B. Eliminate Syscalls Using `d_type`

- Check `entry.file_type()` from `read_dir`.
- On Linux and macOS, this reads the `d_type` field directly from the kernel `dirent64` buffer.
- If `d_type == DT_DIR`: we **know** it is a directory. Do not call `lstat`!
- If `d_type == DT_LNK`: we **know** it is a symlink. Do not call `lstat`!
- Only call `symlink_metadata` on Windows (for reparse point checking) or when `d_type == DT_UNKNOWN` (e.g. on older NFS mounts).

#### C. Build an Ultra-Fast In-Process Directory Sizer

Instead of naive recursive `read_dir` + `symlink_metadata` per file:

1. Stream directory entries using raw dirent buffers.
2. In-process file size extraction:
   - For regular files, query size.
   - Do **not** allocate `Utf8PathBuf` or strings for files inside `node_modules`! Accumulate sizes directly into a primitive `u64` accumulator.
   - Only insert into the visited inode hash table if `st_nlink > 1`.
3. Use `rustc-hash` (`FxHashSet`), which is 5x-10x faster than standard library `SipHash` for 64-bit integer keys.

#### D. Sharded Inode Cycle Detection

Instead of a single `Mutex<HashSet<(u64, u64)>>` across all threads:

- Use sharded locks (e.g. 16 or 32 buckets hashed by `inode % 32`), or a lock-free concurrent hash set (like `dashmap`).
- Threads will almost never contend on the same lock.

#### E. Native Addon (N-API / Bun FFI) Option

- For maximum CLI performance, allow the JS CLI to load the Rust engine as a native library (`.node` or Bun FFI) when running interactively.
- This eliminates child process spawning, pipe I/O, string formatting, and JSON parsing completely.
- Keep the standalone executable `sweep-engine` for headless/CI automation (`sweep-engine scan --json-stream`).

---

### 5.2 Modernizing the JS Engine

#### A. Global Bounded Async Work Queue

Replace per-directory `mapPool` with a **single global work queue**:

```typescript
class GlobalAsyncQueue {
  private inflight = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inflight >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inflight++;
    try {
      return await fn();
    } finally {
      this.inflight--;
      this.queue.shift()?.();
    }
  }
}
```

- Cap global filesystem promises to 16 or 32 across the entire scan.
- Prevents thread pool exhaustion and keeps the event loop responsive.

#### B. Safe, Fast Glob Matching

- Separate patterns into:
  - Exact literals (`Set<string>`): $O(1)$ lookup.
  - Suffix extensions (e.g. `*.tsbuildinfo` -> `name.endsWith(".tsbuildinfo")`): $O(K)$.
  - Path prefixes (e.g. `foo/**` -> prefix check): $O(K)$.
- Avoid compiling user glob patterns into unanchored recursive regexes.

#### C. BigInt Inode Storage

- Store visited directories as 128-bit composite BigInts:
  ```typescript
  const key = (BigInt(stat.dev) << 64n) | BigInt(stat.ino);
  if (visited.has(key)) return false;
  visited.add(key);
  ```
- Eliminates string creation and string garbage collection during traversal.

---

## 6. Implementation & Verification Roadmap

### Phase 1: Immediate Rust FS Quick-Wins (High Impact, Low Risk)

1. **Remove redundant `lstat` syscalls in `crates/sweep-fs/src/lib.rs`**: Use `entry.file_type()` directly; bypass `is_reparse_point_or_symlink` on Unix.
2. **Zero-allocation sizing**: Update `apparent_size` to accumulate bytes without creating `Utf8PathBuf` per child file.
3. **Hardlink optimization**: Only track inodes when `st_nlink > 1`.
4. **Sharded visited cache**: Replace the single `Mutex<HashSet>` with sharded buckets.
5. **Fix quadratic apply selection**: Change `plan.selected_candidate_ids.contains()` in `apply.rs` from `Vec` to `HashSet`.

### Phase 2: Engine Concurrency Architecture

1. **Work-stealing traversal**: Integrate `crossbeam-deque` or `jwalk` pattern in `sweep-fs`.
2. **Batch channel streaming**: Stream discovered candidates in chunks of 64 directly to the sizer and stdout emitter.
3. **Global queue in JS scanner**: Replace per-dir `mapPool` in `scanner.ts` with a global concurrency throttle.

### Phase 3: Zero-Overhead Integration & P99 Hardening

1. **Native N-API / Bun FFI binding**: Provide in-process execution for the CLI.
2. **Cooperative cancellation in Rust `apply`**: Handle signals gracefully, reporting exact executed deletions.
3. **Regression & scale benchmarks**: Add a 100k-file fixture benchmark to `packages/core/benchmarks/`.

---

## 7. Conclusion

The Rust backend is not fundamentally flawed; it was simply penalized by **a naive in-process recursive sizing walk that did 300,000 extra syscalls**, **Rayon task overhead on shallow directories**, **lock contention**, and **pipe serialization**.

By adopting the architectural principles of `du` and `ripgrep`—trusting `d_type`, work-stealing concurrency, zero-allocation path handling, and selective hardlink tracking—the Rust backend will decisively outperform the JS engine across all tree sizes, while the JS engine itself will become significantly more resilient.
