use axum::http::HeaderValue;
use forkcast_backend::router;
use forkcast_core::{Config, Core};

/// `forkcast-backend --health`: exit 0 when this host's server answers, for
/// container health checks.
fn health() -> ! {
    use std::io::{Read, Write};
    let bind = std::env::var("FORKCAST_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let port = bind.rsplit(':').next().unwrap_or("8787");
    let healthy = std::net::TcpStream::connect(format!("127.0.0.1:{port}"))
        .and_then(|mut stream| {
            stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
            stream.write_all(
                b"GET /api/status HTTP/1.0

",
            )?;
            let mut reply = String::new();
            stream.read_to_string(&mut reply)?;
            Ok(reply.starts_with("HTTP/1.0 200") || reply.starts_with("HTTP/1.1 200"))
        })
        .unwrap_or(false);
    std::process::exit(if healthy { 0 } else { 1 })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|argument| argument == "--health") {
        health();
    }
    let bind = std::env::var("FORKCAST_BIND").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let path = std::env::var("FORKCAST_DATABASE").unwrap_or_else(|_| "forkcast.sqlite3".into());
    let core = Core::open(Config::new(path))
        .map_err(|error| format!("Cannot open backend database: {error}"))?;
    let origins = std::env::var("FORKCAST_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://127.0.0.1:5173,http://127.0.0.1:4173".into())
        .split(',')
        .map(|origin| origin.trim().parse::<HeaderValue>())
        .collect::<Result<Vec<_>, _>>()?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    println!(
        "Forkcast backend listening on http://{}",
        listener.local_addr()?
    );
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
    axum::serve(listener, router(core, origins, frontend))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
