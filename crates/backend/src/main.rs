use axum::http::HeaderValue;
use forkcast_backend::router;
use forkcast_core::{Config, Core};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
    axum::serve(listener, router(core, origins))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
