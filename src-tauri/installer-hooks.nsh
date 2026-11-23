!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing existing Inex Island instances..."
  nsExec::Exec 'taskkill /F /IM inex-island.exe'
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Closing existing Inex Island instances..."
  nsExec::Exec 'taskkill /F /IM inex-island.exe'
!macroend
