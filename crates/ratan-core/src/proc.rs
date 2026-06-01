//! Spawn child processes WITHOUT flashing a console window — the Rust port of
//! `backend/src/lib/win-exec.js`. On Windows we set the `CREATE_NO_WINDOW`
//! (0x08000000) creation flag, which is what eliminated the "PowerShell window
//! pops and closes when I click buttons" problem.

use std::process::Output;

use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Build a `Command` that won't spawn a visible console window.
pub fn hidden_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run an executable hidden and capture its output.
pub async fn run_hidden(program: &str, args: &[&str]) -> std::io::Result<Output> {
    hidden_command(program).args(args).output().await
}

/// Run a PowerShell command hidden, always `-NoProfile -NonInteractive`.
pub async fn run_powershell(command: &str) -> std::io::Result<Output> {
    run_hidden(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command],
    )
    .await
}
