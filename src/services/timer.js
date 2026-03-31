/**
 * Timer service — manages per-session countdown in memory.
 * Every second it decrements seconds_remaining in the DB and
 * fires relay-off when the session expires.
 */

const db = require('../db/database');
const { logEvent } = require('./events');

// Map<sessionId, IntervalHandle>
const activeTimers = new Map();

/**
 * Start countdown for a session.
 * @param {string} sessionId
 * @param {function} onExpire  - called with (sessionId, deviceId) when timer hits 0
 */
function startTimer(sessionId, onExpire) {
  if (activeTimers.has(sessionId)) return; // already running

  const tick = setInterval(() => {
    const session = db.prepare(
      `SELECT id, device_id, seconds_remaining, status FROM sessions WHERE id = ?`
    ).get(sessionId);

    if (!session || session.status !== 'active') {
      clearInterval(tick);
      activeTimers.delete(sessionId);
      return;
    }

    const newSeconds = session.seconds_remaining - 1;

    if (newSeconds <= 0) {
      // Time's up
      db.prepare(
        `UPDATE sessions SET seconds_remaining = 0, status = 'completed', ended_at = unixepoch()
         WHERE id = ?`
      ).run(sessionId);

      clearInterval(tick);
      activeTimers.delete(sessionId);

      logEvent(session.device_id, sessionId, 'relay_off', null, null, 'Session timer expired');
      if (onExpire) onExpire(sessionId, session.device_id);
    } else {
      db.prepare(
        `UPDATE sessions SET seconds_remaining = ? WHERE id = ?`
      ).run(newSeconds, sessionId);
    }
  }, 1000);

  activeTimers.set(sessionId, tick);
}

/**
 * Stop a session early (emergency stop or admin).
 */
function stopTimer(sessionId, reason = 'manual_stop') {
  const tick = activeTimers.get(sessionId);
  if (tick) {
    clearInterval(tick);
    activeTimers.delete(sessionId);
  }

  const session = db.prepare(`SELECT device_id FROM sessions WHERE id = ?`).get(sessionId);
  if (session) {
    db.prepare(
      `UPDATE sessions SET status = 'stopped', ended_at = unixepoch() WHERE id = ? AND status = 'active'`
    ).run(sessionId);
    logEvent(session.device_id, sessionId, 'relay_off', null, null, reason);
  }
}

/**
 * Restore any active sessions after server restart.
 * @param {function} onExpire
 */
function restoreActiveTimers(onExpire) {
  const activeSessions = db.prepare(
    `SELECT id, device_id, seconds_remaining FROM sessions WHERE status = 'active'`
  ).all();

  for (const s of activeSessions) {
    if (s.seconds_remaining > 0) {
      startTimer(s.id, onExpire);
      console.log(`[timer] Restored session ${s.id} (${s.seconds_remaining}s remaining)`);
    } else {
      // Should not happen, but clean up stale sessions
      db.prepare(
        `UPDATE sessions SET status = 'completed', ended_at = unixepoch() WHERE id = ?`
      ).run(s.id);
    }
  }
}

function isTimerActive(sessionId) {
  return activeTimers.has(sessionId);
}

module.exports = { startTimer, stopTimer, restoreActiveTimers, isTimerActive };
