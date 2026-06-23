//! Shared error types for the Rust sweep engine workspace.

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReasonCode {
    Missing,
    ChangedSymlinkState,
    ChangedEntryType,
    OutsideTarget,
    PermissionDenied,
    Busy,
    FilesystemError,
}

impl FailureReasonCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::ChangedSymlinkState => "changed_symlink_state",
            Self::ChangedEntryType => "changed_entry_type",
            Self::OutsideTarget => "outside_target",
            Self::PermissionDenied => "permission_denied",
            Self::Busy => "busy",
            Self::FilesystemError => "filesystem_error",
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum GuardrailError {
    #[error("target directory is outside the allowed root: {path}")]
    OutsideAllowedRoot { path: String },

    #[error("refusing to delete protected path: {path}")]
    ProtectedPath { path: String },

    #[error("selection exceeds configured size limit: {selected_bytes} bytes")]
    SizeLimitExceeded { selected_bytes: u64 },

    #[error("plan protocol version {found} is not supported (expected {expected})")]
    UnsupportedProtocolVersion { found: String, expected: String },
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error(transparent)]
    Guardrail(#[from] GuardrailError),

    #[error("invalid scan plan: {message}")]
    InvalidPlan { message: String },

    #[error("filesystem error at {path}: {source}")]
    Filesystem {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_reason_codes_use_snake_case_serialization() {
        let code = FailureReasonCode::PermissionDenied;
        let json = serde_json::to_string(&code).unwrap_or_else(|err| {
            panic!("failed to serialize FailureReasonCode: {err}");
        });
        assert_eq!(json, "\"permission_denied\"");
    }

    #[test]
    fn guardrail_error_formats_message() {
        let err = GuardrailError::ProtectedPath {
            path: "/".to_owned(),
        };
        assert!(err.to_string().contains("protected path"));
    }
}
