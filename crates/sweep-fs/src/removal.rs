//! Linux deletion anchored to owned descriptors. No pathname recursion or
//! fallback when the kernel cannot enforce mount/resolution restrictions.
use rustix::{
    fd::OwnedFd,
    fs::{self as rfs, AtFlags, Dir, FileType, Mode, OFlags, ResolveFlags},
};
use std::{
    ffi::OsString,
    io,
    path::{Component, Path},
    sync::atomic::{AtomicBool, Ordering},
};

const MAX_OPEN_DIRS: usize = 16;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_REDRAINS: u8 = 2;
const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_XDEV);

pub struct RemovalRoot {
    fd: OwnedFd,
}
struct Frame {
    dir: Option<Dir>,
    name: OsString,
    identity: (u64, u64),
    redrains: u8,
}

fn frame_bytes(name: &std::ffi::OsStr) -> usize {
    use std::os::unix::ffi::OsStrExt;
    128 + name.as_bytes().len()
}

fn evict_oldest(frames: &mut [Frame]) {
    if frames.iter().filter(|frame| frame.dir.is_some()).count() >= MAX_OPEN_DIRS {
        if let Some(frame) = frames.iter_mut().find(|frame| frame.dir.is_some()) {
            frame.dir = None;
        }
    }
}

/// Reopen through the pinned candidate, never a live absolute pathname. Every
/// component must retain its original identity and kernel resolution guards.
fn restore_frame(
    anchor: &OwnedFd,
    frames: &mut [Frame],
    index: usize,
    flag: &AtomicBool,
) -> io::Result<()> {
    if frames[index].dir.is_some() {
        return Ok(());
    }
    evict_oldest(frames);
    let mut fd = open_relative(anchor, ".", true)?;
    for (depth, frame) in frames[..=index].iter().enumerate() {
        cancelled(flag)?;
        if depth != 0 {
            fd = open_relative(&fd, &frame.name, true)?;
        }
        if identity(&rfs::fstat(&fd)?) != frame.identity {
            return Err(changed());
        }
    }
    // Restart enumeration: completed entries are gone. This avoids relying
    // on an opaque directory cookie remaining valid across reopen/removal.
    frames[index].dir = Some(Dir::new(fd)?);
    Ok(())
}
fn identity(stat: &rfs::Stat) -> (u64, u64) {
    (stat.st_dev, stat.st_ino)
}
fn changed() -> io::Error {
    io::Error::other("entry identity changed before removal")
}
fn cancelled(flag: &AtomicBool) -> io::Result<()> {
    if flag.load(Ordering::Acquire) {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "deletion cancelled; some descendants may already have been removed",
        ))
    } else {
        Ok(())
    }
}
fn open_relative(
    fd: impl rustix::fd::AsFd,
    path: impl rustix::path::Arg,
    directory: bool,
) -> io::Result<OwnedFd> {
    let flags = OFlags::CLOEXEC
        | OFlags::NOFOLLOW
        | if directory {
            OFlags::RDONLY | OFlags::DIRECTORY
        } else {
            OFlags::PATH
        };
    rfs::openat2(fd, path, flags, Mode::empty(), RESOLVE).map_err(|err| {
        if err == rustix::io::Errno::NOSYS || err == rustix::io::Errno::INVAL {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "secure Linux deletion requires openat2 resolution support; no pathname fallback",
            )
        } else {
            io::Error::from(err)
        }
    })
}
impl RemovalRoot {
    pub fn open(path: &Path, expected: (u64, u64)) -> io::Result<Self> {
        let fd = rfs::open(
            path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?;
        if identity(&rfs::fstat(&fd)?) != expected {
            return Err(changed());
        }
        Ok(Self { fd })
    }

    /// Removes one relative approved entry. At most 16 directory iterators and
    /// one MiB of logical frame metadata are retained, independently of depth.
    /// Interior symlinks are unlinked; mounts (including bind mounts)
    /// and symlinked ancestors are refused by every kernel resolution.
    pub fn remove(
        &self,
        path: &Path,
        expected: (u64, u64),
        directory: bool,
        flag: &AtomicBool,
    ) -> io::Result<()> {
        self.remove_with_step(path, expected, directory, flag, &mut || {})
    }

    fn remove_with_step(
        &self,
        path: &Path,
        expected: (u64, u64),
        directory: bool,
        flag: &AtomicBool,
        step: &mut dyn FnMut(),
    ) -> io::Result<()> {
        self.remove_with_hooks(path, expected, directory, flag, step, &mut || {})
    }

    fn remove_with_hooks(
        &self,
        path: &Path,
        expected: (u64, u64),
        directory: bool,
        flag: &AtomicBool,
        step: &mut dyn FnMut(),
        before_rmdir: &mut dyn FnMut(),
    ) -> io::Result<()> {
        cancelled(flag)?;
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "removal requires a nonempty relative path without dot segments",
            ));
        }
        let name = path.file_name().ok_or_else(changed)?;
        let parent = open_relative(
            &self.fd,
            path.parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
            true,
        )?;
        let leaf = open_relative(&parent, name, directory)?;
        let stat = rfs::fstat(&leaf)?;
        if identity(&stat) != expected
            || (FileType::from_raw_mode(stat.st_mode) == FileType::Directory) != directory
        {
            return Err(changed());
        }
        cancelled(flag)?;
        if !directory {
            rfs::unlinkat(&parent, name, AtFlags::empty())?;
            return Ok(());
        }
        let mut retained_bytes = frame_bytes(name);
        let mut frames = vec![Frame {
            dir: Some(Dir::new(open_relative(&leaf, ".", true)?)?),
            name: name.to_owned(),
            identity: expected,
            redrains: 0,
        }];
        while !frames.is_empty() {
            step();
            cancelled(flag)?;
            let index = frames.len() - 1;
            restore_frame(&leaf, &mut frames, index, flag)?;
            let frame = frames.last_mut().ok_or_else(changed)?;
            let dir = frame.dir.as_mut().ok_or_else(changed)?;
            match dir.next() {
                Some(item) => {
                    let item = item?;
                    let name = item.file_name();
                    if name.to_bytes() == b"." || name.to_bytes() == b".." {
                        continue;
                    }
                    let fd = dir.fd()?;
                    // O_PATH avoids opening FIFO/device contents or blocking on
                    // them, and NOFOLLOW keeps a symlink itself as the leaf.
                    let child = open_relative(fd, name, false)?;
                    let stat = rfs::fstat(&child)?;
                    if FileType::from_raw_mode(stat.st_mode) == FileType::Directory {
                        use std::os::unix::ffi::OsStrExt;
                        let name = std::ffi::OsStr::from_bytes(name.to_bytes()).to_owned();
                        let next_bytes = retained_bytes.checked_add(frame_bytes(&name)).filter(|bytes| *bytes <= MAX_FRAME_BYTES).ok_or_else(|| io::Error::other("secure removal frame metadata limit exceeded; some descendants may already have been removed"))?;
                        let directory = open_relative(fd, &name, true)?;
                        if identity(&rfs::fstat(&directory)?) != identity(&stat) {
                            return Err(changed());
                        }
                        evict_oldest(&mut frames);
                        frames.push(Frame {
                            dir: Some(Dir::new(directory)?),
                            name,
                            identity: identity(&stat),
                            redrains: 0,
                        });
                        retained_bytes = next_bytes;
                    } else {
                        cancelled(flag)?;
                        rfs::unlinkat(fd, name, AtFlags::empty())?;
                    }
                }
                None => {
                    let mut completed = frames.pop().ok_or_else(changed)?;
                    // EOF iterators no longer need an FD. Close before restoring
                    // an evicted parent or opening a retry iterator.
                    completed.dir = None;
                    if !frames.is_empty() {
                        let index = frames.len() - 1;
                        restore_frame(&leaf, &mut frames, index, flag)?;
                    }
                    let fd = match frames.last() {
                        Some(frame) => frame.dir.as_ref().ok_or_else(changed)?.fd()?,
                        None => rustix::fd::AsFd::as_fd(&parent),
                    };
                    if identity(&rfs::statat(
                        fd,
                        &completed.name,
                        AtFlags::SYMLINK_NOFOLLOW,
                    )?) != completed.identity
                    {
                        return Err(changed());
                    }
                    before_rmdir();
                    cancelled(flag)?;
                    match rfs::unlinkat(fd, &completed.name, AtFlags::REMOVEDIR) {
                        Ok(()) => retained_bytes -= frame_bytes(&completed.name),
                        Err(err)
                            if err == rustix::io::Errno::NOTEMPTY
                                && completed.redrains < MAX_REDRAINS =>
                        {
                            // A writer can add entries after iterator EOF. Retry
                            // this exact directory only, through its pinned
                            // parent with all mount/symlink restrictions intact.
                            cancelled(flag)?;
                            let reopened = open_relative(fd, &completed.name, true)?;
                            if identity(&rfs::fstat(&reopened)?) != completed.identity {
                                return Err(changed());
                            }
                            evict_oldest(&mut frames);
                            completed.dir = Some(Dir::new(reopened)?);
                            completed.redrains += 1;
                            frames.push(completed);
                        }
                        Err(err) => return Err(err.into()),
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, MetadataExt},
        sync::atomic::Ordering,
    };
    fn id(path: &Path) -> (u64, u64) {
        let meta = fs::symlink_metadata(path).unwrap_or_else(|e| panic!("metadata: {e}"));
        (meta.dev(), meta.ino())
    }
    #[test]
    fn one_late_writer_is_redrained_without_touching_an_unselected_sentinel() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let artifact = root.path().join("target");
        fs::create_dir(&artifact)?;
        fs::write(root.path().join("keep"), "keep")?;
        let anchor = RemovalRoot::open(root.path(), id(root.path()))?;
        let mut writes = 0;
        anchor.remove_with_hooks(
            Path::new("target"),
            id(&artifact),
            true,
            &AtomicBool::new(false),
            &mut || {},
            &mut || {
                if writes == 0 {
                    fs::write(artifact.join("late"), "late")
                        .unwrap_or_else(|e| panic!("late write: {e}"));
                    writes += 1;
                }
            },
        )?;
        assert_eq!(writes, 1);
        assert!(!artifact.exists());
        assert_eq!(fs::read_to_string(root.path().join("keep"))?, "keep");
        Ok(())
    }

    #[test]
    fn cancellation_during_redrain_preserves_late_contents() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let artifact = root.path().join("target");
        fs::create_dir(&artifact)?;
        let anchor = RemovalRoot::open(root.path(), id(root.path()))?;
        let cancel = AtomicBool::new(false);
        let draining_again = std::cell::Cell::new(false);
        let result = anchor.remove_with_hooks(
            Path::new("target"),
            id(&artifact),
            true,
            &cancel,
            &mut || {
                if draining_again.get() {
                    cancel.store(true, Ordering::Release);
                }
            },
            &mut || {
                fs::write(artifact.join("late"), "keep")
                    .unwrap_or_else(|e| panic!("late write: {e}"));
                draining_again.set(true);
            },
        );
        assert!(result.is_err_and(|err| err.kind() == io::ErrorKind::Interrupted));
        assert_eq!(fs::read_to_string(artifact.join("late"))?, "keep");
        Ok(())
    }

    #[test]
    fn repeated_writers_stop_after_two_redrains() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let artifact = root.path().join("target");
        fs::create_dir(&artifact)?;
        let anchor = RemovalRoot::open(root.path(), id(root.path()))?;
        let mut attempts = 0;
        let result = anchor.remove_with_hooks(
            Path::new("target"),
            id(&artifact),
            true,
            &AtomicBool::new(false),
            &mut || {},
            &mut || {
                attempts += 1;
                fs::write(artifact.join("late"), "late")
                    .unwrap_or_else(|e| panic!("late write: {e}"));
            },
        );
        assert!(result.is_err());
        assert_eq!(attempts, 3);
        assert!(artifact.join("late").exists());
        Ok(())
    }

    #[test]
    fn replacement_during_redrain_keeps_its_new_contents() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let artifact = root.path().join("target");
        fs::create_dir(&artifact)?;
        let anchor = RemovalRoot::open(root.path(), id(root.path()))?;
        let mut replaced = false;
        let result = anchor.remove_with_hooks(
            Path::new("target"),
            id(&artifact),
            true,
            &AtomicBool::new(false),
            &mut || {},
            &mut || {
                if !replaced {
                    fs::rename(&artifact, root.path().join("original"))
                        .unwrap_or_else(|e| panic!("rename: {e}"));
                    fs::create_dir(&artifact).unwrap_or_else(|e| panic!("replacement: {e}"));
                    fs::write(artifact.join("keep"), "keep")
                        .unwrap_or_else(|e| panic!("write: {e}"));
                    replaced = true;
                }
            },
        );
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(artifact.join("keep"))?, "keep");
        Ok(())
    }
    #[test]
    fn removal_unlinks_interior_links_and_preserves_external_contents() {
        let owned = tempfile::tempdir().unwrap_or_else(|e| panic!("fixture: {e}"));
        let root = owned.path().join("root");
        let outside = owned.path().join("outside");
        fs::create_dir(&root).unwrap_or_else(|e| panic!("mkdir: {e}"));
        fs::create_dir(&outside).unwrap_or_else(|e| panic!("mkdir: {e}"));
        fs::write(outside.join("keep"), "keep").unwrap_or_else(|e| panic!("write: {e}"));
        let artifact = root.join("target");
        fs::create_dir(&artifact).unwrap_or_else(|e| panic!("mkdir: {e}"));
        fs::write(artifact.join("file"), "owned").unwrap_or_else(|e| panic!("write: {e}"));
        symlink(&outside, artifact.join("link")).unwrap_or_else(|e| panic!("symlink: {e}"));
        let anchor = RemovalRoot::open(&root, id(&root)).unwrap_or_else(|e| panic!("anchor: {e}"));
        anchor
            .remove(
                Path::new("target"),
                id(&artifact),
                true,
                &AtomicBool::new(false),
            )
            .unwrap_or_else(|e| panic!("remove: {e}"));
        assert!(!artifact.exists());
        assert!(outside.join("keep").exists());
    }
    #[test]
    fn renamed_ancestor_replaced_by_link_cannot_redirect_removal() {
        let owned = tempfile::tempdir().unwrap_or_else(|e| panic!("fixture: {e}"));
        let root = owned.path().join("root");
        let outside = owned.path().join("outside");
        fs::create_dir_all(root.join("apps/target")).unwrap_or_else(|e| panic!("mkdir: {e}"));
        fs::create_dir_all(outside.join("target")).unwrap_or_else(|e| panic!("mkdir: {e}"));
        fs::write(outside.join("target/keep"), "keep").unwrap_or_else(|e| panic!("write: {e}"));
        let identity = id(&root.join("apps/target"));
        let anchor = RemovalRoot::open(&root, id(&root)).unwrap_or_else(|e| panic!("anchor: {e}"));
        fs::rename(root.join("apps"), root.join("original"))
            .unwrap_or_else(|e| panic!("rename: {e}"));
        symlink(&outside, root.join("apps")).unwrap_or_else(|e| panic!("link: {e}"));
        assert!(anchor
            .remove(
                Path::new("apps/target"),
                identity,
                true,
                &AtomicBool::new(false)
            )
            .is_err());
        assert!(outside.join("target/keep").exists());
        assert!(root.join("original/target").exists());
    }
    #[test]
    fn cancellation_and_identity_mismatch_preserve_artifacts() {
        let owned = tempfile::tempdir().unwrap_or_else(|e| panic!("fixture: {e}"));
        let file = owned.path().join("file");
        fs::write(&file, "keep").unwrap_or_else(|e| panic!("write: {e}"));
        let anchor = RemovalRoot::open(owned.path(), id(owned.path()))
            .unwrap_or_else(|e| panic!("anchor: {e}"));
        let cancel = AtomicBool::new(true);
        assert!(anchor
            .remove(Path::new("file"), id(&file), false, &cancel)
            .is_err());
        cancel.store(false, Ordering::Release);
        assert!(anchor
            .remove(Path::new("file"), (0, 1), false, &cancel)
            .is_err());
        assert!(file.exists());
    }
}

#[cfg(test)]
mod stress_tests {
    use super::*;
    use std::{
        fs,
        os::unix::{ffi::OsStringExt, fs::MetadataExt},
        sync::atomic::Ordering,
    };
    fn id(path: &Path) -> (u64, u64) {
        let m = fs::symlink_metadata(path).unwrap_or_else(|e| panic!("metadata: {e}"));
        (m.dev(), m.ino())
    }
    #[test]
    fn cancellation_is_observed_inside_one_artifact() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("fixture: {e}"));
        let artifact = root.path().join("target");
        fs::create_dir(&artifact).unwrap_or_else(|e| panic!("mkdir: {e}"));
        for n in 0..20 {
            fs::write(artifact.join(n.to_string()), "owned")
                .unwrap_or_else(|e| panic!("write: {e}"));
        }
        let anchor = RemovalRoot::open(root.path(), id(root.path()))
            .unwrap_or_else(|e| panic!("anchor: {e}"));
        let flag = AtomicBool::new(false);
        let mut calls = 0;
        let result =
            anchor.remove_with_step(Path::new("target"), id(&artifact), true, &flag, &mut || {
                calls += 1;
                if calls == 7 {
                    flag.store(true, Ordering::Release);
                }
            });
        assert_eq!(
            result.err().map(|e| e.kind()),
            Some(io::ErrorKind::Interrupted)
        );
        let remaining = fs::read_dir(&artifact)
            .unwrap_or_else(|e| panic!("read: {e}"))
            .count();
        assert!(remaining > 0 && remaining < 20);
    }
    #[test]
    fn deep_removal_keeps_handles_bounded_and_supports_raw_names() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("fixture: {e}"));
        let artifact = root.path().join("target");
        fs::create_dir(&artifact).unwrap_or_else(|e| panic!("mkdir: {e}"));
        let mut deep = artifact.clone();
        for _ in 0..128 {
            fs::write(deep.join("file"), "owned").unwrap_or_else(|e| panic!("write: {e}"));
            fs::create_dir(deep.join("sibling")).unwrap_or_else(|e| panic!("mkdir: {e}"));
            deep = deep.join("d");
            fs::create_dir(&deep).unwrap_or_else(|e| panic!("mkdir: {e}"));
        }
        fs::write(deep.join("keep"), "keep").unwrap_or_else(|e| panic!("write: {e}"));
        let anchor = RemovalRoot::open(root.path(), id(root.path()))
            .unwrap_or_else(|e| panic!("anchor: {e}"));
        let result = anchor.remove(
            Path::new("target"),
            id(&artifact),
            true,
            &AtomicBool::new(false),
        );
        result.unwrap_or_else(|e| panic!("deep removal: {e}"));
        assert!(!artifact.exists());
        let raw = root.path().join(OsString::from_vec(vec![255]));
        fs::write(&raw, "owned").unwrap_or_else(|e| panic!("write: {e}"));
        anchor
            .remove(
                Path::new(raw.file_name().unwrap_or_else(|| panic!("name"))),
                id(&raw),
                false,
                &AtomicBool::new(false),
            )
            .unwrap_or_else(|e| panic!("remove: {e}"));
        assert!(!raw.exists());
    }

    #[test]
    fn reopening_checks_evicted_ancestor_identity_and_does_not_follow_links() -> io::Result<()> {
        for use_link in [false, true] {
            let root = tempfile::tempdir()?;
            let artifact = root.path().join("target");
            let outside = root.path().join("outside");
            fs::create_dir(&artifact)?;
            fs::create_dir(&outside)?;
            fs::write(outside.join("keep"), "keep")?;
            let mut deep = artifact.clone();
            for _ in 0..64 {
                deep = deep.join("d");
                fs::create_dir(&deep)?;
            }
            let victim = artifact.join("d");
            let original = artifact.join("original");
            let anchor = RemovalRoot::open(root.path(), id(root.path()))?;
            let mut swapped = false;
            let result = anchor.remove_with_step(
                Path::new("target"),
                id(&artifact),
                true,
                &AtomicBool::new(false),
                &mut || {
                    if !swapped && !deep.exists() {
                        fs::rename(&victim, &original).unwrap_or_else(|e| panic!("swap: {e}"));
                        if use_link {
                            std::os::unix::fs::symlink(&outside, &victim)
                                .unwrap_or_else(|e| panic!("link: {e}"));
                        } else {
                            fs::create_dir(&victim).unwrap_or_else(|e| panic!("replacement: {e}"));
                            fs::write(victim.join("keep"), "keep")
                                .unwrap_or_else(|e| panic!("write: {e}"));
                        }
                        swapped = true;
                    }
                },
            );
            assert!(swapped);
            assert!(result.is_err());
            assert!(original.exists());
            assert_eq!(fs::read(outside.join("keep"))?, b"keep");
            assert_eq!(fs::read(victim.join("keep"))?, b"keep");
        }
        Ok(())
    }

    #[test]
    fn deep_removal_cancels_before_reopening_an_evicted_parent() -> io::Result<()> {
        let root = tempfile::tempdir()?;
        let artifact = root.path().join("target");
        fs::create_dir(&artifact)?;
        let mut deep = artifact.clone();
        for _ in 0..64 {
            deep = deep.join("d");
            fs::create_dir(&deep)?;
        }
        let anchor = RemovalRoot::open(root.path(), id(root.path()))?;
        let flag = AtomicBool::new(false);
        let result =
            anchor.remove_with_step(Path::new("target"), id(&artifact), true, &flag, &mut || {
                if !deep.exists() {
                    flag.store(true, Ordering::Release);
                }
            });
        assert_eq!(
            result.err().map(|error| error.kind()),
            Some(io::ErrorKind::Interrupted)
        );
        assert!(artifact.exists());
        assert!(!deep.exists());
        Ok(())
    }
    #[test]
    fn kernel_resolution_refuses_an_existing_mount_without_mutation() {
        // Open-only probe: never invoke removal on a system path. /proc is
        // a separate mounted filesystem on the Linux qualification host.
        let fd = rfs::open(
            "/",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .unwrap_or_else(|e| panic!("open: {e}"));
        if fs::metadata("/proc").ok().is_some_and(|m| {
            m.dev()
                != fs::metadata("/")
                    .unwrap_or_else(|e| panic!("stat: {e}"))
                    .dev()
        }) {
            assert!(open_relative(&fd, "proc", true).is_err());
        }
    }
}
