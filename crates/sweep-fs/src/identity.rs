use std::{fs, io, path::Path};

/// Exact filesystem identity, with link count for apparent sizing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileIdentity {
    pub device: u64,
    pub inode: u64,
    pub links: u64,
}

impl FileIdentity {
    pub fn snapshot(self) -> sweep_types::FilesystemIdentity {
        sweep_types::FilesystemIdentity {
            platform: if cfg!(windows) { "windows" } else { "unix" }.to_owned(),
            device: self.device.to_string(),
            inode: self.inode.to_string(),
        }
    }
}

/// Identity of the leaf itself. Windows opens a metadata-only, non-following
/// handle; DirEntry metadata does not contain a stable file index.
pub fn file_identity(path: &Path, meta: &fs::Metadata) -> io::Result<Option<FileIdentity>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        Ok((meta.ino() != 0).then_some(FileIdentity {
            device: meta.dev(),
            inode: meta.ino(),
            links: meta.nlink(),
        }))
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, SECURITY_IDENTIFICATION,
        };
        let _ = meta;
        let file = fs::OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .security_qos_flags(SECURITY_IDENTIFICATION)
            .open(path)?;
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: File owns the live handle and info points to a writable
        // correctly sized output. The API initializes it only on success.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the successful API call initialized every field.
        let info = unsafe { info.assume_init() };
        let inode = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        Ok((inode != 0).then_some(FileIdentity {
            device: u64::from(info.dwVolumeSerialNumber),
            inode,
            links: u64::from(info.nNumberOfLinks),
        }))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, meta);
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_match_hardlinks_and_distinguish_replacements() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        fs::write(&first, b"keep").unwrap_or_else(|e| panic!("write: {e}"));
        fs::hard_link(&first, &second).unwrap_or_else(|e| panic!("link: {e}"));
        let read = |path: &Path| {
            let meta = fs::symlink_metadata(path).unwrap_or_else(|e| panic!("stat: {e}"));
            file_identity(path, &meta)
                .unwrap_or_else(|e| panic!("identity: {e}"))
                .unwrap_or_else(|| panic!("missing identity"))
        };
        assert_eq!(read(&first), read(&second));
        assert_eq!(read(&first).links, 2);
        fs::remove_file(&first).unwrap_or_else(|e| panic!("unlink: {e}"));
        fs::write(&first, b"new").unwrap_or_else(|e| panic!("write: {e}"));
        assert_ne!(read(&first).inode, read(&second).inode);
        let directory = read(dir.path());
        assert_ne!(directory.inode, read(&first).inode);
    }

    #[cfg(unix)]
    #[test]
    fn identity_does_not_follow_a_leaf_symlink() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(dir.path(), &link).unwrap_or_else(|e| panic!("symlink: {e}"));
        let linked = fs::symlink_metadata(&link).unwrap_or_else(|e| panic!("stat: {e}"));
        let root = fs::symlink_metadata(dir.path()).unwrap_or_else(|e| panic!("stat: {e}"));
        assert_ne!(
            file_identity(&link, &linked).ok(),
            file_identity(dir.path(), &root).ok()
        );
    }
}
