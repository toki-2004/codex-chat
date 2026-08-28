@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Codex Chat Server
echo Starting Codex Chat ...
node server.js
pause
