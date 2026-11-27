; File names in sidecar\ carry a content hash and differ between releases.
; The installer only overwrites files with the same name, so the directory
; must be emptied before the files of this release are written.
!macro NSIS_HOOK_PREINSTALL
  RMDir /r "$INSTDIR\sidecar"
!macroend

; An existing shortcut keeps the letter case of its file name: the installer
; does not create shortcuts in update mode, and creating one over an existing
; file does not change its case. Renaming a file to its own name applies the
; case of PRODUCTNAME. A missing shortcut only sets the error flag.
!macro NSIS_HOOK_POSTINSTALL
  Rename "$DESKTOP\${PRODUCTNAME}.lnk" "$DESKTOP\${PRODUCTNAME}.lnk"
  Rename "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$SMPROGRAMS\${PRODUCTNAME}.lnk"
!macroend
