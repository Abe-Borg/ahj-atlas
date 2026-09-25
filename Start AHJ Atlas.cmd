@echo off
cd /d "%~dp0"
node launcher.mjs
if errorlevel 1 pause
