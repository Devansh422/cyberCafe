const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/**
 * Run an executable WITHOUT flashing a console window on Windows.
 *
 * Node's child_process defaults to `windowsHide: false`, so calling
 * `Powershell.exe` (as pdf-to-printer does internally) pops a black console
 * window for a split second on every invocation. Routing every spawn through
 * this helper with `windowsHide: true` (which maps to CREATE_NO_WINDOW)
 * eliminates those flashes — this is the fix for "a PowerShell window opens
 * and closes when I click buttons".
 *
 * @param {string} file       executable to run
 * @param {string[]} args     argument list
 * @param {object} [options]  extra execFile options (merged over defaults)
 */
async function runHidden(file, args = [], options = {}) {
  return execFileAsync(file, args, {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

/**
 * Run a PowerShell command hidden. Always passes -NoProfile and
 * -NonInteractive so it can never block waiting on a prompt or a profile.
 */
async function runPowerShell(command, options = {}) {
  return runHidden(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],
    options,
  );
}

module.exports = { runHidden, runPowerShell, execFileAsync };
