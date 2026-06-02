; Ratan NSIS installer hooks.
;
; Tauri's installer closes the running Ratan.exe for us, but it knows nothing
; about the WhatsApp sidecar that Ratan spawns. A running whatsapp-sidecar.exe
; keeps its own file locked, so installing/updating over a running copy fails
; with: "Error opening file for writing … whatsapp-sidecar.exe".
;
; Before copying any files, force-kill the sidecar AND the Chromium it spawned
; (/T = whole process tree) so the locked exe can be overwritten. /F forces it,
; and we ignore the result (it's fine if nothing is running).
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Stopping WhatsApp sidecar before install..."
  nsExec::Exec 'taskkill /F /T /IM whatsapp-sidecar.exe'
  Pop $0
  Sleep 600
!macroend
