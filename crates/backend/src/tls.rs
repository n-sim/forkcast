//! HTTPS served by the household server itself, for networks without a
//! reverse proxy. The certificate is either one the operator provides or a
//! self-signed one the server creates once and keeps beside its database;
//! installed apps pin a self-signed certificate by its SHA-256 fingerprint
//! (see `forkcast_core::tls`).

use rustls::{
    ServerConfig,
    crypto::ring,
    pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
};
use std::{
    io,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

/// Where the server's certificate and private key live (PEM files).
#[derive(Clone, Debug)]
pub struct CertificateFiles {
    pub certificate: PathBuf,
    pub key: PathBuf,
}

impl CertificateFiles {
    /// The self-signed pair beside a database: `forkcast.tls.crt` and
    /// `forkcast.tls.key` for `forkcast.sqlite3`.
    pub fn beside(database: &Path) -> Self {
        Self {
            certificate: database.with_extension("tls.crt"),
            key: database.with_extension("tls.key"),
        }
    }
}

/// A loaded certificate chain and key.
pub struct Identity {
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
}

fn failure(path: &Path, error: impl std::fmt::Display) -> String {
    format!("{}: {error}", path.display())
}

impl Identity {
    /// Reads an existing certificate chain and private key.
    pub fn load(files: &CertificateFiles) -> Result<Self, String> {
        let chain = CertificateDer::pem_file_iter(&files.certificate)
            .and_then(|certificates| certificates.collect::<Result<Vec<_>, _>>())
            .map_err(|error| failure(&files.certificate, error))?;
        if chain.is_empty() {
            return Err(failure(&files.certificate, "no certificate found"));
        }
        let key =
            PrivateKeyDer::from_pem_file(&files.key).map_err(|error| failure(&files.key, error))?;
        Ok(Self { chain, key })
    }

    /// Reads the self-signed pair, creating it on first use. The key is
    /// written owner-only before the certificate, so a certificate never
    /// exists without its key.
    pub fn load_or_create(files: &CertificateFiles) -> Result<Self, String> {
        if files.certificate.exists() || files.key.exists() {
            return Self::load(files);
        }
        let mut names = vec![
            "localhost".to_owned(),
            "127.0.0.1".to_owned(),
            "::1".to_owned(),
        ];
        if let Some(host) = hostname() {
            names.push(format!("{host}.local"));
            names.insert(0, host);
        }
        let generated = rcgen::generate_simple_self_signed(names)
            .map_err(|error| format!("Cannot create a certificate: {error}"))?;
        write_private(&files.key, generated.signing_key.serialize_pem().as_bytes())
            .map_err(|error| failure(&files.key, error))?;
        std::fs::write(&files.certificate, generated.cert.pem())
            .map_err(|error| failure(&files.certificate, error))?;
        Self::load(files)
    }

    /// The SHA-256 fingerprint of the server's certificate, as installed
    /// apps show it for confirmation.
    pub fn fingerprint(&self) -> String {
        forkcast_core::tls::fingerprint(&self.chain[0])
    }

    pub fn acceptor(&self) -> Result<TlsAcceptor, String> {
        let config = ServerConfig::builder_with_provider(Arc::new(ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|error| error.to_string())?
            .with_no_client_auth()
            .with_single_cert(self.chain.clone(), self.key.clone_key())
            .map_err(|error| format!("The certificate and key do not match: {error}"))?;
        Ok(TlsAcceptor::from(Arc::new(config)))
    }
}

/// The fingerprint of the first certificate in a PEM file.
pub fn fingerprint_of(path: &Path) -> Result<String, String> {
    let certificate = CertificateDer::from_pem_file(path).map_err(|error| failure(path, error))?;
    Ok(forkcast_core::tls::fingerprint(&certificate))
}

fn hostname() -> Option<String> {
    let name = std::fs::read_to_string("/etc/hostname").ok()?;
    let name = name.trim();
    (!name.is_empty() && !name.contains('.')).then(|| name.to_owned())
}

#[cfg(unix)]
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    std::fs::write(path, contents)
}

/// Accepts TLS connections for [`axum::serve`]. Handshakes run on their own
/// tasks, so a slow or silent client never holds up the next connection.
pub struct TlsListener {
    connections: mpsc::Receiver<(TlsStream<tokio::net::TcpStream>, SocketAddr)>,
    address: SocketAddr,
}

impl TlsListener {
    pub fn new(listener: TcpListener, acceptor: TlsAcceptor) -> io::Result<Self> {
        let address = listener.local_addr()?;
        let (send, connections) = mpsc::channel(64);
        tokio::spawn(async move {
            loop {
                let (socket, peer) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(_) => {
                        // Out of file descriptors and similar: wait, then go on.
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                let (acceptor, send) = (acceptor.clone(), send.clone());
                tokio::spawn(async move {
                    let handshake =
                        tokio::time::timeout(Duration::from_secs(10), acceptor.accept(socket));
                    if let Ok(Ok(stream)) = handshake.await {
                        let _ = send.send((stream, peer)).await;
                    }
                });
            }
        });
        Ok(Self {
            connections,
            address,
        })
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<tokio::net::TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        match self.connections.recv().await {
            Some(connection) => connection,
            // The accept loop never ends while the listener exists.
            None => std::future::pending().await,
        }
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Ok(self.address)
    }
}
