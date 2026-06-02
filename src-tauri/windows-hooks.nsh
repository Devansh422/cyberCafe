; Ratan NSIS installer hooks.
;
; Ratan launches a child whatsapp-sidecar.exe (which itself spawns Chromium),
; and a supervisor inside Ratan restarts the sidecar if it dies. During an
; update the installer must overwrite whatsapp-sidecar.exe — but if it is still
; running, or the supervisor respawns it the instant we kill it, the image stays
; locked and NSIS fails with "Error opening file for writing …
; whatsapp-sidecar.exe". The old hook killed only the sidecar (which the live app
; immediately restarted), so the lock came right back.
;
; Make the overwrite bulletproof, in order:
;   1. Kill Ratan FIRST — WITHOUT /T, so we never accidentally kill this
;      installer if it happens to be a child — so the supervisor can no longer
;      respawn the sidecar.
;   2. Kill the sidecar and the whole Chromium process tree it owns (/T).
;   3. Give Windows a moment to release the file lock.
;   4. If the exe is still there, delete it; if it is still locked, rename it
;      aside (renaming a running exe IS allowed on Windows) so a fresh copy can
;      always be written, and remove the leftover on the next reboot.
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing Ratan and the WhatsApp sidecar before install..."
  nsExec::Exec 'taskkill /F /IM ratan-app.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM whatsapp-sidecar.exe'
  Pop $0
  Sleep 1200

  IfFileExists "$INSTDIR\whatsapp-sidecar.exe" 0 ratan_sidecar_ready
    Delete "$INSTDIR\whatsapp-sidecar.exe"
    IfFileExists "$INSTDIR\whatsapp-sidecar.exe" 0 ratan_sidecar_ready
      ; Still locked: move the running exe out of the way so extraction can write
      ; a fresh one, then clear the leftover on reboot.
      Delete "$INSTDIR\whatsapp-sidecar.exe.old"
      Rename "$INSTDIR\whatsapp-sidecar.exe" "$INSTDIR\whatsapp-sidecar.exe.old"
      Delete /REBOOTOK "$INSTDIR\whatsapp-sidecar.exe.old"
  ratan_sidecar_ready:
!macroend
