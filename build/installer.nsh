; Custom NSIS installer script for DSH Desktop (electron-builder `nsis.include`).
;
; Why this exists:
;   electron-builder's upgrade path (KeepShortcuts=true in the registry) RENAMES
;   the previous version's .lnk files instead of recreating them. A renamed .lnk
;   keeps its old cached icon, so after upgrading to a build with a different
;   icon the Start Menu / desktop shortcut can show a stale icon while the exe
;   itself shows the new one. Windows' icon cache can also serve stale icons.
;
; Fix: after every install (fresh or upgrade) unconditionally recreate both
; shortcuts with the freshly installed exe as the icon source, then notify the
; shell so Explorer re-extracts the icon.

!macro customInstall
  ; Respect the compile-time "no start menu shortcut" choice.
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ; $appExe / $newStartMenuLink are set by the stock installSection before
    ; customInstall runs.
    Delete "$newStartMenuLink"
    ClearErrors
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  !endif

  ; Respect the runtime "no desktop shortcut" checkbox choice.
  ${ifNot} ${isNoDesktopShortcut}
    Delete "$newDesktopLink"
    ClearErrors
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}

  ; Tell Explorer that icon content changed so it drops any cached icon for the
  ; exe and the recreated .lnk files (SHCNE_ASSOCCHANGED).
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
