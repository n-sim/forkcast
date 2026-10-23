use axum::http::HeaderValue;
use forkcast_backend::{
    router,
    tls::{CertificateFiles, Identity, TlsListener, fingerprint_of},
};
use forkcast_core::{Config, Core, backup_database, restore_database};

/// How the server speaks HTTPS: `FORKCAST_TLS=self-signed` creates and keeps
/// its own certificate, `FORKCAST_TLS_CERT` and `FORKCAST_TLS_KEY` name
/// existing PEM files, and neither serves plain HTTP for a reverse proxy
/// (`None`). The flag is whether the certificate is the server's own.
fn tls_files(database: &str) -> Result<Option<(CertificateFiles, bool)>, String> {
    let certificate = std::env::var_os("FORKCAST_TLS_CERT").map(std::path::PathBuf::from);
    let key = std::env::var_os("FORKCAST_TLS_KEY").map(std::path::PathBuf::from);
    let mode = std::env::var("FORKCAST_TLS").unwrap_or_default();
    match (mode.as_str(), certificate, key) {
        ("self-signed", certificate, key) => {
            let beside = CertificateFiles::beside(std::path::Path::new(database));
            Ok(Some((
                CertificateFiles {
                    certificate: certificate.unwrap_or(beside.certificate),
                    key: key.unwrap_or(beside.key),
                },
                true,
            )))
        }
        ("", Some(certificate), Some(key)) => {
            Ok(Some((CertificateFiles { certificate, key }, false)))
        }
        ("", None, None) | ("off", _, _) => Ok(None),
        ("", _, _) => Err("Set both FORKCAST_TLS_CERT and FORKCAST_TLS_KEY, or neither.".into()),
        (other, _, _) => Err(format!(
            "FORKCAST_TLS must be off or self-signed, not {other:?}."
        )),
    }
}

fn database_path() -> String {
    std::env::var("FORKCAST_DATABASE").unwrap_or_else(|_| "forkcast.sqlite3".into())
}

/// `forkcast-backend --health`: exit 0 when this host's server answers, for
/// container health checks. Over HTTPS it accepts only the server's own
/// certificate.
fn health() -> ! {
    use std::io::{Read, Write};
    let bind = std::env::var("FORKCAST_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let port = bind.rsplit(':').next().unwrap_or("8787");
    let request = b"GET /api/status HTTP/1.0\r\n\r\n";
    let answered =
        |reply: &str| reply.starts_with("HTTP/1.0 200") || reply.starts_with("HTTP/1.1 200");
    let healthy = match tls_files(&database_path()) {
        Ok(None) => std::net::TcpStream::connect(format!("127.0.0.1:{port}"))
            .and_then(|mut stream| {
                stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
                stream.write_all(request)?;
                let mut reply = String::new();
                stream.read_to_string(&mut reply)?;
                Ok(answered(&reply))
            })
            .unwrap_or(false),
        Ok(Some((files, _))) => fingerprint_of(&files.certificate)
            .ok()
            .and_then(|fingerprint| {
                let config = forkcast_core::tls::pinned_client_config(&fingerprint);
                let name = rustls::pki_types::ServerName::try_from("localhost").ok()?;
                let connection = rustls::ClientConnection::new(config, name).ok()?;
                let socket = std::net::TcpStream::connect(format!("127.0.0.1:{port}")).ok()?;
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .ok()?;
                let mut stream = rustls::StreamOwned::new(connection, socket);
                stream.write_all(request).ok()?;
                let mut reply = Vec::new();
                // A server may close without a TLS close_notify; the reply is
                // already complete by then.
                let _ = stream.read_to_end(&mut reply);
                Some(answered(&String::from_utf8_lossy(&reply)))
            })
            .unwrap_or(false),
        Err(_) => false,
    };
    std::process::exit(if healthy { 0 } else { 1 })
}

/// `forkcast-backend --fingerprint`: print the SHA-256 fingerprint of the
/// server's certificate, which installed apps ask the person to compare.
fn print_fingerprint() -> ! {
    let result = tls_files(&database_path()).and_then(|files| match files {
        Some((files, _)) => fingerprint_of(&files.certificate),
        None => Err("This server does not serve HTTPS itself (FORKCAST_TLS is off).".into()),
    });
    match result {
        Ok(fingerprint) => {
            println!("{fingerprint}");
            std::process::exit(0)
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1)
        }
    }
}

const USAGE: &str = "Usage:
  forkcast-backend                         run the household server
  forkcast-backend backup <FILE>           write a backup of the database (the server may keep running)
  forkcast-backend restore <FILE> [--replace]
                                           recover a backup into the database (stop the server first)";

/// `backup` and `restore`: the supported administration workflow for the
/// server's data. Both act on `FORKCAST_DATABASE`.
fn administer(arguments: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let path = database_path();
    let database = std::path::Path::new(&path);
    let replace = arguments.iter().any(|argument| argument == "--replace");
    let files: Vec<&String> = arguments[1..]
        .iter()
        .filter(|argument| *argument != "--replace")
        .collect();
    let [file] = files.as_slice() else {
        return Err(USAGE.into());
    };
    let file = std::path::Path::new(file.as_str());
    match arguments[0].as_str() {
        "backup" if !replace => {
            let report = backup_database(database, file)?;
            println!(
                "Backed up {} accounts and {} recipes (schema {}) to {}.
ChatGPT sessions are not included; see docs/server.md.",
                report.accounts,
                report.recipes,
                report.schema_version,
                file.display()
            );
        }
        "restore" => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs() as i64;
            let report = restore_database(file, database, replace, stamp)?;
            println!(
                "Recovered {} accounts and {} recipes into {}.",
                report.backup.accounts,
                report.backup.recipes,
                database.display()
            );
            if let Some(previous) = report.previous {
                println!(
                    "The database it replaced was kept at {}.",
                    previous.display()
                );
            }
        }
        _ => return Err(USAGE.into()),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.iter().any(|argument| argument == "--health") {
        health();
    }
    if std::env::args().any(|argument| argument == "--fingerprint") {
        print_fingerprint();
    }
    if matches!(
        arguments.first().map(String::as_str),
        Some("backup" | "restore")
    ) {
        return administer(&arguments);
    }
    if !arguments.is_empty() {
        return Err(USAGE.into());
    }
    let bind = std::env::var("FORKCAST_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let path = database_path();
    let tls = tls_files(&path)?
        .map(|(files, self_signed)| {
            if self_signed {
                Identity::load_or_create(&files)
            } else {
                Identity::load(&files)
            }
        })
        .transpose()
        .map_err(|error| format!("Cannot use the HTTPS certificate: {error}"))?;
    let mut config = Config::new(&path);
    // ChatGPT sessions live beside the database in an owner-only file, never
    // in the database itself, so a database backup holds no credentials.
    #[cfg(unix)]
    {
        let secrets = std::env::var_os("FORKCAST_SECRETS_FILE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::Path::new(&path).with_extension("secrets"));
        config.secrets =
            std::sync::Arc::new(forkcast_core::FileSecrets::open(&secrets).map_err(|error| {
                format!(
                    "Cannot open protected credential storage {}: {error}",
                    secrets.display()
                )
            })?);
    }
    #[cfg(not(unix))]
    eprintln!(
        "Protected credential storage is unavailable on this platform; ChatGPT sessions are kept in memory only."
    );
    // Debug builds may point sign-in at an isolated loopback fixture.
    if cfg!(debug_assertions)
        && let Ok(issuer) = std::env::var("FORKCAST_AI_TEST_ISSUER")
    {
        config.ai = forkcast_core::AiConfig::fixture(&issuer)?;
    }
    let core =
        Core::open(config).map_err(|error| format!("Cannot open backend database: {error}"))?;
    let origins = std::env::var("FORKCAST_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://127.0.0.1:5173,http://127.0.0.1:4173".into())
        .split(',')
        .map(|origin| origin.trim().parse::<HeaderValue>())
        .collect::<Result<Vec<_>, _>>()?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let address = listener.local_addr()?;
    let frontend = std::env::var_os("FORKCAST_STATIC_DIR").map(std::path::PathBuf::from);
    if let Some(directory) = frontend
        .as_ref()
        .filter(|directory| !directory.join("index.html").is_file())
    {
        return Err(format!(
            "FORKCAST_STATIC_DIR must contain a built frontend (index.html): {}",
            directory.display()
        )
        .into());
    }
    let app = router(core, origins, frontend);
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    match tls {
        Some(identity) => {
            println!(
                "Certificate SHA-256 fingerprint: {}",
                identity.fingerprint()
            );
            println!("Forkcast backend listening on https://{address}");
            let listener = TlsListener::new(listener, identity.acceptor()?)?;
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown)
                .await?;
        }
        None => {
            println!("Forkcast backend listening on http://{address}");
            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown)
                .await?;
        }
    }
    Ok(())
}
