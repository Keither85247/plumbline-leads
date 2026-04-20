'use strict';
const path = require('path');

/**
 * Returns the directory where large app data (audio files, etc.) should be
 * stored alongside the SQLite database.
 *
 * Priority:
 *  1. DATA_DIR env var (explicit override)
 *  2. dirname(DB_PATH)  — same folder as the SQLite file on Render's persistent disk
 *  3. backend/          — project root for local dev
 */
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.DB_PATH)  return path.dirname(process.env.DB_PATH);
  return path.join(__dirname, '..');   // backend/
}

module.exports = { getDataDir };
