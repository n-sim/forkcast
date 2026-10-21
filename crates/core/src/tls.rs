//! HTTPS to household servers with their own certificate. A server without a
//! publicly trusted certificate presents a self-signed one; the person
//! compares its SHA-256 fingerprint with the one the server shows and the
//! app then accepts exactly that certificate for that server. Names and
//! validity dates are not checked for a pinned certificate: the fingerprint
//! identifies it completely, and the handshake still proves the server holds
//! its private key.

use crate::error::{Error, ErrorKind, Result};
use rustls::{
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme,
    StreamOwned,
    client::{
        WebPkiServerVerifier,
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    },
    crypto::{CryptoProvider, WebPkiSupportedAlgorithms, ring},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    sync::{Arc, Mutex},
    time::Duration,
};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, Either, LazyBuffers, NextTimeout, Transport,
    TransportAdapter,
};

/// Reported by [`PinnedConnector`] when the server's certificate is not the
/// confirmed one.
pub(crate) const CERTIFICATE_CHANGED: &str = "the server certificate does not match the pin";

/// The SHA-256 fingerprint of a DER certificate, as `AB:CD:…` (the form
/// `openssl x509 -fingerprint -sha256` and browsers show).
pub fn fingerprint(certificate: &[u8]) -> String {
    Sha256::digest(certificate)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Accepts a fingerprint with or without separators, in either case.
pub(crate) fn parse_fingerprint(text: &str) -> Result<String> {
    let hex: String = text
        .chars()
        .filter(|c| !matches!(c, ':' | ' ' | '-'))
        .collect::<String>()
        .to_ascii_uppercase();
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::invalid(
            "A certificate fingerprint is 64 hexadecimal digits (SHA-256).",
        ));
    }
    Ok(hex
        .as_bytes()
        .chunks(2)
        .map(|pair| std::str::from_utf8(pair).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(":"))
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(ring::default_provider())
}

/// Accepts only the certificate with `fingerprint`.
#[derive(Debug)]
struct Pinned {
    fingerprint: String,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if fingerprint(end_entity) == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// A client configuration that trusts only the certificate with
/// `fingerprint`. The server uses it for its own health check.
pub fn pinned_client_config(fingerprint: &str) -> Arc<ClientConfig> {
    let provider = provider();
    let verifier = Pinned {
        fingerprint: fingerprint.to_owned(),
        algorithms: provider.signature_verification_algorithms,
    };
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Arc::new(config)
}

/// What an HTTPS server presented, and whether it is publicly trusted.
pub(crate) struct Presented {
    pub(crate) fingerprint: String,
    pub(crate) trusted: bool,
}

/// Records the certificate while checking it against the public roots.
#[derive(Debug)]
struct Recorder {
    public: Arc<WebPkiServerVerifier>,
    seen: Mutex<Option<(String, bool)>>,
}

impl ServerCertVerifier for Recorder {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let verdict = self.public.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        );
        *self.seen.lock().expect("recorder poisoned") =
            Some((fingerprint(end_entity), verdict.is_ok()));
        verdict
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.public.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.public.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.public.supported_verify_schemes()
    }
}

fn unavailable() -> Error {
    Error::new(
        ErrorKind::Unavailable,
        "Backend unavailable. Check the URL and network, then try again.",
    )
}

/// Opens a TLS connection to an `https://` server URL far enough to see its
/// certificate. Sends nothing.
pub(crate) fn probe(server_url: &str) -> Result<Presented> {
    let authority = server_url
        .strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
        .ok_or_else(Error::internal)?;
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !port.contains(']') => (
            host,
            port.parse::<u16>()
                .map_err(|_| Error::invalid("The backend URL has an invalid port."))?,
        ),
        _ => (authority, 443),
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let address = (host, port)
        .to_socket_addrs()
        .map_err(|_| unavailable())?
        .next()
        .ok_or_else(unavailable)?;
    let name = ServerName::try_from(host.to_owned())
        .map_err(|_| Error::invalid("The backend URL has an invalid host name."))?;

    let provider = provider();
    let public = WebPkiServerVerifier::builder_with_provider(
        Arc::new(rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        }),
        provider.clone(),
    )
    .build()
    .map_err(|_| Error::internal())?;
    let recorder = Arc::new(Recorder {
        public,
        seen: Mutex::new(None),
    });
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(recorder.clone())
        .with_no_client_auth();

    let timeout = Duration::from_secs(8);
    let mut socket = TcpStream::connect_timeout(&address, timeout).map_err(|_| unavailable())?;
    socket.set_read_timeout(Some(timeout)).ok();
    socket.set_write_timeout(Some(timeout)).ok();
    let mut connection =
        ClientConnection::new(Arc::new(config), name).map_err(|_| unavailable())?;
    // An untrusted certificate ends the handshake; the recorder has seen it.
    let _ = connection.complete_io(&mut socket);
    let seen = recorder.seen.lock().expect("recorder poisoned").take();
    seen.map(|(fingerprint, trusted)| Presented {
        fingerprint,
        trusted,
    })
    .ok_or_else(unavailable)
}

/// Wraps ureq's TCP connections in TLS that accepts only the pinned
/// certificate.
#[derive(Debug)]
pub(crate) struct PinnedConnector {
    config: Arc<ClientConfig>,
}

impl PinnedConnector {
    pub(crate) fn new(fingerprint: &str) -> Self {
        Self {
            config: pinned_client_config(fingerprint),
        }
    }
}

fn changed(error: &std::io::Error) -> bool {
    matches!(
        error
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<rustls::Error>()),
        Some(rustls::Error::InvalidCertificate(
            CertificateError::ApplicationVerificationFailure
        ))
    )
}

impl<In: Transport> Connector<In> for PinnedConnector {
    type Out = Either<In, PinnedTransport>;

    fn connect(
        &self,
        details: &ConnectionDetails,
        chained: Option<In>,
    ) -> std::result::Result<Option<Self::Out>, ureq::Error> {
        let Some(transport) = chained else {
            return Ok(None);
        };
        if !details.needs_tls() || transport.is_tls() {
            return Ok(Some(Either::A(transport)));
        }
        let host = details
            .uri
            .host()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']');
        let name = ServerName::try_from(host.to_owned())
            .map_err(|_| ureq::Error::Tls("invalid server name"))?;
        let mut connection = ClientConnection::new(self.config.clone(), name)?;
        let mut socket = TransportAdapter::new(transport.boxed());
        socket.set_timeout(details.timeout);
        connection.complete_io(&mut socket).map_err(|error| {
            if changed(&error) {
                ureq::Error::Tls(CERTIFICATE_CHANGED)
            } else {
                ureq::Error::Io(error)
            }
        })?;
        Ok(Some(Either::B(PinnedTransport {
            buffers: LazyBuffers::new(
                details.config.input_buffer_size(),
                details.config.output_buffer_size(),
            ),
            stream: StreamOwned::new(connection, socket),
        })))
    }
}

pub(crate) struct PinnedTransport {
    buffers: LazyBuffers,
    stream: StreamOwned<ClientConnection, TransportAdapter>,
}

impl std::fmt::Debug for PinnedTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PinnedTransport")
    }
}

impl Transport for PinnedTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(
        &mut self,
        amount: usize,
        timeout: NextTimeout,
    ) -> std::result::Result<(), ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let output = &self.buffers.output()[..amount];
        self.stream.write_all(output)?;
        Ok(())
    }

    fn await_input(&mut self, timeout: NextTimeout) -> std::result::Result<bool, ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let input = self.buffers.input_append_buf();
        let amount = self.stream.read(input)?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }

    fn is_open(&mut self) -> bool {
        self.stream.get_mut().get_mut().is_open()
    }

    fn is_tls(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_are_read_in_any_common_form() {
        let canonical = fingerprint(b"certificate");
        assert_eq!(canonical.len(), 95);
        assert_eq!(parse_fingerprint(&canonical).unwrap(), canonical);
        let bare = canonical.replace(':', "").to_lowercase();
        assert_eq!(parse_fingerprint(&bare).unwrap(), canonical);
        assert_eq!(
            parse_fingerprint(&canonical.replace(':', " ")).unwrap(),
            canonical
        );
        assert!(parse_fingerprint("AB:CD").is_err());
        assert!(parse_fingerprint(&"G".repeat(64)).is_err());
    }
}
