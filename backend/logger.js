/**
 * Lightweight structured logger for Render logs.
 *
 * Output format:
 *   2026-04-12T18:00:00.000Z INFO  [Twilio] Incoming call from +15165551234 {"callSid":"CA..."}
 *
 * Usage:
 *   const log = require('../logger').for('Twilio');
 *   log.info('Incoming call', { from: '+1...' });
 *   log.error('DB write failed', { err: err.message });
 */

const LEVEL = { INFO: 'INFO ', WARN: 'WARN ', ERROR: 'ERROR' };

function write(level, module, message, ctx) {
  const ts  = new Date().toISOString();
  const pad = LEVEL[level] || level;
  const ctxStr = ctx && Object.keys(ctx).length > 0
    ? ' ' + JSON.stringify(ctx)
    : '';
  const line = `${ts} ${pad} [${module}] ${message}${ctxStr}`;

  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN')  console.warn(line);
  else                        console.log(line);
}

/**
 * Returns a logger scoped to a module name.
 * @param {string} module  e.g. 'Twilio', 'Messages', 'Leads'
 */
function forModule(module) {
  return {
    info:  (msg, ctx) => write('INFO',  module, msg, ctx),
    warn:  (msg, ctx) => write('WARN',  module, msg, ctx),
    error: (msg, ctx) => write('ERROR', module, msg, ctx),
  };
}

module.exports = { for: forModule };
