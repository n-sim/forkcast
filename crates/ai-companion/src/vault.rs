use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::PathBuf,
};

#[derive(Default, Deserialize, Serialize)]
pub struct Record {
    pub issuer: Option<String>,
    pub host_id: String,
    pub client_id: Option<String>,
    pub subject: Option<String>,
    pub email: Option<String>,
    pub tokens: Option<Tokens>,
}

#[derive(Deserialize, Serialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub scope: String,
    pub expires_at: u64,
}

pub struct Vault {
    directory: PathBuf,
    // A second companion cannot race rotating refresh tokens for this runtime.
    _lock: File,
}

fn private_file(path: PathBuf) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

impl Vault {
    pub fn open(directory: PathBuf) -> io::Result<(Self, Record)> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&directory)?;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        fs::create_dir_all(&directory)?;
        let lock = private_file(directory.join("runtime.lock"))?;
        lock.try_lock_exclusive()?;
        let vault = Self {
            directory,
            _lock: lock,
        };
        let record = match fs::read(vault.directory.join("credentials")) {
            Ok(bytes) => serde_json::from_slice(&unprotect(bytes)?)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Record::default(),
            Err(error) => return Err(error),
        };
        Ok((vault, record))
    }

    pub fn save(&self, record: &Record) -> io::Result<()> {
        let bytes = protect(serde_json::to_vec(record)?)?;
        let pending = self.directory.join("credentials.pending");
        // A crash may leave a staging file. Remove it before creating a new one
        // so Unix permissions are never inherited from an existing file.
        match fs::remove_file(&pending) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
        let mut file = private_file(pending.clone())?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        let target = self.directory.join("credentials");
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
            };
            let from: Vec<u16> = pending.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        #[cfg(not(windows))]
        fs::rename(pending, target)?;
        Ok(())
    }
}

#[cfg(not(windows))]
fn protect(bytes: Vec<u8>) -> io::Result<Vec<u8>> {
    Ok(bytes)
}
#[cfg(not(windows))]
fn unprotect(bytes: Vec<u8>) -> io::Result<Vec<u8>> {
    Ok(bytes)
}

#[cfg(windows)]
fn crypt(mut bytes: Vec<u8>, encrypt: bool) -> io::Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI binds the encrypted record to the current Windows user.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}
#[cfg(windows)]
fn protect(bytes: Vec<u8>) -> io::Result<Vec<u8>> {
    crypt(bytes, true)
}
#[cfg(windows)]
fn unprotect(bytes: Vec<u8>) -> io::Result<Vec<u8>> {
    crypt(bytes, false)
}
