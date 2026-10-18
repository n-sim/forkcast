//! The documented loopback listener for the sign-in callback. It binds before
//! the system browser is opened, accepts only requests addressed to its own
//! loopback authority, and stops when the attempt completes, is replaced, or
//! times out.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use url::Url;

/// The port Forkcast prefers; another free port is used when it is taken.
const PREFERRED_PORT: u16 = 8788;

pub(crate) struct Callback {
    pub params: HashMap<String, String>,
}

pub(crate) struct Listener {
    listener: TcpListener,
    authority: String,
}

impl Listener {
    pub(crate) fn bind() -> std::io::Result<Self> {
        let listener =
            TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, PREFERRED_PORT)))
                .or_else(|_| TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))))?;
        listener.set_nonblocking(true)?;
        let authority = listener.local_addr()?.to_string();
        Ok(Self {
            listener,
            authority,
        })
    }

    pub(crate) fn redirect(&self) -> String {
        format!("http://{}/auth/callback", self.authority)
    }

    /// Serves until `handle` accepts a callback (returning the page to show),
    /// the deadline passes, or `cancel` is set. Unrelated requests get a plain
    /// refusal and never consume the attempt.
    pub(crate) fn serve(
        self,
        cancel: &Arc<AtomicBool>,
        deadline: Instant,
        mut handle: impl FnMut(Callback) -> Option<(u16, &'static str)>,
    ) {
        while !cancel.load(Ordering::SeqCst) && Instant::now() < deadline {
            let Ok((mut stream, _)) = self.listener.accept() else {
                std::thread::sleep(Duration::from_millis(25));
                continue;
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            let Some(callback) = self.read(&mut stream) else {
                respond(&mut stream, 403, "Not available.");
                continue;
            };
            match handle(callback) {
                Some((status, page)) => {
                    respond(&mut stream, status, page);
                    return;
                }
                None => respond(&mut stream, 400, "Not available."),
            }
        }
    }

    fn read(&self, stream: &mut TcpStream) -> Option<Callback> {
        let mut reader = BufReader::new(stream.try_clone().ok()?.take(16 * 1024));
        let mut request_line = String::new();
        reader.read_line(&mut request_line).ok()?;
        let mut host = None;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).ok()?;
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':')
                && name.eq_ignore_ascii_case("host")
            {
                host = Some(value.trim().to_owned());
            }
        }
        // Rebinding protection: only this listener's own authority is served.
        if host.as_deref() != Some(&self.authority) {
            return None;
        }
        let mut parts = request_line.split_whitespace();
        let (method, target) = (parts.next()?, parts.next()?);
        if method != "GET" {
            return None;
        }
        let url = Url::parse(&format!("http://{}{target}", self.authority)).ok()?;
        if url.path() != "/auth/callback" {
            return None;
        }
        Some(Callback {
            params: url
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect(),
        })
    }
}

fn respond(stream: &mut TcpStream, status: u16, page: &str) {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.flush();
}
