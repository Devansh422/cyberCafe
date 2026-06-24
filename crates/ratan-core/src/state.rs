//! Shared application state handed to every axum handler.

use std::sync::Arc;

use crate::components::{self, ComponentsState};
use crate::config::Config;
use crate::db::Db;
use crate::passport::Passport;
use crate::print::PrintService;
use crate::whatsapp::WhatsApp;

pub struct AppState {
    pub config: Config,
    pub db: Db,
    pub print: PrintService,
    pub whatsapp: WhatsApp,
    pub passport: Passport,
    /// Download/verify progress for the externalized runtime components.
    pub components: ComponentsState,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new(config: Config) -> anyhow::Result<SharedState> {
        config.ensure_folders()?;
        let db = Db::open(&config.db_path)?;
        let whatsapp = WhatsApp::new(&config);
        let print = PrintService::new();
        let passport = Passport::new();
        // Packaged app: start as "downloading" so the setup screen shows immediately
        // if the UI manages to poll before spawn_bootstrap resets the state.
        // spawn_bootstrap overwrites this with reset(&needs_work) within a few ms
        // (before any .await), so the 229 MB total here is never visible in practice.
        // Dev: nothing to fetch → ready immediately.
        let components = if config.components_dir.is_some() {
            ComponentsState::pending(&components::manifest())
        } else {
            ComponentsState::ready_now()
        };
        Ok(Arc::new(AppState { config, db, print, whatsapp, passport, components }))
    }
}
