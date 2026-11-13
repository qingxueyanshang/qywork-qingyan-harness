; File names in sidecar\ carry a content hash and differ between releases.
; The installer only overwrites files with the same name, so the directory
; must be emptied before the files of this release are written.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\sidecar"
!macroend
