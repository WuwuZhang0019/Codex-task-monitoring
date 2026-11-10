@echo off
rem Date 2026-11-10. C simulation preview from the built app.
cd /d "%~dp0..\..\..\app"
call npm exec vite preview -- --port 4321 --open /?view=light-simulation
