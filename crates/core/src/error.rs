use serde::Serialize;
use serde_json::Value;
use std::fmt;

/// Transport-independent failure classes. Adapters map these to their own
/// status codes; the HTTP adapter uses 401, 403, 404, 409, 422, 429, 500.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Unauthenticated,
    Forbidden,
    NotFound,
    Conflict,
    Invalid,
    RateLimited,
    /// The database or request needs a newer Forkcast. Nothing was changed.
    Unsupported,
    Internal,
    /// The server could not be reached.
    Unavailable,
    /// Client and server speak different synchronization protocol versions.
    ProtocolMismatch,
    /// The person's ChatGPT connection is missing or ended; connect again.
    ConnectionRequired,
}

#[derive(Debug, Serialize)]
pub struct Error {
    pub kind: ErrorKind,
    pub message: String,
    /// Field-level validation details when the domain reports them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Value>,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            fields: None,
        }
    }

    pub fn unauthenticated() -> Self {
        Self::new(
            ErrorKind::Unauthenticated,
            "Sign in to your backend account.",
        )
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Forbidden, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Conflict, message)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }

    pub fn internal() -> Self {
        Self::new(
            ErrorKind::Internal,
            "The backend could not complete this request.",
        )
    }

    pub fn with_fields(mut self, fields: Value) -> Self {
        self.fields = Some(fields);
        self
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        eprintln!("Database operation failed: {error}");
        Self::internal()
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        eprintln!("Stored data could not be read: {error}");
        Self::internal()
    }
}
