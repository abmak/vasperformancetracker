@echo off
rem Daily Let's Encrypt renewal for the VPS public IP certificate.
rem The renewal script itself decides whether the cert still has more than
rem 4 days of validity left and exits early when nothing is needed, so running
rem this every day is cheap and safe. Output lands in renew.log next to it.
cd /d "%~dp0"
node renew.js >> renew.log 2>&1
