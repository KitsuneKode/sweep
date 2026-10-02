# Filesystem traversal: what fast tools actually do

Primary-source notes. Not repo truth. Execution is
[the traversal plan](../.plans/traversal-engine.md).

The plan keeps four sweep-specific choices this research does not make for us:

- Discovery can skip a stat. Sizing a matched artifact still stats every file
  inside it. "Stat only candidates" does not turn `node_modules` into one stat.
- A scan root that is a symlink is not entered. `walkdir` and `ignore` enter one.
- Reported bytes stay apparent size (`st_size`, `du -sb`). This work does not
  switch to `st_blocks`.
- A later directory-fd walk puts `O_NOFOLLOW` on the open. It does not copy
  uutils `safe_du`, which stats no-follow and then opens the child with follow.

Notes for `sweep`'s Rust and JS engines. This file is supporting material,
not a project decision. Fetch date for the trees and pages below: 2026-10-01.

The question: what `du`, `fd`, ripgrep's `ignore` walker, and the parallel
directory-walk crates actually do to stay fast without walking out of the
tree, deleting the wrong path, unbounded memory, or wrong sizes.

## Why this exists

`sweep` has to find cleanup candidates, report sizes, and later unlink only
those paths. A fast walk that follows a symlink, double-counts a hard link,
or buffers every path before it can decide to prune is the wrong trade for
that job. The notes below stay with the implementation or manual that owns
each claim.

## Sources

Snapshots are the default branch as fetched on 2026-10-01 unless a version
is named. No claim below uses a number that is not in one of these texts.

- GNU coreutils `src/du.c` (file copyright 1988–2026) and `gl/lib/xfts.c`:
  <https://github.com/coreutils/coreutils>. `NEWS` in that tree lists stable
  release 9.12 (2026-09-14); the `du.c` read here is master after that tag,
  not a diff against 9.12.
- Gnulib `lib/fts.c`, `lib/fts.in.h`, `lib/i-ring.h`, `lib/stat-size.h`:
  <https://github.com/coreutils/gnulib>. This is the `fts` coreutils links.
  It is not the glibc `fts(3)` man page.
- uutils coreutils `0.13.0` (`workspace.package.version` on `main`):
  `src/uu/du/src/du.rs`, `src/uucore/src/lib/features/safe_traversal.rs`,
  `src/uucore/src/lib/features/fs.rs`
  (<https://github.com/uutils/coreutils>).
- `fd` 10.5.0 (`Cargo.toml` `version`, `rust-version` 1.90.0):
  `Cargo.toml`, `src/walk.rs`, `src/cli.rs`, `README.md`
  (<https://github.com/sharkdp/fd>). Direct dependency is `ignore = "0.4.28"`.
  There is no `jwalk` or `walkdir` dependency in that `Cargo.toml`.
- `ignore` 0.4.33 on ripgrep master (`crates/ignore/Cargo.toml`,
  `crates/ignore/src/walk.rs`): <https://github.com/BurntSushi/ripgrep>.
  Depth-first switch: commit `139f186e5721e74542604fad8a3c5907c4911faa`
  (PR 1554). Matcher cycle fix: commit
  `b9c774937fc285e6668be9823c4bf231a61fc4a8`.
- `walkdir` 2.5.0 (`Cargo.toml` on master): `src/lib.rs`
  (<https://github.com/BurntSushi/walkdir>).
- `jwalk` 0.9.0 docs: <https://docs.rs/jwalk/0.9.0/jwalk/> and
  <https://docs.rs/jwalk/0.9.0/jwalk/enum.Parallelism.html>.
  README and `benches/benchmarks.md` on `Byron/jwalk` `main`:
  <https://github.com/Byron/jwalk>. The README on `main` says the crate is
  unmaintained and names `dua-core` as the replacement. This note does not
  read `dua-core`.
- Rust `std::fs` as published at <https://doc.rust-lang.org/std/fs/> on the
  fetch date (`DirEntry`, module TOCTOU section, `remove_dir_all`). The page
  does not pin a Rust release.
- Linux man-pages 6.19: `getdents(2)` (page dated 2026-06-14), `statx(2)`,
  `open(2)`, `unlink(2)` (page dated 2026-02-08), via
  <https://man7.org/linux/man-pages/>.
- Apple `getattrlistbulk(2)` from XNU `bsd/man/man2/getattrlistbulk.2`
  (manual dated November 15, 2013; "appeared in OS X version 10.10"):
  <https://github.com/apple-oss-distributions/xnu>.

## Findings

### GNU `du` walks with gnulib `fts`, physically, and still stats what it counts

`du` opens the walk with `xfts_open`, which always adds `FTS_CWDFD`
(`gl/lib/xfts.c`). `main` starts from `bit_flags = FTS_NOSTAT` and
`symlink_deref_bits = FTS_PHYSICAL` (`src/du.c`). `-P` / `--no-dereference`
is documented as the default. `-L` sets `FTS_LOGICAL`. `-H` and `-D` set
`FTS_COMFOLLOW | FTS_PHYSICAL` (command-line symlinks only). `-x` adds
`FTS_XDEV`.

`FTS_PHYSICAL` is a physical walk: do not follow symlinks (`fts.in.h`).
`fts_opendir` passes `O_NOFOLLOW` when `FTS_PHYSICAL` is set, except a
root-level entry when `FTS_COMFOLLOW` is also set (`fts.c`). `diropen` uses
`O_SEARCH | O_CLOEXEC | O_DIRECTORY | O_NOCTTY | O_NONBLOCK`, plus
`O_NOFOLLOW` in a physical walk, and `openat` on `fts_cwd_fd` in `FTS_CWDFD`
mode.

`FTS_NOSTAT` does not mean `du` skips the size stat. In `fts_build`, a
non-directory with a known `d_type` on a physical walk is marked `FTS_NSOK`
and stat is not required (`skip_stat` in `fts.c`). `process_file` then, for
every non-excluded `FTS_NSOK` entry, calls `fts_set(fts, ent, FTS_AGAIN)` and
`fts_read`. `FTS_AGAIN` always calls `fts_stat`. Name-excluded entries return
before that, so they are not stat'd. Directories are not `skip_stat`
(`DT_DIR` fails the skip). Net for a default `du` with no `--exclude`: one
stat per counted object, deferred until that object is processed, with type
taken from `d_type` when the kernel provided it. The comment above
`fts_build` says the stat calls are "the real slowdown", and that `d_type`
"skips all stat calls" while the `st_nlink` leaf rule "skips stat calls in
any leaf directories … cutting the stat calls by about 2/3." That sentence
describes `fts` when the caller does not force `FTS_AGAIN`. `du` does force
it for anything it sums.

`d_type` is not optional to handle as unknown. `getdents(2)` says `d_type`
exists since Linux 2.6.4, that only some filesystems (it names Btrfs, ext2,
ext3, ext4) have full support, and that "All applications must properly
handle a return of `DT_UNKNOWN`." Gnulib's `DT_IS_KNOWN` is
`d_type != DT_UNKNOWN`. If the type is unknown, `skip_stat` is false.

Leaf optimization (`st_nlink == 2` means "no subdirectories",
`MIN_DIR_NLINK`) is disabled when `filesystem_type` is 0 (unknown), AFS,
CIFS, NFS, or proc (`fts.c`). The NFS comment says `d_type` is usable but
not necessarily for every entry of a large directory, and that `st_nlink` is
not accurate on all implementations. On non-Linux builds the same function
returns `NO_LEAF_OPTIMIZATION`.

`fts` reads a directory in batches of `FTS_MAX_READDIR_ENTRIES` (100000)
when no sort comparator is set. The comment says that without the cap, a
directory of 4,000,000 entries needs ~1GiB, and 64M entries would need
16GiB. `du` passes a null comparator, so the cap applies. Past
`FTS_INODE_SORT_DIR_ENTRIES_THRESHOLD` (10000), `fts` may sort the batch by
inode. `dirent_inode_sort_may_be_useful` returns false for Lustre, CIFS,
NFS, and tmpfs. The Lustre arm says sorting interferes with statahead and
"would make a command like `du` around 9 times slower", citing
<https://bugs.gnu.org/80106>. That multiplier is the gnulib comment's claim,
not a number re-measured here. The same function says skipping a useful sort
"can be O(N^2) with a very large constant."

`FTS_CWDFD` keeps parent directory fds in `fts_fd_ring`, an `I_ring` of
`I_RING_SIZE` 4 (`i-ring.h`). Pushing a full ring displaces the oldest fd;
`cwd_advance_fd` closes a displaced fd `>= 0`. Walking back to `..` prefers
a popped fd. If the ring is empty it `diropen`s `..` and `fstat`s, because
"`O_NOFOLLOW` can't help" for the name `..` (`fts_safe_changedir`).

Cycle detection: `fts.in.h` says the lazy algorithm is constant memory and
only valid for `FTS_PHYSICAL`; `du` must use `FTS_TIGHT_CYCLE_CHECK` when it
would otherwise count a cycle more than once. The tight set is
device/inode pairs of directories that have been entered and not yet
finished ("active" directories, memory proportional to depth). `du` sets
`FTS_TIGHT_CYCLE_CHECK` when `-l` is set or when `hash_all` is false.
`hash_all` is true when there is more than one argument, when
`--files0-from` is used, or when the symlink mode is `FTS_LOGICAL`, because
"a file with just one hard link might be seen more than once."

Hard links: `-l` / `--count-links` is "count sizes many times if hard
linked." Without `-l`, `process_file` calls `hash_ins(di_files, st_ino,
st_dev)` only when `hash_all` is set, or when the object is not a directory
and `st_nlink > 1`. A failed insert means the inode was already seen and the
size is skipped. Directories are not put in that hash unless `hash_all`.
With `-l`, `hash_ins` is not called.

Sizes (`process_file`): `--apparent-size` uses `st_size` when
`usable_st_size` is true, otherwise 0. Otherwise the contribution is
`STP_NBLOCKS(sb) * ST_NBLOCKSIZE`. `stat-size.h`: if `st_blocks` exists,
`STP_NBLOCKS` is `st_blocks`; `ST_NBLOCKSIZE` is 1024 on HP-UX, else
`S_BLKSIZE` if defined, else 512. `statx(2)` defines `stx_blocks` as
allocated blocks "in 512-byte units" and notes it "may be smaller than
`stx_size/512` when the file has holes." `du`'s `--apparent-size` text says
apparent size is usually smaller but can be larger because of holes,
fragmentation, and indirect blocks. `system.h::usable_st_size` accepts regular files, symlinks and the POSIX
shared-memory/typed-memory predicates; it excludes directories. Thus apparent
mode contributes zero for directory metadata, whereas block mode may count it.
Children are added on the way up (`duinfo_add` when depth decreases) unless
`-S` / `--separate-dirs`. [Coreutils system.h](https://github.com/coreutils/coreutils/blob/master/src/system.h). Post-order visit is `FTS_DP`.
`fts_read` is depth-first; `process_file`'s comment says it depends on that.

`-x` cannot exclude a command-line argument. A later entry is excluded only
when its `st_dev` differs from the root device (`process_file`).

### uutils `du` is a different algorithm

On Unix except Redox, `du` uses `safe_du` unless `-L` (`dereference == All`),
in which case it uses `du_regular`. `safe_du`'s comment says the point is
TOCTOU safety. `du_regular` is `std::fs` and is also the `-L` path on Unix.

`safe_du` `lstat`s every directory entry with `DirFd::stat_at(..., NoFollow)`
(`fstatat` + `AT_SYMLINK_NOFOLLOW`). It does not consult `d_type`.
`DirFd::read_dir` collects every name except `.` and `..` into a `Vec` before
the stat loop (`read_dir_entries`). Symlinks are not directories
(`S_IFLNK`), so the default walk counts the link's `st_size` and does not
recurse into it. `-L` does not use this function. `du_regular` with `-L`
follows links, stops at `SYMLINK_FOLLOW_LIMIT` (40, `fs.rs`: "Matches the
limit Linux enforces during path lookup"), and skips a symlink whose target
directory inode is already an ancestor.

`open_subdir` in `safe_du` is called with `SymlinkBehavior::Follow`, so the
open does not set `O_NOFOLLOW`. The preceding `stat_at` was `NoFollow`.
Those are two calls. GNU's physical `fts_opendir` sets `O_NOFOLLOW` on the
open itself.

Inode set: every entry with `st_ino != 0` is inserted into an `FxHashSet` of
`(inode, device)`, including `nlink == 1` files and directories. A duplicate
is skipped unless `--count-links`. With `--count-links` the insert still
happens; the duplicate is just not skipped. This is not GNU's "`nlink > 1`
only, and not directories, unless `hash_all`" rule.

Directory `Stat.size` is set to 0 for directories (`Stat::new` and the
`is_dir` branch in `safe_du`). Apparent size (`choose_size`) is that field,
so directory inodes contribute 0 apparent bytes; file `st_size` values are
summed into the parent. Non-apparent output is `blocks * 512`, and the
directory's own `st_blocks` is stored and children are added unless
`--separate-dirs`. GNU apparent mode includes a usable directory `st_size`.

There is one printing thread and an unbounded `std::sync::mpsc` channel. The
walk itself is single-threaded recursion.

### `fd` 10.5.0 is `ignore::WalkParallel`, not `jwalk`

`src/walk.rs` builds `ignore::WalkBuilder`, then
`builder.threads(config.threads).build_parallel()`. Defaults wired there:
hidden files, `.ignore`, parent ignores, gitignore / global gitignore /
git exclude, optional `.fdignore`, `follow_links(config.follow_links)`,
`same_file_system(config.one_file_system)`, `max_depth`. The README says
hidden files and `.gitignore` are ignored by default, and that `-u` is
required before a comparison with `find` is fair.

CLI `-j` / `--threads` defaults to `available_parallelism()`, falling back
to 1, capped at 64 "to limit startup overhead on massively parallel
machines" (`src/cli.rs`). That value is passed into `ignore`, so `ignore`'s
own default cap of 12 (below) does not apply when `fd` sets a non-zero
thread count.

Results go through `crossbeam_channel::bounded(2 * config.threads)` (`scan`
in `src/walk.rs`). That bound is the output path, not the directory work
queue. The work queue is `ignore`'s.

README benchmark, quoted as published. Corpus: the author's home directory,
"~750,000 subdirectories and about a 4 million files." Cache: warm /
pre-filled; the text says cold-cache results "show the same trends" but
does not print them. Tool: hyperfine. Hardware is not named.

- `find ~ -iregex '.*[0-9]\.jpg$'`: mean 19.922 s ± 0.109 s, range 19.765 s
  … 20.065 s.
- `find ~ -iname '*[0-9].jpg'`: mean 11.226 s ± 0.104 s, range 11.119 s …
  11.466 s.
- `fd -u '[0-9]\.jpg$' ~`: mean 854.8 ms ± 10.0 ms, range 839.2 ms … 868.9 ms.

The README says this `fd` run is approximately 23 times the first `find` and
about 13 times the second, and that both tools found 546 files. It then says
this is one benchmark on one machine. It credits the `regex` and `ignore`
crates. Default `fd` matches the file name, not the full path; `--full-path`
is what compares the pattern to the full path (README troubleshooting).

### `ignore` 0.4.33: parallel, depth-first, type from `file_type`

`WalkBuilder::empty` sets `follow_links: false`, `same_file_system: false`,
`threads: 0`. `follow_links(false)` still treats a root path that is a
symlink to a directory as a directory to enter: `walkdir_is_dir` says a
root symlink is followed "by virtue of it being specified by the user
explicitly", and that this extra `metadata()` is avoided for non-root
entries.

`threads() == 0` uses `available_parallelism()`, or 1 on error, then
`.min(12)`. A non-zero `threads` value is used as given (`walk.rs`).

`WalkParallel` uses one `crossbeam_deque` LIFO deque per thread
(`Deque::new_lifo`). The comment says LIFO is depth-first, and that
breadth-first "on wide directories with a lot of gitignores is disastrous
(for example, searching a directory tree containing all of crates.io)."
Workers pop locally and otherwise `steal_batch_and_pop` from other threads.
Commit `139f186` (the change that replaced a channel queue with this stack)
states, as the author's measurements on "my system": searching all crates
dropped peak memory "from almost 1GB to 50MB"; the Linux repo dropped about
50%; the Chromium repo dropped about 25%. The commit says search time was
generally unchanged and some of the author's ad hoc benchmarks got slower
because large files were searched later. It also says prioritizing large
files would need a stat per file. The commit does not name the profiler,
the machine, or the corpus revisions.

The parallel reader (`Work::read_dir`) uses `std::fs::read_dir` and pushes
every `DirEntry` into a `Vec` before `generate_work`. On Unix,
`DirEntryRaw::from_entry` stores `ent.file_type()` and `ent.ino()` and does
not call `metadata()`. `metadata()` on a non-followed Unix entry later calls
`symlink_metadata`. `from_path` (used when `follow_links` is on) calls
`fs::metadata`, which follows. `same_file_system` calls `metadata()` for the
device id, so that option adds a stat. `max_filesize` stats non-directories
when the limit is set.

Ignore matchers are built per directory (`add_child` / `add_child_with_entries`)
so a directory can be skipped before its children are searched. Commit
`b9c7749` fixed a reference cycle in the compiled-matcher cache (`Ignore`
held the cache and the cache held `Ignore`) by storing `Weak`. The changelog
line in that commit calls the bug unbounded memory growth in `ignore`.

`skip_stdout` exists because `grep -r foo ./ > results` can otherwise read
the output file and loop (`WalkBuilder::skip_stdout`).

### `walkdir` 2.5.0

Crate docs: follow symlinks defaults off; loops are reported when following
is on. `WalkDir::new` sets `follow_links: false`, `follow_root_links: true`,
`max_open: 10`, `same_file_system: false`. The root-link comment says a root
symlink is always followed for traversal even when `follow_links` is false.
`max_open` is a trade of file descriptors against memory: at the cap, a
previous directory handle is closed and its unyielded entries are stored.
The comment says this scales with depth, so "low values (even `1`) are
acceptable," and that the cap does not change which entries are yielded or
how many syscalls an exhausted iterator makes. On Windows, with
`follow_links` enabled, the limit is not respected and open handles grow
with depth.

### `jwalk` 0.9.0

docs.rs: parallel via Rayon; results in strict depth-first order; work units
are whole `read_dir` operations (`ReadDirSpec` queue). `Parallelism` docs:
parallelism is at directory granularity; it helps deep trees with many
directories; it does not help "a single directory with many files."
`RayonDefaultPool` has a `busy_timeout` (default described as 1s) after
which iteration aborts if the pool never runs the job, including when many
`jwalk` walks share one pool.

README on `main`: unmaintained; use `dua-core`. The same README says "in my
tests it's about 4x `walkdir` speed for sorted results with metadata" and
does not give the machine, tree, or command in that paragraph.
`benches/benchmarks.md` is a separate table: "Time to walk Linux's source
tree on iMac (Retina 5K, 27-inch, Late 2015)." Options are defined there
(unsorted = `read_dir` order, sorted = by name, metadata = metadata loaded
for each entry). No kernel version, tree revision, or cache state is in
that file.

|                   | threads | jwalk     | ignore    | walkdir   |
| ----------------- | ------- | --------- | --------- | --------- |
| unsorted          | 8       | 54.631 ms | 70.848 ms | —         |
| sorted            | 8       | 56.133 ms | 93.345 ms | —         |
| sorted, metadata  | 8       | 86.985 ms | 122.08 ms | —         |
| sorted, first 100 | 8       | 8.9931 ms | —         | —         |
| unsorted          | 2       | 88.416 ms | 108.97 ms | —         |
| unsorted          | 1       | 141.66 ms | —         | 134.28 ms |
| sorted            | 1       | 150.89 ms | —         | 170.24 ms |
| sorted, metadata  | 1       | 313.91 ms | —         | 310.26 ms |

`process_read_dir` receives the full child list of one directory (the docs
example sorts and retains that `Vec`). Sorted streaming still materializes
each directory.

### Rust `std::fs::read_dir`: `file_type` vs `metadata`

`DirEntry::file_type` does not traverse a symlink. Docs: on Windows and most
Unix it is free (no extra system call); some Unix platforms need the
equivalent of `symlink_metadata`. `DirEntry::metadata` also does not traverse
a symlink; on Unix it is the equivalent of `symlink_metadata` on the path.
`fs::metadata` is the call that follows. `DirEntry::path` allocates a
`PathBuf` by joining the `read_dir` path with the file name. On Unix, a
`DirEntry` holds a reference to the open directory, so keeping entries holds
a file handle after the `ReadDir` iterator is dropped. The docs say that may
change.

`DirEntryExt::ino` is the dirent `d_ino`, not a stat.

### Linux `getdents64` and `statx`

`getdents` / `getdents64` fill a user buffer with many directory entries per
call (`count` is the buffer size). `getdents64` has an explicit `d_type`.
The man page says to use `readdir(3)` rather than the syscall. It does not
say that stat dominates; the "stat calls are the real slowdown" sentence is
the gnulib `fts_build` comment, which matches the shape of the API: one
batched directory read, then a stat per file whose size or link count you
actually need.

`statx` is one inode per call. Useful flags in that page, not a batching
API:

- `AT_SYMLINK_NOFOLLOW`: report the link, like `lstat`.
- `AT_NO_AUTOMOUNT`: do not automount the final component. The page says
  directory scanners use this "to prevent mass-automounting." `stat` /
  `lstat` / `fstatat` already act as though it is set.
- `AT_STATX_DONT_SYNC`: use cached attributes; on a network filesystem this
  "may not involve a round trip to the server" and "the information returned
  is approximate." `AT_STATX_FORCE_SYNC` can force a server round trip.
- `STATX_SIZE` vs `STATX_BLOCKS`: size in bytes (for a symlink, the path
  length) versus allocated 512-byte blocks, which can be smaller when the
  file has holes.
- The page says different fields can come from different moments in the same
  call.

There is no multi-file `statx` in that manual page.

### macOS `getattrlistbulk`

Apple's man page: given a directory fd, return attributes for many entries
in one buffer. Information about a symbolic link is about the link, not the
target. `ATTR_CMN_NAME` and `ATTR_CMN_RETURNED_ATTRS` are required.
`ATTR_CMN_FULLPATH` "may not be valid on all directory entries." A firmlink's
attributes are the link's, not the target's; a mount point's attributes are
the underlying file system's, not the mounted root. Order is unspecified.
Return value is a count of entries, or 0 at end; after 0, new entries are
not observed until `lseek` to 0 or reopen. Mixing `readdir` and
`getattrlistbulk` on the same fd is undefined. This is the primary document
found for bulk attributes plus names. This note does not establish whether
current macOS `find` or `du` calls it.

### Parallelism, fds, queues

What the sources actually bound:

- `ignore` default thread count: at most 12 when the caller leaves threads
  at 0. `fd` overrides that with at most 64.
- `fd` output channel: capacity `2 * threads`.
- `ignore` work queues: unbounded LIFO deques, one per thread, depth-first
  so per-directory gitignore state is dropped as a branch finishes. The
  1GB→50MB figure is the commit above, for a wide tree of gitignores.
- `fts` child list: at most 100000 entries resident when unsorted; the
  4,000,000-entry ~1GiB figure is that comment.
- `walkdir` `max_open` default 10: extra fd pressure becomes stored names,
  growing with depth, not with width alone.
- GNU `du` parent-fd ring: 4 slots.
- `jwalk`: threads help when there are many directories, not when one
  directory has many files; a shared Rayon pool can hit `busy_timeout`.
- NFS / network: gnulib turns off `st_nlink` leaf optimization and inode
  sorting on NFS; `statx` `AT_STATX_DONT_SYNC` vs `AT_STATX_FORCE_SYNC` is
  the documented knob for round trips versus approximate attributes. No
  source read here states a thread count at which HDD or NFS walks get
  slower.

### Safety: symlink races and removal

`open(2)`: `O_NOFOLLOW` fails with `ELOOP` if the final component is a
symlink; earlier components are still followed. `O_DIRECTORY` fails if the
path is not a directory. `O_CREAT|O_EXCL` does not follow a final symlink.

`open(2)` rationale for `openat` and the other `*at` calls (including
`fstatat`, `unlinkat`, `statx`): a path prefix can change between a check
and a use, including by replacing a directory with a symlink. A directory fd
stays a reference if the directory is renamed, and it pins the mount. That
does not freeze the directory's entries. `unlink(2)`: if the name is a
symbolic link, the link is removed. `unlinkat` is `unlink` or, with
`AT_REMOVEDIR`, `rmdir`, relative to `dirfd`.

uutils `open_file_at` comment: `O_NOFOLLOW` refuses a symlink planted in a
just-unlinked name; a hard link to another file would still be opened and
truncated; `O_EXCL` refuses both. That comment is about creating a file, not
about `du`.

Rust `remove_dir_all`: does not follow symbolic links; it removes the link
itself. Docs: on Unix-like platforms it "currently corresponds to `openat`,
`fdopendir`, `unlinkat` and `lstat`," and those details may change. It fails
if `path` is not a directory. On most platforms it protects against symlink
TOCTOU; it does not on Miri, QNX, Redox, or VxWorks. The `std::fs` module
text defines the race as a directory being replaced by a symlink between
check and removal, and says that is why `remove_dir_all` needs atomic
operations. It also says `metadata` / `symlink_metadata` can be stale by the
time you act. Concurrent creation in the directory can return
`DirectoryNotEmpty` after a partial removal.

`remove_dir_all` is the wrong tool for "this path is a symlink candidate":
the function requires a directory. `unlink` / `unlinkat` without
`AT_REMOVEDIR` removes the link name.

## Techniques worth adopting

1. Physical walk. Do not descend into symlinks. Match GNU `du` `-P`, `fd`
   without `-L`, and `ignore` / `walkdir` `follow_links(false)`. Decide the
   scan root explicitly: `walkdir` and `ignore` still enter a root symlink
   to a directory.
2. Classify with `DirEntry::file_type` (dirent `d_type`). Stat only when the
   entry is a candidate that needs size, link count, or inode, or when
   `file_type` fails / the type is unknown. GNU `du` cannot skip the size
   stat; `sweep` can, because most files are not candidates. That is the
   stat reduction `FTS_NOSTAT` actually gives a caller that does not call
   `FTS_AGAIN`.
3. Prune a directory before reading or stating its children (ignore rules,
   `walkdir` `filter_entry`, `du` `FTS_SKIP`). Match basenames when the
   pattern is a basename (`fd`'s default). Build the full path only for
   entries that survive that.
4. Hard-link sizes the way GNU `du` does, not the way uutils `du` does:
   insert `(st_dev, st_ino)` only when `st_nlink > 1` and the object is not
   a directory, unless the same inode can appear twice (several roots, or a
   walk that follows links). Keep a separate set of directory inodes that
   are currently on the stack (gnulib's tight cycle set: proportional to
   depth). Default is count once. `-l` exists because counting every name
   repeats the same blocks.
5. Report one size definition and keep it. Allocated size is `st_blocks` in
   512-byte units on the Linux `statx` definition (GNU multiplies
   `STP_NBLOCKS` by `ST_NBLOCKSIZE`, 512 unless `S_BLKSIZE` or HP-UX).
   Apparent size is `st_size`, and holes make the two diverge. Include the
   directory's own blocks if the number is disk usage; do not copy uutils'
   "directory apparent size is 0" unless that is the intended definition.
   Deleting one hard link does not free the blocks while another link
   remains; a "reclaimable" total has to say which.
6. Delete through a directory fd: `openat` the parent with `O_DIRECTORY`,
   and `unlinkat` the final component. `O_NOFOLLOW` on the open when the
   object must be a real directory (`fts_opendir`). `O_NOFOLLOW` does not
   protect `..`. Do not `lstat` a path, check it, then `remove` that path.
   For a symlink candidate, unlink the name; do not call `remove_dir_all`
   on it. On platforms where Rust `remove_dir_all` documents TOCTOU
   protection, it is appropriate for a directory that was opened as a
   directory and must be removed recursively without following links. It is
   not a substitute for containment checks on the parent.
7. Bound memory on purpose. Depth-first, not a breadth-first queue of every
   directory (`ignore`'s LIFO comment and the crates.io-scale memory note).
   Cap worker threads (the `ignore` default of 12 is the conservative
   first-party heuristic; `fd`'s 64 is a startup cap, not a disk cap).
   Bound the channel that carries results to the UI (`fd`'s `2 * threads`).
   Do not hold an entire multi-million-entry directory as `PathBuf`s if a
   batch cap will do (`fts`'s 100000, and the ~1GiB comment at 4,000,000
   entries). Cap open directory fds and spill unyielded names (`walkdir`
   `max_open`, default 10) or keep a small parent-fd ring (gnulib, size 4).
8. Stay on one filesystem unless asked not to (`FTS_XDEV`, `ignore`
   `same_file_system`). Remember `-x` still has to stat, or otherwise know
   `st_dev`, to notice the crossing, and it does not apply to the root.
9. Treat `d_type` and `st_nlink` as filesystem-dependent. `DT_UNKNOWN` means
   stat. Do not skip subdirectory checks because `st_nlink == 2` on NFS,
   CIFS, AFS, proc, or an unknown type (gnulib's list).
10. If a network filesystem shows up in practice, prefer not forcing a
    server sync (`AT_STATX_DONT_SYNC` is the documented way to avoid a round
    trip, and the page says the attributes may be approximate). Do not use
    it for a size that will be treated as exact.

## Techniques that would make sweep worse

- Following symlinks (`du -L`, `fd -L`, `follow_links(true)`). The walk
  leaves the tree, can loop, and a later delete follows the same path.
- Opening a child with follow after a separate no-follow stat (uutils
  `safe_du`: `stat_at(NoFollow)` then `open_subdir(Follow)`). GNU physical
  `fts` puts `O_NOFOLLOW` on the open.
- Inserting every inode into a hash, including `nlink == 1` (uutils). GNU
  only pays for inodes that can alias, plus the active-directory set.
- A breadth-first queue of directories when each directory carries a matcher
  or a path list. That is the pre-`139f186` `ignore` behavior, with the
  author's 1GB vs 50MB note on a wide tree.
- An unbounded channel of every match (`std::mpsc::channel` in uutils `du`;
  `fd` deliberately uses `bounded`).
- Sorting every directory by name or inode when `sweep` does not need order.
  `jwalk`'s own table shows metadata-plus-sort costing more than unsorted,
  and gnulib says inode sorting makes `du` much slower on Lustre.
- Fuzzy or full-path matching inside the hot loop in a way that builds a
  `PathBuf` for every dirent before a basename prune. `fd` matches the file
  name by default for this reason. `DirEntry::path` allocates.
- Calling `DirEntry::metadata` or `fs::metadata` to learn what
  `file_type` already knows. On Unix, `metadata()` is a stat; `file_type()`
  usually is not. `fs::metadata` also follows symlinks, so a type check
  done that way describes the target.
- `remove_dir_all` on a path that was only checked earlier, or on a symlink.
  The safe shape in the Rust docs is the fd-relative implementation, and it
  still refuses a non-directory.
- Assuming more threads are faster. `jwalk` says extra threads do nothing
  for one huge directory. `ignore` refuses to default past 12. Nothing read
  here justifies a large pool on a single spinning disk or an NFS mount.
- Using directory `st_nlink` or `d_type` as proof on NFS. Gnulib turns the
  leaf optimization off there and says large NFS directories may omit
  `d_type` on some entries.
- Copying `jwalk` as a dependency. Its README says it is unmaintained. The
  "about 4x" sentence has no published setup; the iMac table is one tree
  and one machine.

## Open questions

- `fd` 10.5.0 requires `ignore` 0.4.28 (Cargo semver). The walker source read
  here is ripgrep's `ignore` 0.4.33. The lockfile resolution was not checked.
- GNU `du.c` was read from coreutils master after the 9.12 NEWS entry. A
  diff of `du.c` against the 9.12 tag was not made.
- `dua-core` is the named successor of `jwalk`. Its walker was not read.
- No primary page in this set gives an HDD or NFS thread-count curve. The
  only quantitative network/stat notes are gnulib's NFS/`st_nlink`/`d_type`
  comments, the Lustre statahead comment, and `statx`'s sync flags.
- Whether current macOS `du` / `find` use `getattrlistbulk` was not
  established. The man page is the syscall contract only.
- Linux has no multi-inode stat in `statx(2)`. Whether `io_uring` or another
  interface batches `statx` was not looked up.
- Node's recursive `rm` / `rmdir` symlink and TOCTOU behavior was not read.
  The JS engine cannot assume it matches Rust `remove_dir_all`.
- The Rust docs quote is unversioned (`doc.rust-lang.org/std` on 2026-10-01)
  and says the `remove_dir_all` mechanism "may change."
- Apparent byte accounting is now decided below. Allocated blocks and physical
  reclaim remain separate product questions.

## Remediation sizing contract

Both engines now use per-artifact apparent byte accounting: regular file and
symlink lengths, no directory metadata, and hard links deduplicated within one
artifact. Totals across artifacts can count an inode more than once and are
estimates rather than physical reclaim. JS batches use a bounded metadata walk;
a single artifact may use GNU du 9.2 or newer. Other du implementations fall
back to the metadata walk. GNU 9.2 introduced the directory/special-inode
exclusion; this is documented in [the upstream NEWS](https://raw.githubusercontent.com/coreutils/coreutils/v9.12/NEWS)
and present in [9.4 system.h](https://raw.githubusercontent.com/coreutils/coreutils/v9.4/src/system.h).

## Foreground terminal cancellation

A terminal interrupt can reach every process in its foreground group. The host
therefore uses a separate Unix process group/session for controlled native apply,
keeps its pipes and process reference, and sends cancellation over stdin. This
follows the documented [Node detached-child behavior](https://nodejs.org/api/child_process.html#optionsdetached);
the actual Bun behavior was verified with an owned process-group SIGINT test.
On Windows, [SetConsoleCtrlHandler](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler)
registers a static [HandlerRoutine](https://learn.microsoft.com/en-us/windows/console/handlerroutine).
The small Windows-only unsafe call is required by the OS ABI; its callback
sets a static atomic and retains no borrowed data or handles. Platform runtime
qualification remains pending, including console close/logoff behavior.
