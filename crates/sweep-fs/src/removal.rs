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

const MAX_DEPTH: usize = 32;
const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
    .union(ResolveFlags::NO_SYMLINKS)
    .union(ResolveFlags::NO_XDEV);

pub struct RemovalRoot {
    fd: OwnedFd,
}
struct Frame {
    dir: Dir,
    name: OsString,
    identity: (u64, u64),
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

    /// Removes one relative approved entry. At most 32 directory frames are
    /// retained. Interior symlinks are unlinked; mounts (including bind mounts)
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
        let mut frames = vec![Frame {
            dir: Dir::new(leaf)?,
            name: name.to_owned(),
            identity: expected,
        }];
        while !frames.is_empty() {
            step();
            cancelled(flag)?;
            let frame = frames.last_mut().ok_or_else(changed)?;
            match frame.dir.next() {
                Some(item) => {
                    let item = item?;
                    let name = item.file_name();
                    if name.to_bytes() == b"." || name.to_bytes() == b".." {
                        continue;
                    }
                    let fd = frame.dir.fd()?;
                    // O_PATH avoids opening FIFO/device contents or blocking on
                    // them, and NOFOLLOW keeps a symlink itself as the leaf.
                    let child = open_relative(fd, name, false)?;
                    let stat = rfs::fstat(&child)?;
                    if FileType::from_raw_mode(stat.st_mode) == FileType::Directory {
                        if frames.len() >= MAX_DEPTH {
                            return Err(io::Error::other("secure removal directory depth limit (32) exceeded; some descendants may already have been removed"));
                        }
                        let frame = frames.last().ok_or_else(changed)?;
                        let directory = open_relative(frame.dir.fd()?, name, true)?;
                        if identity(&rfs::fstat(&directory)?) != identity(&stat) {
                            return Err(changed());
                        }
                        use std::os::unix::ffi::OsStrExt;
                        frames.push(Frame {
                            dir: Dir::new(directory)?,
                            name: std::ffi::OsStr::from_bytes(name.to_bytes()).to_owned(),
                            identity: identity(&stat),
                        });
                    } else {
                        cancelled(flag)?;
                        rfs::unlinkat(fd, name, AtFlags::empty())?;
                    }
                }
                None => {
                    let completed = frames.pop().ok_or_else(changed)?;
                    let fd = match frames.last() {
                        Some(frame) => frame.dir.fd()?,
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
                    cancelled(flag)?;
                    rfs::unlinkat(fd, &completed.name, AtFlags::REMOVEDIR)?;
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
    fn directory_depth_is_bounded_and_raw_names_are_supported() {
        let root = tempfile::tempdir().unwrap_or_else(|e| panic!("fixture: {e}"));
        let artifact = root.path().join("target");
        fs::create_dir(&artifact).unwrap_or_else(|e| panic!("mkdir: {e}"));
        let mut deep = artifact.clone();
        for _ in 0..40 {
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
        assert!(result
            .err()
            .is_some_and(|e| e.to_string().contains("depth limit")));
        assert!(deep.join("keep").exists());
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
