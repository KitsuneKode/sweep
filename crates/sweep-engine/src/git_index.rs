//! Which scan candidates hold git-tracked content.
//!
//! Build output is never committed. A candidate that is, or contains, a path
//! in its repository's index holds authored work whatever its name. This is
//! the same question `git ls-files --cached -- <paths>` answers, answered by
//! reading `.git/index` directly: no process per repository, and none of the
//! repository's config (a hostile clone's `core.fsmonitor` names a program)
//! is ever consulted. Repositories are checked in parallel.
//!
//! Index layouts this reader does not handle in full (a sparse index, an
//! unknown extension or version, an oversized file, a checksum mismatch) fall
//! back to the hardened `git ls-files` invocation the JavaScript
//! implementation uses. Every failure only ever withholds protection from
//! nothing: a repository that cannot be read either way is reported as
//! untracked, exactly as before.

use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Bounded parser limits matching the JavaScript index reader.
const MAX_INDEX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: u32 = 500_000;
const MAX_TOTAL_PATH_BYTES: usize = 64 * 1024 * 1024;
const MAX_SPLIT_BITMAP_BITS: usize = 500_000;
const MAX_PATH_BYTES: usize = 64 * 1024;
const POINTER_MAX_BYTES: u64 = 4096;
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const PATHSPEC_CHUNK_BYTES: usize = 64 * 1024;
const MAX_WORKERS: usize = 8;

/// Benign cache-only extensions that do not alter the tracked entry set.
/// Every other extension (including unknown uppercase and lowercase extensions)
/// is rejected identically to the JavaScript index parser.
const ALLOWED_CACHE_EXTENSIONS: &[&[u8; 4]] =
    &[b"TREE", b"REUC", b"EOIE", b"IEOT", b"UNTR", b"FSMN"];

/// The subset of `paths` that are, or contain, git-tracked files.
///
/// `paths` are absolute. The result preserves no order; callers intersect.
pub fn tracked_paths(paths: &[PathBuf]) -> HashSet<PathBuf> {
    let mut by_root: HashMap<PathBuf, Vec<&PathBuf>> = HashMap::new();
    let mut root_cache: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
    for path in paths {
        let Some(parent) = path.parent() else {
            continue;
        };
        if let Some(root) = find_repo_root(parent, &mut root_cache) {
            by_root.entry(root).or_default().push(path);
        }
    }

    let repos: Vec<(PathBuf, Vec<&PathBuf>)> = by_root.into_iter().collect();
    let tracked = Mutex::new(HashSet::new());
    let next = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, MAX_WORKERS)
        .min(repos.len().max(1));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some((root, members)) = repos.get(index) else {
                    break;
                };
                let found = tracked_in_repo(root, members);
                if !found.is_empty() {
                    tracked
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .extend(found);
                }
            });
        }
    });
    tracked
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Nearest ancestor holding `.git` (a directory, or a file for worktrees
/// and submodules). Mirrors the JavaScript walk, cache included.
fn find_repo_root(start: &Path, cache: &mut HashMap<PathBuf, Option<PathBuf>>) -> Option<PathBuf> {
    let mut visited = Vec::new();
    let mut dir = start.to_path_buf();
    let found = loop {
        if let Some(cached) = cache.get(&dir) {
            break cached.clone();
        }
        visited.push(dir.clone());
        if dir.join(".git").exists() {
            break Some(dir);
        }
        match dir.parent() {
            Some(parent) if parent != dir => dir = parent.to_path_buf(),
            _ => break None,
        }
    };
    for seen in visited {
        cache.insert(seen, found.clone());
    }
    found
}

fn tracked_in_repo(root: &Path, members: &[&PathBuf]) -> Vec<PathBuf> {
    // Index paths are `/`-separated bytes relative to the work tree.
    let rels: Vec<(Vec<u8>, &PathBuf)> = members
        .iter()
        .filter_map(|path| {
            let rel = path.strip_prefix(root).ok()?;
            let text = rel.to_str()?;
            Some((text.replace('\\', "/").into_bytes(), *path))
        })
        .collect();
    if rels.is_empty() {
        return Vec::new();
    }
    match read_index_paths(root) {
        Ok(entries) => rels
            .into_iter()
            .filter(|(rel, _)| contains_tracked(&entries, rel))
            .map(|(_, path)| path.clone())
            .collect(),
        Err(IndexError::Unsupported) => tracked_via_git(root, &rels),
    }
}

/// `entries` is sorted. A candidate is tracked when an entry equals it or
/// lies beneath it. `-` and `.` sort before `/`, so `dist-x` sits between
/// `dist` and `dist/a`: search for the `dist/` prefix explicitly.
fn contains_tracked(entries: &[Vec<u8>], rel: &[u8]) -> bool {
    if entries
        .binary_search_by(|entry| entry.as_slice().cmp(rel))
        .is_ok()
    {
        return true;
    }
    let mut prefix = rel.to_vec();
    prefix.push(b'/');
    let at = entries.partition_point(|entry| entry.as_slice() < prefix.as_slice());
    entries
        .get(at)
        .is_some_and(|entry| entry.starts_with(&prefix))
}

#[derive(Debug, PartialEq, Eq)]
enum IndexError {
    /// Hand this repository to `git` instead.
    Unsupported,
}

fn read_regular_bounded(path: &Path, max_bytes: u64) -> Result<Option<Vec<u8>>, IndexError> {
    let Some(file) = sweep_fs::open_regular_nofollow(path).map_err(|_| IndexError::Unsupported)?
    else {
        return Ok(None);
    };
    let len = file.metadata().map_err(|_| IndexError::Unsupported)?.len();
    if len > max_bytes {
        return Err(IndexError::Unsupported);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| IndexError::Unsupported)?;
    if bytes.len() as u64 > max_bytes {
        return Err(IndexError::Unsupported);
    }
    Ok(Some(bytes))
}

/// The index file `git` itself would read for this work tree.
fn index_file(root: &Path) -> Result<Option<PathBuf>, IndexError> {
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let dot_git = canonical_root.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).map_err(|_| IndexError::Unsupported)?;
    if meta.is_dir() {
        return Ok(Some(dot_git.join("index")));
    }
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > POINTER_MAX_BYTES {
        return Err(IndexError::Unsupported);
    }
    // Worktrees and submodules: `gitdir: <path>`, relative to the canonical work tree.
    let raw = read_regular_bounded(&dot_git, POINTER_MAX_BYTES)?.ok_or(IndexError::Unsupported)?;
    let text = std::str::from_utf8(&raw).map_err(|_| IndexError::Unsupported)?;
    let first_line = text
        .split('\n')
        .next()
        .unwrap_or("")
        .strip_suffix('\r')
        .unwrap_or_else(|| text.split('\n').next().unwrap_or(""));
    let gitdir = first_line
        .strip_prefix("gitdir:")
        .map(|value| value.trim_start_matches([' ', '\t']))
        .filter(|value| !value.is_empty())
        .ok_or(IndexError::Unsupported)?;
    let gitdir = Path::new(gitdir);
    let gitdir = if gitdir.is_absolute() {
        gitdir.to_path_buf()
    } else {
        canonical_root.join(gitdir)
    };
    Ok(Some(gitdir.join("index")))
}

fn read_index_bytes(path: &Path) -> Result<Option<Vec<u8>>, IndexError> {
    read_regular_bounded(path, MAX_INDEX_BYTES)
}

fn read_index_paths(root: &Path) -> Result<Vec<Vec<u8>>, IndexError> {
    let Some(path) = index_file(root)? else {
        return Ok(Vec::new());
    };
    let Some(bytes) = read_index_bytes(&path)? else {
        // No index yet: nothing staged, nothing committed - `git ls-files` agrees.
        return Ok(Vec::new());
    };
    // SHA-1 repositories are the norm; SHA-256 ones store 32-byte names.
    let parsed = parse_index_raw(&bytes, 20, true, MAX_TOTAL_PATH_BYTES)
        .map(|p| (p, 20usize))
        .or_else(|_| {
            parse_index_raw(&bytes, 32, true, MAX_TOTAL_PATH_BYTES).map(|p| (p, 32usize))
        })?;
    let (parsed, hash_len) = parsed;
    let Some(split) = parsed.split_link else {
        let mut paths = parsed.paths;
        paths.sort_unstable();
        paths.dedup();
        return Ok(paths);
    };

    // Validate overlay ordering: first `replace_bitmap.set_count` entries must
    // have empty names (replacements), and all later entries must be non-empty.
    let replace_count = split.replace_bitmap.set_count;
    if parsed.paths.len() < replace_count {
        return Err(IndexError::Unsupported);
    }
    for entry_path in &parsed.paths[..replace_count] {
        if !entry_path.is_empty() {
            return Err(IndexError::Unsupported);
        }
    }
    for entry_path in &parsed.paths[replace_count..] {
        if entry_path.is_empty() {
            return Err(IndexError::Unsupported);
        }
    }

    let mut all_paths: Vec<Vec<u8>> = Vec::new();
    if split.base_oid.iter().all(|&b| b == 0) {
        if split.delete_bitmap.set_count > 0 || split.replace_bitmap.set_count > 0 {
            return Err(IndexError::Unsupported);
        }
    } else {
        let mut hex = String::with_capacity(split.base_oid.len() * 2);
        for byte in &split.base_oid {
            use std::fmt::Write as _;
            let _ = write!(&mut hex, "{byte:02x}");
        }
        let shared_dir = path.parent().ok_or(IndexError::Unsupported)?;
        let shared_path = shared_dir.join(format!("sharedindex.{hex}"));
        let shared_bytes = read_index_bytes(&shared_path)?.ok_or(IndexError::Unsupported)?;
        let base_parsed = parse_index_raw(&shared_bytes, hash_len, false, MAX_TOTAL_PATH_BYTES)?;
        if base_parsed.checksum != split.base_oid {
            return Err(IndexError::Unsupported);
        }
        let base_count = base_parsed.paths.len();
        if split
            .delete_bitmap
            .highest_set_bit()
            .is_some_and(|bit| bit >= base_count)
            || split
                .replace_bitmap
                .highest_set_bit()
                .is_some_and(|bit| bit >= base_count)
            || split.delete_bitmap.overlaps(&split.replace_bitmap)
        {
            return Err(IndexError::Unsupported);
        }
        for (idx, base_path) in base_parsed.paths.into_iter().enumerate() {
            if split.delete_bitmap.has(idx) {
                continue;
            }
            all_paths.push(base_path);
        }
    }
    for entry_path in parsed.paths.into_iter().skip(replace_count) {
        all_paths.push(entry_path);
    }
    all_paths.sort_unstable();
    all_paths.dedup();
    Ok(all_paths)
}

/// Compact bounded bitset decoded from Git's EWAH bitmap format.
#[derive(Debug, PartialEq, Eq)]
struct EwahBitmap {
    bit_size: usize,
    bits: Vec<u8>,
    set_count: usize,
    highest: Option<usize>,
}

impl EwahBitmap {
    fn empty() -> Self {
        Self {
            bit_size: 0,
            bits: Vec::new(),
            set_count: 0,
            highest: None,
        }
    }

    fn has(&self, index: usize) -> bool {
        if index >= self.bit_size {
            return false;
        }
        self.bits
            .get(index >> 3)
            .is_some_and(|&byte| (byte & (1u8 << (index & 7))) != 0)
    }

    fn highest_set_bit(&self) -> Option<usize> {
        self.highest
    }

    fn overlaps(&self, other: &Self) -> bool {
        self.bits
            .iter()
            .zip(other.bits.iter())
            .any(|(&a, &b)| (a & b) != 0)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SplitIndexLink {
    base_oid: Vec<u8>,
    delete_bitmap: EwahBitmap,
    replace_bitmap: EwahBitmap,
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedIndex {
    paths: Vec<Vec<u8>>,
    checksum: Vec<u8>,
    split_link: Option<SplitIndexLink>,
}

/// Pure-Rust SHA-1 (FIPS 180-4) for verifying Git index trailers with no extra crates.
fn sha1_digest(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xefcd_ab89,
        0x98ba_dcfe,
        0x1032_5476,
        0xc3d2_e1f0,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);

    let process_block = |block: &[u8; 64], h: &mut [u32; 5]| {
        let mut w = [0u32; 80];
        let (words, _) = block.as_chunks::<4>();
        for (i, chunk) in words.iter().enumerate() {
            w[i] = u32::from_be_bytes(*chunk);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = *h;
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5a82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ed9_eba1u32),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc_u32),
                _ => (b ^ c ^ d, 0xca62_c1d6u32),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    };

    let (blocks, rem) = data.as_chunks::<64>();
    for block in blocks {
        process_block(block, &mut h);
    }

    let mut tail = [0u8; 128];
    tail[..rem.len()].copy_from_slice(rem);
    tail[rem.len()] = 0x80;
    let total_tail = if rem.len() + 9 <= 64 { 64 } else { 128 };
    tail[total_tail - 8..total_tail].copy_from_slice(&bit_len.to_be_bytes());
    let mut first = [0u8; 64];
    first.copy_from_slice(&tail[..64]);
    process_block(&first, &mut h);
    if total_tail == 128 {
        let mut second = [0u8; 64];
        second.copy_from_slice(&tail[64..128]);
        process_block(&second, &mut h);
    }

    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..(i + 1) * 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn verify_index_checksum(bytes: &[u8], hash_len: usize) -> Result<Vec<u8>, IndexError> {
    if bytes.len() < 12 + hash_len {
        return Err(IndexError::Unsupported);
    }
    let payload_end = bytes.len() - hash_len;
    let payload = &bytes[..payload_end];
    let trailer = &bytes[payload_end..];
    let matches = match hash_len {
        20 => sha1_digest(payload).as_slice() == trailer,
        32 => {
            let digest = Sha256::digest(payload);
            digest.as_slice() == trailer
        }
        _ => false,
    };
    if !matches {
        return Err(IndexError::Unsupported);
    }
    Ok(trailer.to_vec())
}

/// Parse the path of every index entry. Bounds-checked throughout: the file
/// comes from a repository sweep did not create.
#[cfg_attr(not(test), allow(dead_code))]
fn parse_index(bytes: &[u8], hash_len: usize) -> Result<Vec<Vec<u8>>, IndexError> {
    let parsed = parse_index_raw(bytes, hash_len, false, MAX_TOTAL_PATH_BYTES)?;
    let mut paths = parsed.paths;
    paths.sort_unstable();
    paths.dedup();
    Ok(paths)
}

fn parse_index_raw(
    bytes: &[u8],
    hash_len: usize,
    allow_split_index: bool,
    max_total_path_bytes: usize,
) -> Result<ParsedIndex, IndexError> {
    if bytes.len() < 12 + hash_len {
        return Err(IndexError::Unsupported);
    }
    let mut reader = Reader { bytes, at: 0 };
    if reader.take(4)? != b"DIRC" {
        return Err(IndexError::Unsupported);
    }
    let version = reader.u32()?;
    if !(2..=4).contains(&version) {
        return Err(IndexError::Unsupported);
    }
    let count = reader.u32()?;
    let min_entry_bytes = if version == 4 {
        40 + hash_len + 4
    } else {
        40 + hash_len + 8
    };
    let max_possible = (bytes.len() - 12 - hash_len) / min_entry_bytes;
    if count > MAX_ENTRIES || (count as usize) > max_possible {
        return Err(IndexError::Unsupported);
    }

    // Verify trailing checksum before allocating entries or decoding paths.
    let checksum = verify_index_checksum(bytes, hash_len)?;

    let mut paths: Vec<Vec<u8>> = Vec::with_capacity((count as usize).min(1 << 16));
    let mut previous: Vec<u8> = Vec::new();
    let mut total_path_bytes = 0usize;

    for _ in 0..count {
        let start = reader.at;
        // ctime, mtime, dev, ino, mode, uid, gid, size: ten u32 fields.
        reader.take(40)?;
        reader.take(hash_len)?;
        let flags = reader.u16()?;
        let extended = flags & 0x4000 != 0;
        if extended {
            if version < 3 {
                return Err(IndexError::Unsupported);
            }
            reader.take(2)?;
        }
        let name_len = usize::from(flags & 0x0fff);
        let path = if version == 4 {
            let strip = reader.varint()?;
            let suffix = reader.until_nul()?;
            let keep = previous
                .len()
                .checked_sub(strip)
                .ok_or(IndexError::Unsupported)?;
            let decoded_len = keep
                .checked_add(suffix.len())
                .ok_or(IndexError::Unsupported)?;
            if decoded_len > MAX_PATH_BYTES {
                return Err(IndexError::Unsupported);
            }
            total_path_bytes = total_path_bytes
                .checked_add(decoded_len)
                .ok_or(IndexError::Unsupported)?;
            if total_path_bytes > max_total_path_bytes {
                return Err(IndexError::Unsupported);
            }
            let mut path = Vec::with_capacity(decoded_len);
            path.extend_from_slice(&previous[..keep]);
            path.extend_from_slice(suffix);
            path
        } else {
            let name = reader.until_nul()?;
            // A short name's length is stored exactly; 0xfff means "longer".
            if name_len < 0x0fff && name.len() != name_len {
                return Err(IndexError::Unsupported);
            }
            if name.len() > MAX_PATH_BYTES {
                return Err(IndexError::Unsupported);
            }
            total_path_bytes = total_path_bytes
                .checked_add(name.len())
                .ok_or(IndexError::Unsupported)?;
            if total_path_bytes > max_total_path_bytes {
                return Err(IndexError::Unsupported);
            }
            // Entries pad with NULs to a multiple of eight bytes, the
            // terminating NUL included.
            let fixed = reader.at - start - name.len() - 1;
            let padded = (fixed + name.len() + 8) & !7;
            let pad = padded - (reader.at - start);
            let padding = reader.take(pad)?;
            if padding.iter().any(|&byte| byte != 0) {
                return Err(IndexError::Unsupported);
            }
            name.to_vec()
        };
        if path.is_empty() && !allow_split_index {
            return Err(IndexError::Unsupported);
        }
        previous.clone_from(&path);
        paths.push(path);
    }
    // Extensions follow the entries, then the trailing checksum.
    let mut split_link = None;
    while reader.remaining() > hash_len {
        let signature = reader.take(4)?;
        let size = reader.u32()? as usize;
        let body = reader.take(size)?;
        if signature == b"link" {
            if !allow_split_index {
                return Err(IndexError::Unsupported);
            }
            split_link = Some(parse_split_link(body, hash_len)?);
        } else if !ALLOWED_CACHE_EXTENSIONS.iter().any(|ext| *ext == signature) {
            return Err(IndexError::Unsupported);
        }
    }
    if reader.remaining() != hash_len {
        return Err(IndexError::Unsupported);
    }
    if paths.iter().any(Vec::is_empty) && split_link.is_none() {
        return Err(IndexError::Unsupported);
    }
    Ok(ParsedIndex {
        paths,
        checksum,
        split_link,
    })
}

fn parse_split_link(body: &[u8], hash_len: usize) -> Result<SplitIndexLink, IndexError> {
    let mut reader = Reader { bytes: body, at: 0 };
    let base_oid = reader.take(hash_len)?.to_vec();
    if reader.remaining() == 0 {
        return Ok(SplitIndexLink {
            base_oid,
            delete_bitmap: EwahBitmap::empty(),
            replace_bitmap: EwahBitmap::empty(),
        });
    }
    let delete_bitmap = read_ewah_bitmap(&mut reader)?;
    let replace_bitmap = read_ewah_bitmap(&mut reader)?;
    if reader.remaining() != 0 {
        return Err(IndexError::Unsupported);
    }
    Ok(SplitIndexLink {
        base_oid,
        delete_bitmap,
        replace_bitmap,
    })
}

fn read_ewah_bitmap(reader: &mut Reader<'_>) -> Result<EwahBitmap, IndexError> {
    let bit_size = reader.u32()? as usize;
    let word_count = reader.u32()? as usize;
    if bit_size > MAX_SPLIT_BITMAP_BITS {
        return Err(IndexError::Unsupported);
    }
    let required_bytes = word_count
        .checked_mul(8)
        .and_then(|n| n.checked_add(4))
        .ok_or(IndexError::Unsupported)?;
    if required_bytes > reader.remaining() {
        return Err(IndexError::Unsupported);
    }

    let max_uncompressed_words = bit_size.div_ceil(64);
    let mut bits = vec![0u8; bit_size.div_ceil(8)];
    let mut words_read = 0usize;
    let mut uncompressed_words = 0usize;
    let mut set_count = 0usize;
    let mut highest: Option<usize> = None;

    while words_read < word_count {
        let rlw = reader.u64()?;
        words_read += 1;
        let running_bit = (rlw & 1) != 0;
        let running_words =
            usize::try_from((rlw >> 1) & 0xffff_ffff).map_err(|_| IndexError::Unsupported)?;
        let literal_words = usize::try_from(rlw >> 33).map_err(|_| IndexError::Unsupported)?;
        if words_read
            .checked_add(literal_words)
            .is_none_or(|n| n > word_count)
        {
            return Err(IndexError::Unsupported);
        }
        let next_uncompressed = uncompressed_words
            .checked_add(running_words)
            .and_then(|n| n.checked_add(literal_words))
            .ok_or(IndexError::Unsupported)?;
        if next_uncompressed > max_uncompressed_words {
            return Err(IndexError::Unsupported);
        }

        let start_bit = uncompressed_words
            .checked_mul(64)
            .ok_or(IndexError::Unsupported)?;
        if running_bit && running_words > 0 {
            let end_bit = bit_size.min(
                start_bit.saturating_add(
                    running_words
                        .checked_mul(64)
                        .ok_or(IndexError::Unsupported)?,
                ),
            );
            if end_bit > start_bit {
                let start_byte = start_bit >> 3;
                let full_end_byte = end_bit >> 3;
                for slot in &mut bits[start_byte..full_end_byte] {
                    *slot = 0xff;
                }
                let tail_bits = end_bit & 7;
                if tail_bits > 0 {
                    bits[full_end_byte] = (1u8 << tail_bits) - 1;
                }
                set_count += end_bit - start_bit;
                highest = Some(end_bit - 1);
            }
        }
        uncompressed_words += running_words;

        for _ in 0..literal_words {
            let word = reader.u64()?;
            words_read += 1;
            let word_bit_base = uncompressed_words
                .checked_mul(64)
                .ok_or(IndexError::Unsupported)?;
            if word != 0 {
                let limit = 64.min(bit_size.saturating_sub(word_bit_base));
                for b in 0..limit {
                    if ((word >> b) & 1) != 0 {
                        let bit = word_bit_base + b;
                        bits[bit >> 3] |= 1u8 << (bit & 7);
                        set_count += 1;
                        highest = Some(bit);
                    }
                }
            }
            uncompressed_words += 1;
        }
    }
    // Trailing rlw_pos.
    let _ = reader.u32()?;
    if bit_size == 0 {
        Ok(EwahBitmap::empty())
    } else {
        Ok(EwahBitmap {
            bit_size,
            bits,
            set_count,
            highest,
        })
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn remaining(&self) -> usize {
        self.bytes.len() - self.at
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], IndexError> {
        let end = self.at.checked_add(n).ok_or(IndexError::Unsupported)?;
        let slice = self
            .bytes
            .get(self.at..end)
            .ok_or(IndexError::Unsupported)?;
        self.at = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, IndexError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, IndexError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u64(&mut self) -> Result<u64, IndexError> {
        let b = self.take(8)?;
        Ok(u64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    fn until_nul(&mut self) -> Result<&'a [u8], IndexError> {
        let rest = self.bytes.get(self.at..).ok_or(IndexError::Unsupported)?;
        let len = rest
            .iter()
            .take(MAX_PATH_BYTES + 1)
            .position(|&byte| byte == 0)
            .ok_or(IndexError::Unsupported)?;
        let name = &rest[..len];
        self.at += len + 1;
        Ok(name)
    }

    /// git's offset varint (index v4 path prefix lengths).
    fn varint(&mut self) -> Result<usize, IndexError> {
        let mut byte = self.take(1)?[0];
        let mut value = usize::from(byte & 0x7f);
        while byte & 0x80 != 0 {
            byte = self.take(1)?[0];
            value = value
                .checked_add(1)
                .and_then(|v| v.checked_mul(128))
                .and_then(|v| v.checked_add(usize::from(byte & 0x7f)))
                .ok_or(IndexError::Unsupported)?;
            if value > MAX_PATH_BYTES {
                return Err(IndexError::Unsupported);
            }
        }
        Ok(value)
    }
}

/// The JavaScript implementation's invocation, unchanged: no fsmonitor, no
/// untracked cache, no optional locks, literal pathspecs after `--`.
fn tracked_via_git(root: &Path, rels: &[(Vec<u8>, &PathBuf)]) -> Vec<PathBuf> {
    let by_rel: HashMap<&[u8], &PathBuf> = rels
        .iter()
        .map(|(rel, path)| (rel.as_slice(), *path))
        .collect();
    let mut tracked = Vec::new();
    let mut chunk: Vec<&str> = Vec::new();
    let mut chunk_bytes = 0;
    let mut flush = |chunk: &mut Vec<&str>| {
        if chunk.is_empty() {
            return;
        }
        if let Some(stdout) = run_git_ls_files(root, chunk) {
            for file in stdout.split(|&byte| byte == 0).filter(|f| !f.is_empty()) {
                let mut rel = file;
                loop {
                    if let Some(path) = by_rel.get(rel) {
                        tracked.push((*path).clone());
                        break;
                    }
                    match rel.iter().rposition(|&byte| byte == b'/') {
                        Some(cut) => rel = &rel[..cut],
                        None => break,
                    }
                }
            }
        }
        chunk.clear();
    };
    for (rel, _) in rels {
        let Ok(text) = std::str::from_utf8(rel) else {
            continue;
        };
        if !chunk.is_empty() && chunk_bytes + text.len() + 1 > PATHSPEC_CHUNK_BYTES {
            flush(&mut chunk);
            chunk_bytes = 0;
        }
        chunk.push(text);
        chunk_bytes += text.len() + 1;
    }
    flush(&mut chunk);
    tracked.sort();
    tracked.dedup();
    tracked
}

#[cfg(not(unix))]
struct EmptyHooksGuard(PathBuf);

#[cfg(not(unix))]
impl EmptyHooksGuard {
    fn create() -> Option<Self> {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let pid = std::process::id();
        let base = std::env::temp_dir();
        for _ in 0..16 {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = base.join(format!("sweep-no-hooks-{pid}-{n}"));
            match std::fs::create_dir(&dir) {
                Ok(()) => return Some(Self(dir)),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return None,
            }
        }
        None
    }
}

#[cfg(not(unix))]
impl Drop for EmptyHooksGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn git_ls_files_command(root: &Path, pathspecs: &[&str], hooks_path: &Path) -> Command {
    let mut cmd = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            cmd.env_remove(&key);
        }
    }
    let mut hooks_arg = std::ffi::OsString::from("core.hooksPath=");
    hooks_arg.push(hooks_path);
    cmd.args([
        "--no-pager",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=never",
        "-c",
        "protocol.git.allow=never",
        "-c",
        "protocol.ssh.allow=never",
        "-c",
        "protocol.http.allow=never",
        "-c",
        "protocol.https.allow=never",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.quotePath=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
    ])
    .arg(hooks_arg)
    .arg("-C")
    .arg(root)
    .args(["ls-files", "-z", "--cached", "--"])
    .args(pathspecs)
    .env("LC_ALL", "C")
    .env("LANG", "C")
    .env("LANGUAGE", "C")
    .env("GIT_OPTIONAL_LOCKS", "0")
    .env("GIT_LITERAL_PATHSPECS", "1")
    .env("GIT_TERMINAL_PROMPT", "0")
    .env("GIT_NO_LAZY_FETCH", "1")
    .env("GIT_NO_REPLACE_OBJECTS", "1")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    cmd
}

fn run_git_ls_files(root: &Path, pathspecs: &[&str]) -> Option<Vec<u8>> {
    #[cfg(unix)]
    let mut child = git_ls_files_command(root, pathspecs, Path::new("/dev/null"))
        .spawn()
        .ok()?;
    #[cfg(not(unix))]
    let hooks_guard = EmptyHooksGuard::create()?;
    #[cfg(not(unix))]
    let mut child = git_ls_files_command(root, pathspecs, &hooks_guard.0)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        stdout
            .by_ref()
            .take(256 * 1024 * 1024)
            .read_to_end(&mut out)
            .ok()
            .map(|_| out)
    });
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(2)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = reader.join().ok().flatten()?;
    status
        .filter(std::process::ExitStatus::success)
        .map(|_| out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_varint(value: usize) -> Vec<u8> {
        let mut bytes = vec![u8::try_from(value & 0x7f).unwrap_or(0)];
        let mut v = value >> 7;
        while v > 0 {
            v -= 1;
            bytes.push(0x80 | u8::try_from(v & 0x7f).unwrap_or(0));
            v >>= 7;
        }
        bytes.reverse();
        bytes
    }

    fn entry(path: &[u8], version: u32, hash_len: usize, previous: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 40];
        out.extend(std::iter::repeat_n(0xab, hash_len));
        let flags = u16::try_from(path.len().min(0x0fff)).unwrap_or(0x0fff);
        out.extend_from_slice(&flags.to_be_bytes());
        if version == 4 {
            let common = previous
                .iter()
                .zip(path)
                .take_while(|(a, b)| a == b)
                .count();
            let strip = previous.len() - common;
            out.extend_from_slice(&encode_varint(strip));
            out.extend_from_slice(&path[common..]);
            out.push(0);
        } else {
            out.extend_from_slice(path);
            let fixed = 40 + hash_len + 2;
            let padded = (fixed + path.len() + 8) & !7;
            out.resize(padded, 0);
        }
        out
    }

    fn index_with_hash(
        version: u32,
        paths: &[&[u8]],
        extensions: &[(&[u8; 4], &[u8])],
        hash_len: usize,
    ) -> Vec<u8> {
        let mut out = b"DIRC".to_vec();
        out.extend_from_slice(&version.to_be_bytes());
        out.extend_from_slice(&u32::try_from(paths.len()).unwrap_or(0).to_be_bytes());
        let mut previous: &[u8] = b"";
        for path in paths {
            out.extend_from_slice(&entry(path, version, hash_len, previous));
            previous = path;
        }
        for (signature, body) in extensions {
            out.extend_from_slice(*signature);
            out.extend_from_slice(&u32::try_from(body.len()).unwrap_or(0).to_be_bytes());
            out.extend_from_slice(body);
        }
        if hash_len == 32 {
            let digest = Sha256::digest(&out);
            out.extend_from_slice(digest.as_slice());
        } else {
            let digest = sha1_digest(&out);
            out.extend_from_slice(&digest);
        }
        out
    }

    fn index(version: u32, paths: &[&[u8]], extensions: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        index_with_hash(version, paths, extensions, 20)
    }

    fn build_ewah_rlw(
        bit_size: u32,
        running_bit: bool,
        running_words: u32,
        literals: &[u64],
    ) -> Vec<u8> {
        let word_count = u32::try_from(1 + literals.len()).unwrap_or(1);
        let mut out = Vec::new();
        out.extend_from_slice(&bit_size.to_be_bytes());
        out.extend_from_slice(&word_count.to_be_bytes());
        let rlw = u64::from(running_bit)
            | (u64::from(running_words) << 1)
            | ((literals.len() as u64) << 33);
        out.extend_from_slice(&rlw.to_be_bytes());
        for &lit in literals {
            out.extend_from_slice(&lit.to_be_bytes());
        }
        out.extend_from_slice(&0u32.to_be_bytes());
        out
    }

    const PATHS: &[&[u8]] = &[b"apps/web/dist/vendor.js", b"dist-x/a", b"src/main.rs"];

    #[test]
    fn sha1_matches_fips_test_vectors() {
        assert_eq!(
            hex::encode(sha1_digest(b"")),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
        assert_eq!(
            hex::encode(sha1_digest(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex::encode(sha1_digest(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
    }

    #[test]
    fn reads_v2_v3_and_v4_indexes_alike() {
        for version in [2, 3, 4] {
            let parsed = parse_index(&index(version, PATHS, &[]), 20);
            assert_eq!(
                parsed.as_deref().map(<[Vec<u8>]>::len),
                Ok(3),
                "version {version}"
            );
            let entries = parsed.unwrap_or_default();
            assert!(contains_tracked(&entries, b"apps/web/dist"));
            assert!(contains_tracked(&entries, b"src/main.rs"));
            assert!(
                !contains_tracked(&entries, b"dist"),
                "dist-x must not count as dist"
            );
            assert!(!contains_tracked(&entries, b"apps/web/dis"));
        }
    }

    #[test]
    fn verifies_trailing_sha1_and_sha256_checksums() {
        for hash_len in [20usize, 32] {
            let valid = index_with_hash(2, PATHS, &[], hash_len);
            assert!(parse_index(&valid, hash_len).is_ok());

            let mut flipped_body = valid.clone();
            flipped_body[15] ^= 0x01;
            assert_eq!(
                parse_index(&flipped_body, hash_len),
                Err(IndexError::Unsupported)
            );

            let mut flipped_trailer = valid;
            let last = flipped_trailer.len() - 1;
            flipped_trailer[last] ^= 0x80;
            assert_eq!(
                parse_index(&flipped_trailer, hash_len),
                Err(IndexError::Unsupported)
            );
        }
    }

    #[test]
    fn rejects_unknown_uppercase_and_lowercase_extensions_identically() {
        let split = index(2, PATHS, &[(b"link", b"0123456789")]);
        assert_eq!(parse_index(&split, 20), Err(IndexError::Unsupported));
        for sig in [b"sdir", b"XXXX", b"MAND", b"xxxx"] {
            let idx = index(2, PATHS, &[(sig, b"payload")]);
            assert_eq!(
                parse_index(&idx, 20),
                Err(IndexError::Unsupported),
                "extension {:?} must be rejected",
                sig
            );
        }
        for allowed in ALLOWED_CACHE_EXTENSIONS {
            let idx = index(2, PATHS, &[(allowed, b"payload")]);
            assert!(
                parse_index(&idx, 20).is_ok(),
                "allowed extension {:?} should pass",
                allowed
            );
        }
    }

    #[test]
    fn rejects_v4_path_compression_bomb_within_memory_bounds() {
        let prefix = "a/".repeat(30_000);
        let mut owned: Vec<Vec<u8>> = Vec::with_capacity(1501);
        owned.push(format!("{prefix}0000").into_bytes());
        for i in 1..=1500 {
            owned.push(format!("{prefix}{i:04}").into_bytes());
        }
        let refs: Vec<&[u8]> = owned.iter().map(Vec::as_slice).collect();
        let bomb = index(4, &refs, &[]);
        assert!(bomb.len() < 300 * 1024);
        assert_eq!(
            parse_index_raw(&bomb, 20, false, 4 * 1024 * 1024),
            Err(IndexError::Unsupported)
        );
    }

    #[test]
    fn rejects_ewah_compression_bombs_in_bounded_time_and_memory() {
        let base_oid = [0x22u8; 20];
        let empty_ewah = [0u8; 12];

        let mut ones_bomb = base_oid.to_vec();
        ones_bomb.extend_from_slice(&build_ewah_rlw(500_000, true, 100_000, &[]));
        ones_bomb.extend_from_slice(&empty_ewah);
        let idx_ones = index(2, &[b"a"], &[(b"link", &ones_bomb)]);

        let mut zeros_bomb = base_oid.to_vec();
        zeros_bomb.extend_from_slice(&build_ewah_rlw(100, false, 0x0fff_ffff, &[]));
        zeros_bomb.extend_from_slice(&empty_ewah);
        let idx_zeros = index(2, &[b"a"], &[(b"link", &zeros_bomb)]);

        let start = Instant::now();
        assert_eq!(
            parse_index_raw(&idx_ones, 20, true, MAX_TOTAL_PATH_BYTES),
            Err(IndexError::Unsupported)
        );
        assert_eq!(
            parse_index_raw(&idx_zeros, 20, true, MAX_TOTAL_PATH_BYTES),
            Err(IndexError::Unsupported)
        );
        assert!(start.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn hostile_or_truncated_indexes_never_panic() {
        let good = index(4, PATHS, &[]);
        for cut in 0..good.len() {
            let _ = parse_index(&good[..cut], 20);
        }
        let mut lying = index(2, PATHS, &[]);
        lying[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(parse_index(&lying, 20), Err(IndexError::Unsupported));
        assert_eq!(parse_index(b"NOPE", 20), Err(IndexError::Unsupported));
    }

    #[test]
    fn seeded_fuzz_corpus_stays_bounded_and_never_panics() {
        let mut seed: u32 = 0x5eed_1234;
        let mut next_u32 = || -> u32 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            seed
        };

        let baseline = index(4, &[b"a/b/c.rs", b"a/b/d.rs", b"z.txt"], &[(b"TREE", b"x")]);
        let start = Instant::now();
        let cap = 2 * 1024 * 1024;
        let mut peak_decoded_bytes = 0usize;

        for iter in 0..2000usize {
            let sample = match iter % 4 {
                0 => {
                    let mut buf = baseline.clone();
                    let mutations = 1 + (next_u32() as usize % 6);
                    for _ in 0..mutations {
                        let pos = next_u32() as usize % (buf.len() - 20).max(1);
                        buf[pos] = (next_u32() & 0xff) as u8;
                    }
                    let payload_end = buf.len() - 20;
                    let digest = sha1_digest(&buf[..payload_end]);
                    buf[payload_end..].copy_from_slice(&digest);
                    buf
                }
                1 => {
                    let len = 12 + (next_u32() as usize % 256);
                    let mut body = vec![0u8; len];
                    body[..4].copy_from_slice(b"DIRC");
                    body[4..8].copy_from_slice(&(2 + (next_u32() % 4)).to_be_bytes());
                    body[8..12].copy_from_slice(&(next_u32() % 10_000).to_be_bytes());
                    for byte in &mut body[12..] {
                        *byte = (next_u32() & 0xff) as u8;
                    }
                    let digest = sha1_digest(&body);
                    body.extend_from_slice(&digest);
                    body
                }
                2 => {
                    let len = next_u32() as usize % 512;
                    (0..len).map(|_| (next_u32() & 0xff) as u8).collect()
                }
                _ => {
                    let link_len = next_u32() as usize % 96;
                    let link_body: Vec<u8> =
                        (0..link_len).map(|_| (next_u32() & 0xff) as u8).collect();
                    index(2, &[b"x"], &[(b"link", &link_body)])
                }
            };
            if let Ok(parsed) = parse_index_raw(&sample, 20, true, cap) {
                let bytes: usize = parsed.paths.iter().map(Vec::len).sum();
                peak_decoded_bytes = peak_decoded_bytes.max(bytes);
            }
            if let Ok(parsed) = parse_index_raw(&sample, 32, true, cap) {
                let bytes: usize = parsed.paths.iter().map(Vec::len).sum();
                peak_decoded_bytes = peak_decoded_bytes.max(bytes);
            }
        }

        assert!(peak_decoded_bytes <= cap);
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn git_command_forces_c_locale_and_sanitized_env() {
        let hooks = Path::new("/dev/null");
        let cmd = git_ls_files_command(Path::new("/tmp/repo"), &["dist"], hooks);
        let envs: HashMap<_, _> = cmd.get_envs().collect();
        assert_eq!(
            envs.get(std::ffi::OsStr::new("LC_ALL")),
            Some(&Some(std::ffi::OsStr::new("C")))
        );
        assert_eq!(
            envs.get(std::ffi::OsStr::new("LANG")),
            Some(&Some(std::ffi::OsStr::new("C")))
        );
        assert_eq!(
            envs.get(std::ffi::OsStr::new("GIT_NO_LAZY_FETCH")),
            Some(&Some(std::ffi::OsStr::new("1")))
        );
        assert_eq!(
            envs.get(std::ffi::OsStr::new("GIT_NO_REPLACE_OBJECTS")),
            Some(&Some(std::ffi::OsStr::new("1")))
        );
        assert_eq!(
            envs.get(std::ffi::OsStr::new("GIT_TERMINAL_PROMPT")),
            Some(&Some(std::ffi::OsStr::new("0")))
        );
        assert_eq!(
            envs.get(std::ffi::OsStr::new("GIT_OPTIONAL_LOCKS")),
            Some(&Some(std::ffi::OsStr::new("0")))
        );
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        for flag in [
            "protocol.allow=never",
            "protocol.file.allow=never",
            "protocol.git.allow=never",
            "protocol.ssh.allow=never",
            "protocol.http.allow=never",
            "protocol.https.allow=never",
            "core.fsmonitor=false",
        ] {
            assert!(args.contains(&flag.to_owned()), "missing {flag}");
        }
        assert!(args.contains(&format!("core.hooksPath={}", hooks.display())));
    }

    #[test]
    fn split_index_validates_trailer_bitmaps_overlay_and_reads_without_git(
    ) -> Result<(), std::io::Error> {
        let dir = tempfile::tempdir()?;
        let tmp = dir.path();
        let git_dir = tmp.join(".git");
        std::fs::create_dir_all(&git_dir)?;

        let base_bytes = index(2, &[b"dist/deleted.js", b"dist/kept.js"], &[]);
        let base_trailer = &base_bytes[base_bytes.len() - 20..];
        let hex: String = base_trailer.iter().map(|b| format!("{b:02x}")).collect();
        let shared_path = git_dir.join(format!("sharedindex.{hex}"));
        std::fs::write(&shared_path, &base_bytes)?;

        // 1. Trailer mismatch must be rejected.
        let wrong_oid = [0x99u8; 20];
        let wrong_hex: String = wrong_oid.iter().map(|b| format!("{b:02x}")).collect();
        std::fs::write(
            git_dir.join(format!("sharedindex.{wrong_hex}")),
            &base_bytes,
        )?;
        let mut mismatch_link = wrong_oid.to_vec();
        mismatch_link.extend_from_slice(&[0u8; 12]);
        mismatch_link.extend_from_slice(&[0u8; 12]);
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b"out/added.js"], &[(b"link", &mismatch_link)]),
        )?;
        assert_eq!(read_index_paths(tmp), Err(IndexError::Unsupported));

        // 2. Out-of-range delete bit must be rejected.
        let mut oor_link = base_trailer.to_vec();
        oor_link.extend_from_slice(&build_ewah_rlw(3, false, 0, &[0b100]));
        oor_link.extend_from_slice(&[0u8; 12]);
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b"out/added.js"], &[(b"link", &oor_link)]),
        )?;
        assert_eq!(read_index_paths(tmp), Err(IndexError::Unsupported));

        // 3. Overlapping delete and replace bit must be rejected.
        let mut overlap_link = base_trailer.to_vec();
        overlap_link.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b01]));
        overlap_link.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b01]));
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b""], &[(b"link", &overlap_link)]),
        )?;
        assert_eq!(read_index_paths(tmp), Err(IndexError::Unsupported));

        // 4. Overlay order mismatch must be rejected.
        let mut bad_overlay = base_trailer.to_vec();
        bad_overlay.extend_from_slice(&[0u8; 12]);
        bad_overlay.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b01]));
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b"not-empty"], &[(b"link", &bad_overlay)]),
        )?;
        assert_eq!(read_index_paths(tmp), Err(IndexError::Unsupported));

        // 5. Valid split index: delete bit 0, replace bit 1, overlay = ["", "out/added.js"].
        let mut valid_link = base_trailer.to_vec();
        valid_link.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b01]));
        valid_link.extend_from_slice(&build_ewah_rlw(2, false, 0, &[0b10]));
        std::fs::write(
            git_dir.join("index"),
            index(2, &[b"", b"out/added.js"], &[(b"link", &valid_link)]),
        )?;

        let Ok(paths) = read_index_paths(tmp) else {
            panic!("read_index_paths should parse valid split index without git");
        };
        assert!(contains_tracked(&paths, b"dist/kept.js"));
        assert!(contains_tracked(&paths, b"out/added.js"));
        assert!(!contains_tracked(&paths, b"dist/deleted.js"));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_and_fifo_index_without_blocking() -> Result<(), std::io::Error> {
        let dir = tempfile::tempdir()?;
        let tmp = dir.path();
        let git_dir = tmp.join(".git");
        std::fs::create_dir_all(&git_dir)?;
        let real = tmp.join("real-index");
        std::fs::write(&real, index(2, &[b"a.txt"], &[]))?;

        // Symlinked index rejected.
        let idx_path = git_dir.join("index");
        std::os::unix::fs::symlink(&real, &idx_path)?;
        assert_eq!(read_index_paths(tmp), Err(IndexError::Unsupported));
        std::fs::remove_file(&idx_path)?;

        // FIFO index rejected without blocking.
        let status = Command::new("mkfifo")
            .arg(&idx_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if status.is_ok_and(|s| s.success()) {
            let start = Instant::now();
            assert_eq!(read_index_paths(tmp), Err(IndexError::Unsupported));
            assert!(start.elapsed() < Duration::from_millis(500));
            std::fs::remove_file(&idx_path)?;
        }

        // Symlinked and FIFO sharedindex.<oid> rejected without blocking.
        let shared_oid = [0x44u8; 20];
        let shared_hex: String = shared_oid.iter().map(|b| format!("{b:02x}")).collect();
        let shared_path = git_dir.join(format!("sharedindex.{shared_hex}"));
        let mut link = shared_oid.to_vec();
        link.extend_from_slice(&[0u8; 24]);
        std::fs::write(&idx_path, index(2, &[b"x.txt"], &[(b"link", &link)]))?;
        std::os::unix::fs::symlink(&real, &shared_path)?;
        assert_eq!(read_index_paths(tmp), Err(IndexError::Unsupported));
        std::fs::remove_file(&shared_path)?;

        let shared_fifo = Command::new("mkfifo")
            .arg(&shared_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if shared_fifo.is_ok_and(|s| s.success()) {
            let start = Instant::now();
            assert_eq!(read_index_paths(tmp), Err(IndexError::Unsupported));
            assert!(start.elapsed() < Duration::from_millis(500));
        }
        Ok(())
    }
}
