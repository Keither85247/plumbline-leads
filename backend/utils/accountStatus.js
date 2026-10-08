'use strict';
/**
 * Account status — the ONE definition of a disabled account.
 *
 * Supported users.access_status values (db.js; no CHECK constraint):
 *   'unknown' (default) | 'tester' | 'trial' | 'active' | 'blocked'
 * ('owner' is never stored; it is derived for is_owner rows.)
 * users.is_suspended is 0/1 and is set by PATCH /api/admin/users/:id/suspend.
 *
 * An account is DISABLED when it is suspended (is_suspended = 1) or, for a
 * non-owner, when access_status is 'blocked'. Owners cannot be suspended
 * through the admin API and are never paywall-blocked; a suspended owner row
 * (only possible by editing the database) is still disabled. 'unknown' and
 * 'trial' are paywall states handled by the frontend, not disabled states.
 *
 * Disabled accounts cannot sign in, their sessions stop on the next request,
 * and inbound telephony, push, Gmail sync, paid AI and outbound calls/messages
 * all skip them (see each caller).
 */

const db = require('../db');

/** SQL predicate (for a users row aliased `alias`) that is TRUE for a disabled account. */
function disabledSql(alias = 'u') {
  return `(COALESCE(${alias}.is_suspended, 0) <> 0
    OR (COALESCE(${alias}.is_owner, 0) = 0 AND LOWER(TRIM(COALESCE(${alias}.access_status, ''))) = 'blocked'))`;
}

/** @param {{is_owner?, is_suspended?, access_status?}|null|undefined} u */
function isDisabledRow(u) {
  if (!u) return true;
  if (Number(u.is_suspended || 0) !== 0) return true;
  return Number(u.is_owner || 0) === 0
    && String(u.access_status || '').trim().toLowerCase() === 'blocked';
}

const statusStmt = db.prepare('SELECT id, is_owner, is_suspended, access_status FROM users WHERE id = ?');

/** True only for an existing, enabled account. Missing / invalid ids are not active. */
function isAccountActive(userId) {
  if (!Number.isInteger(userId) || userId <= 0) return false;
  return !isDisabledRow(statusStmt.get(userId));
}

/** Generic message for sign-in refusals and ended sessions (suspended or blocked alike). */
const ACCOUNT_DISABLED_ERROR = Object.freeze({
  error: 'This account is not active. Contact your administrator.',
  code:  'ACCOUNT_DISABLED',
});

module.exports = { disabledSql, isDisabledRow, isAccountActive, ACCOUNT_DISABLED_ERROR };
