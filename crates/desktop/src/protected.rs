//! Protected storage for remote session tokens. On Windows the whole store is
//! encrypted with DPAPI, bound to the current Windows user. Platforms without
//! a protected-storage adapter keep secrets in memory only, so a restart
//! asks the person to sign in again rather than writing tokens in the clear.

#[cfg(not(any(windows, target_os = "android")))]
use forkcast_core::MemorySecrets;
use forkcast_core::Secrets;
use std::{path::PathBuf, sync::Arc};
#[cfg(windows)]
use {
    forkcast_core::{Error, Result},
    std::{collections::BTreeMap, fs, io, sync::Mutex},
};

pub fn open(directory: PathBuf, app: &tauri::AppHandle) -> Arc<dyn Secrets> {
    #[cfg(windows)]
    {
        let _ = app;
        Arc::new(Protected::new(directory.join("secrets.dat")))
    }
    #[cfg(target_os = "android")]
    {
        let _ = directory;
        tauri_plugin_forkcast_secure_store::secrets(app)
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (directory, app);
        Arc::new(MemorySecrets::default())
    }
}

#[cfg(windows)]
struct Protected {
    path: PathBuf,
    lock: Mutex<()>,
}

#[cfg(windows)]
impl Protected {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    fn load(&self) -> Result<BTreeMap<String, String>> {
        match fs::read(&self.path) {
            Ok(bytes) => {
                // A store that cannot be unprotected (another user, damage) is
                // treated as empty: tokens are replaceable by signing in.
                let Ok(plain) = crypt(bytes, false) else {
                    return Ok(BTreeMap::new());
                };
                Ok(serde_json::from_slice(&plain).unwrap_or_default())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(unavailable(error)),
        }
    }

    fn save(&self, secrets: &BTreeMap<String, String>) -> Result<()> {
        let bytes = crypt(
            serde_json::to_vec(secrets).map_err(|_| Error::internal())?,
            true,
        )
        .map_err(unavailable)?;
        let pending = self.path.with_extension("pending");
        fs::write(&pending, bytes).map_err(unavailable)?;
        fs::rename(&pending, &self.path).map_err(unavailable)
    }
}

#[cfg(windows)]
fn unavailable(error: io::Error) -> Error {
    eprintln!("Protected storage failed: {error}");
    Error::new(
        forkcast_core::ErrorKind::Internal,
        "Credentials could not be protected on this device. Check the app's storage permissions.",
    )
}

#[cfg(windows)]
impl Secrets for Protected {
    fn get(&self, key: &str) -> Result<Option<String>> {
        let _guard = self.lock.lock().expect("secrets lock poisoned");
        Ok(self.load()?.remove(key))
    }

    fn set(&self, key: &str, value: &str) -> Result<()> {
        let _guard = self.lock.lock().expect("secrets lock poisoned");
        let mut secrets = self.load()?;
        secrets.insert(key.to_owned(), value.to_owned());
        self.save(&secrets)
    }

    fn delete(&self, key: &str) -> Result<()> {
        let _guard = self.lock.lock().expect("secrets lock poisoned");
        let mut secrets = self.load()?;
        if secrets.remove(key).is_some() {
            self.save(&secrets)?;
        }
        Ok(())
    }
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
    // DPAPI binds the encrypted store to the current Windows user.
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
