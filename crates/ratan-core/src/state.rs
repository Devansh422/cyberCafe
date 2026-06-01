//! Shared application state handed to every axum handler.

use std::sync::Arc;

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
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new(config: Config) -> anyhow::Result<SharedState> {
        config.ensure_folders()?;
        let db = Db::open(&config.db_path)?;
        let whatsapp = WhatsApp::new(&config);
        let print = PrintService::new();
        let passport = Passport::new();
        Ok(Arc::new(AppState { config, db, print, whatsapp, passport }))
    }
}
