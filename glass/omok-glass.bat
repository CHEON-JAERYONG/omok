@echo off
rem Omok glass window launcher - opens the omok game in a see-through window.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0omok-glass.ps1" %*
