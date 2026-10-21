#![allow(dead_code)]
//! Real installed cores and a real household server, over real HTTP and
//! SQLite, for the synchronization journeys.

pub mod provider;

use forkcast_backend::router;
use forkcast_core::{Config, Core, JoinSelection, MemorySecrets, Operation, Principal, SyncStatus};
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    thread::JoinHandle,
};

pub fn temp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("forkcast-{name}-{}.sqlite3", uuid::Uuid::new_v4()))
}

pub fn remove(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut path = path.to_path_buf().into_os_string();
        path.push(suffix);
        let _ = std::fs::remove_file(path);
    }
}

/// The household server, restartable on the same address and database.
pub struct Server {
    pub url: String,
    /// The fingerprint of the server's self-signed certificate, when it
    /// serves HTTPS itself.
    pub certificate: Option<String>,
    tls: bool,
    secrets: Arc<MemorySecrets>,
    issuer: Option<String>,
    database: PathBuf,
    address: SocketAddr,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    pub fn start() -> Self {
        let database = temp("server");
        Self::start_on(
            database,
            "127.0.0.1:0".parse().unwrap(),
            None,
            Default::default(),
            false,
        )
    }

    /// A server that serves HTTPS itself with a self-signed certificate.
    pub fn with_own_certificate() -> Self {
        Self::start_on(
            temp("server"),
            "127.0.0.1:0".parse().unwrap(),
            None,
            Default::default(),
            true,
        )
    }

    /// The server's certificate files.
    pub fn certificate_files(&self) -> forkcast_backend::tls::CertificateFiles {
        forkcast_backend::tls::CertificateFiles::beside(&self.database)
    }

    /// A server whose ChatGPT sign-in talks to a fixture provider.
    pub fn with_provider(issuer: &str) -> Self {
        Self::start_on(
            temp("server"),
            "127.0.0.1:0".parse().unwrap(),
            Some(issuer.to_owned()),
            Default::default(),
            false,
        )
    }

    /// A brand-new household server answering at `address`.
    pub fn fresh_at(address: SocketAddr) -> Self {
        Self::start_on(temp("server"), address, None, Default::default(), false)
    }

    /// The database file's bytes, for leak checks.
    pub fn stored(&self) -> String {
        String::from_utf8_lossy(&std::fs::read(&self.database).unwrap()).to_string()
    }

    /// What the server's protected storage holds, for leak checks.
    pub fn secret(&self, key: &str) -> Option<String> {
        use forkcast_core::Secrets;
        self.secrets.get(key).unwrap()
    }

    fn start_on(
        database: PathBuf,
        address: SocketAddr,
        issuer: Option<String>,
        secrets: Arc<MemorySecrets>,
        tls: bool,
    ) -> Self {
        let identity = tls.then(|| {
            forkcast_backend::tls::Identity::load_or_create(
                &forkcast_backend::tls::CertificateFiles::beside(&database),
            )
            .unwrap()
        });
        let certificate = identity.as_ref().map(|identity| identity.fingerprint());
        let (ready, receive) = std::sync::mpsc::channel();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let db = database.clone();
        let (store, ai) = (secrets.clone(), issuer.clone());
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let mut config = Config::new(&db);
                config.secrets = store;
                if let Some(issuer) = ai {
                    config.ai = forkcast_core::AiConfig::fixture(&issuer).unwrap();
                }
                let core = Core::open(config).unwrap();
                let listener = tokio::net::TcpListener::bind(address).await.unwrap();
                ready.send(listener.local_addr().unwrap()).unwrap();
                let app = router(core, vec![], None);
                let shutdown = async {
                    let _ = stopped.await;
                };
                match identity {
                    Some(identity) => {
                        let listener = forkcast_backend::tls::TlsListener::new(
                            listener,
                            identity.acceptor().unwrap(),
                        )
                        .unwrap();
                        axum::serve(listener, app)
                            .with_graceful_shutdown(shutdown)
                            .await
                            .unwrap()
                    }
                    None => axum::serve(listener, app)
                        .with_graceful_shutdown(shutdown)
                        .await
                        .unwrap(),
                }
            });
        });
        let address = receive.recv().unwrap();
        Self {
            url: format!("{}://{address}", if tls { "https" } else { "http" }),
            certificate,
            tls,
            secrets,
            issuer,
            database,
            address,
            stop: Some(stop),
            thread: Some(thread),
        }
    }

    /// Takes the server away, as an outage or a restart would.
    pub fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }

    pub fn restart(&mut self) {
        self.stop();
        Self::wait_for(self.address);
        let restarted = Self::start_on(
            self.database.clone(),
            self.address,
            self.issuer.clone(),
            self.secrets.clone(),
            self.tls,
        );
        let mut old = std::mem::replace(self, restarted);
        // The database now belongs to the restarted server.
        old.database = PathBuf::new();
    }

    pub fn wait_for(address: SocketAddr) {
        for attempt in 0..50 {
            match std::net::TcpListener::bind(address) {
                Ok(listener) => {
                    drop(listener);
                    break;
                }
                Err(_) if attempt < 49 => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(error) => panic!("address stayed busy: {error}"),
            }
        }
    }

    pub fn address(&self) -> SocketAddr {
        self.address
    }
}

/// A server of another release: it answers only `/api/status`, declaring a
/// different synchronization protocol.
pub struct OtherRelease {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl OtherRelease {
    pub fn at(address: SocketAddr, protocol: u32) -> Self {
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let (ready, wait) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let app = axum::Router::new().route(
                    "/api/status",
                    axum::routing::get(move || async move {
                        axum::Json(json!({"setupRequired": false, "protocol": protocol}))
                    }),
                );
                let listener = tokio::net::TcpListener::bind(address).await.unwrap();
                ready.send(()).unwrap();
                axum::serve(listener, app)
                    .with_graceful_shutdown(async {
                        let _ = stopped.await;
                    })
                    .await
                    .unwrap();
            });
        });
        wait.recv().unwrap();
        Self {
            stop: Some(stop),
            thread: Some(thread),
        }
    }
}

impl Drop for OtherRelease {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
        if !self.database.as_os_str().is_empty() {
            let files = self.certificate_files();
            let _ = std::fs::remove_file(files.certificate);
            let _ = std::fs::remove_file(files.key);
        }
        remove(&self.database);
    }
}

/// One installed app: a core over its own database with protected-storage
/// stand-in that survives reopening, like a real credential store.
pub struct Device {
    pub core: Core,
    database: PathBuf,
    secrets: Arc<MemorySecrets>,
    issuer: Option<String>,
}

impl Device {
    pub fn new() -> Self {
        Self::build(None)
    }

    /// An installed app whose ChatGPT sign-in talks to a fixture provider.
    pub fn with_provider(issuer: &str) -> Self {
        Self::build(Some(issuer.to_owned()))
    }

    fn build(issuer: Option<String>) -> Self {
        let database = temp("device");
        let secrets = Arc::new(MemorySecrets::default());
        let core = Self::open(&database, &secrets, issuer.as_deref());
        Self {
            core,
            database,
            secrets,
            issuer,
        }
    }

    fn open(database: &PathBuf, secrets: &Arc<MemorySecrets>, issuer: Option<&str>) -> Core {
        let mut config = Config::new(database);
        config.secrets = secrets.clone();
        if let Some(issuer) = issuer {
            config.ai = forkcast_core::AiConfig::fixture(issuer).unwrap();
        }
        Core::open(config).unwrap()
    }

    /// Closes and reopens the app, as a restart does.
    pub fn restart(&mut self) {
        self.core = Self::open(&self.database, &self.secrets, self.issuer.as_deref());
    }

    /// What this app's protected storage holds, for leak checks.
    pub fn secret(&self, key: &str) -> Option<String> {
        use forkcast_core::Secrets;
        self.secrets.get(key).unwrap()
    }

    /// Every protected value and the database file's bytes, as one string.
    pub fn everything_stored(&self) -> String {
        let mut all = String::from_utf8_lossy(&std::fs::read(&self.database).unwrap()).to_string();
        let mut wal = self.database.clone().into_os_string();
        wal.push("-wal");
        if let Ok(bytes) = std::fs::read(wal) {
            all.push_str(&String::from_utf8_lossy(&bytes));
        }
        all
    }

    pub fn me(&self) -> Principal {
        self.core.current_principal().unwrap()
    }

    pub fn op(&self, operation: Value) -> Value {
        self.try_op(operation).unwrap()
    }

    pub fn try_op(&self, operation: Value) -> forkcast_core::Result<Value> {
        let operation: Operation = serde_json::from_value(operation).unwrap();
        self.core.execute(&self.me(), operation)
    }

    pub fn status(&self) -> SyncStatus {
        self.core.sync_status().unwrap()
    }

    pub fn sync(&self) -> SyncStatus {
        self.core.sync_now().unwrap()
    }

    /// Sets up the server's first household and joins it, contributing
    /// everything on this device.
    pub fn found_household(&self, server: &Server) -> SyncStatus {
        self.core
            .connect_server(&server.url, server.certificate.as_deref())
            .unwrap();
        self.core
            .authenticate_server(true, "admin", "correct horse battery", Some("Home"))
            .unwrap();
        self.join_with(everything(&self.core))
    }

    pub fn join_as(&self, server: &Server, username: &str, password: &str) -> SyncStatus {
        self.core
            .connect_server(&server.url, server.certificate.as_deref())
            .unwrap();
        self.core
            .authenticate_server(false, username, password, None)
            .unwrap();
        self.join_with(JoinSelection {
            recipe_ids: vec![],
            cooking_ids: vec![],
            use_device_shopping_list: false,
            adopt_personal: false,
        })
    }

    pub fn join_with(&self, selection: JoinSelection) -> SyncStatus {
        self.core.complete_join(selection).unwrap();
        self.sync()
    }

    pub fn recipe_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .core
            .recipes(&self.me())
            .unwrap()
            .iter()
            .map(|view| view.recipe["name"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        remove(&self.database);
    }
}

pub fn everything(core: &Core) -> JoinSelection {
    let principal = core.current_principal().unwrap();
    JoinSelection {
        recipe_ids: core
            .recipes(&principal)
            .unwrap()
            .iter()
            .map(|view| view.recipe["id"].as_str().unwrap().to_owned())
            .collect(),
        cooking_ids: core
            .meal_plan(&principal)
            .unwrap()
            .cookings
            .iter()
            .map(|cooking| {
                serde_json::to_value(cooking).unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect(),
        use_device_shopping_list: true,
        adopt_personal: true,
    }
}

pub fn recipe(id: &str, name: &str) -> Value {
    let mut recipe: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/pumpkin-risotto.json"
    ))
    .unwrap();
    for step in recipe["steps"].as_array_mut().unwrap() {
        step["allocations"]
            .as_array_mut()
            .unwrap()
            .retain(|allocation| allocation["quantity"].as_f64().unwrap() > 0.0);
    }
    recipe["id"] = json!(id);
    recipe["name"] = json!(name);
    recipe["nutrition"] =
        json!({"calories": 2000.0, "protein": 60.0, "fat": 80.0, "carbohydrates": 280.0});
    recipe
}

pub fn save_recipe(device: &Device, id: &str, name: &str) -> Value {
    device.op(json!({"operation": "saveRecipe", "recipe": recipe(id, name)}))
}

pub fn plan(device: &Device, id: &str, recipe_id: &str, date: &str, portions: f64) {
    device.op(json!({"operation": "planCooking", "cooking": {
        "id": id, "recipeId": recipe_id, "cookingDate": date, "portions": portions, "cookingTime": null
    }}));
}
