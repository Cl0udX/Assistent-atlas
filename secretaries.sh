#!/usr/bin/env bash
# Boton de encendido/apagado para TODAS las secretarias del proyecto
# assistent-atlas (WhatsApp y las que se agreguen despues).
# Escribe directo en la base de datos de Atlas: no depende de que el LLM
# interprete nada, es un interruptor real e inmediato.
set -euo pipefail

DB="/home/santo/Atlas/atlas.db"
PY="/home/santo/Atlas/.venv/bin/python"
ACTION="${1:-status}"

case "$ACTION" in
  on)
    "$PY" -c "
import sqlite3
c = sqlite3.connect('$DB')
c.execute(\"CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)\")
c.execute(\"INSERT INTO settings (key, value) VALUES ('secretaries_enabled', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value\")
c.commit()
"
    echo "Secretarias ENCENDIDAS."
    ;;
  off)
    "$PY" -c "
import sqlite3
c = sqlite3.connect('$DB')
c.execute(\"CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)\")
c.execute(\"INSERT INTO settings (key, value) VALUES ('secretaries_enabled', '0') ON CONFLICT(key) DO UPDATE SET value=excluded.value\")
c.commit()
"
    echo "Secretarias APAGADAS: se sigue registrando quien escribe/llama y te avisa por Telegram, pero no se le responde a nadie."
    ;;
  status)
    "$PY" -c "
import sqlite3
c = sqlite3.connect('$DB')
c.execute(\"CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)\")
row = c.execute(\"SELECT value FROM settings WHERE key='secretaries_enabled'\").fetchone()
enabled = (row is None) or (row[0] == '1')
print('encendidas' if enabled else 'apagadas')
"
    ;;
  *)
    echo "uso: $0 [on|off|status]"
    exit 1
    ;;
esac
