/**
 * Device routes — used by ESP32 firmware
 *
 * GET  /device/poll       — ESP32 checks for relay commands every 5s
 * POST /device/heartbeat  — ESP32 reports battery %, relay state
 */

const { Router } = require('express');
const db = require('../db/database');
const { consumeCommand } = require('../services/relay');
const { logEvent } = require('../services/events');
const { stopTimer } = require('../services/timer');
const { queueRelayOff } = require('../services/relay');

const router = Router();

const LOW_BATTERY_THRESHOLD = parseFloat(process.env.LOW_BATTERY_THRESHOLD_PERCENT) || 15;
const DEVICE_TIMEOUT_SECONDS = parseInt(process.env.DEVICE_TIMEOUT_SECONDS) || 30;

// ---------------------------------------------------------------------------
// Device authentication — checks ?key= query param against stored secret_key
// ---------------------------------------------------------------------------
function authenticateDevice(req, res, next) {
  const { device_id, key } = req.query;

  if (!device_id || !key) {
    return res.status(400).json({ error: 'device_id and key query params are required' });
  }

  const device = db.prepare(`SELECT id, secret_key FROM devices WHERE id = ?`).get(device_id);
  if (!device || device.secret_key !== key) {
    return res.status(401).json({ error: 'Invalid device credentials' });
  }

  req.deviceId = device_id;
  next();
}

// ---------------------------------------------------------------------------
// GET /device/poll?device_id=dozer_01&key=<secret>
//
// Returns pending relay command (consumed once) and seconds remaining on
// the active session. ESP32 polls this every 5 seconds.
//
// Response:
// {
//   command: "ON" | "OFF" | "NONE",
//   seconds_remaining: 300,
//   session_id: "uuid" | null
// }
// ---------------------------------------------------------------------------
router.get('/poll', authenticateDevice, (req, res) => {
  const deviceId = req.deviceId;

  // Mark device online + update last_seen
  db.prepare(
    `UPDATE devices SET is_online = 1, last_seen = unixepoch() WHERE id = ?`
  ).run(deviceId);

  // Get pending relay command (clears it after read)
  const pending = consumeCommand(deviceId);

  // Get active session for seconds_remaining
  const activeSession = db.prepare(
    `SELECT id, seconds_remaining FROM sessions WHERE device_id = ? AND status = 'active'`
  ).get(deviceId);

  return res.json({
    command: pending ? pending.command : 'NONE',
    session_id: pending?.sessionId ?? activeSession?.id ?? null,
    seconds_remaining: activeSession?.seconds_remaining ?? 0,
  });
});

// ---------------------------------------------------------------------------
// POST /device/heartbeat?device_id=dozer_01&key=<secret>
//
// ESP32 sends this after every poll with its current state.
// Body: { battery_pct: 78.5, relay_state: 1 }
// ---------------------------------------------------------------------------
router.post('/heartbeat', authenticateDevice, (req, res) => {
  const deviceId = req.deviceId;
  const { battery_pct, relay_state } = req.body;

  const batteryPct = battery_pct != null ? parseFloat(battery_pct) : null;
  const relayState = relay_state != null ? parseInt(relay_state) : null;

  // Update device record
  db.prepare(`
    UPDATE devices
    SET is_online = 1, last_seen = unixepoch(), battery_pct = ?, relay_state = ?
    WHERE id = ?
  `).run(batteryPct, relayState, deviceId);

  // Log heartbeat (sampled — only log if battery changed by >2% to avoid noise)
  const device = db.prepare(`SELECT battery_pct FROM devices WHERE id = ?`).get(deviceId);
  const prevBattery = device?.battery_pct ?? batteryPct;
  if (batteryPct == null || Math.abs(batteryPct - prevBattery) >= 2) {
    logEvent(deviceId, null, 'heartbeat', batteryPct, relayState, null);
  }

  // Low battery check — stop active session if threshold breached
  if (batteryPct != null && batteryPct < LOW_BATTERY_THRESHOLD) {
    const activeSession = db.prepare(
      `SELECT id FROM sessions WHERE device_id = ? AND status = 'active'`
    ).get(deviceId);

    if (activeSession) {
      stopTimer(activeSession.id, 'low_battery');
      queueRelayOff(deviceId, activeSession.id);
      db.prepare(
        `UPDATE sessions SET status = 'low_battery', ended_at = unixepoch() WHERE id = ?`
      ).run(activeSession.id);
      logEvent(deviceId, activeSession.id, 'low_battery', batteryPct, relayState,
        `Battery at ${batteryPct.toFixed(1)}% — session stopped`);
      console.log(`[device] Low battery on ${deviceId} (${batteryPct.toFixed(1)}%) — session stopped`);
    }
  }

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /device/estop?device_id=dozer_01&key=<secret>
//
// Called by ESP32 when the physical emergency stop button is pressed.
// ---------------------------------------------------------------------------
router.post('/estop', authenticateDevice, (req, res) => {
  const deviceId = req.deviceId;

  const activeSession = db.prepare(
    `SELECT id FROM sessions WHERE device_id = ? AND status = 'active'`
  ).get(deviceId);

  if (activeSession) {
    stopTimer(activeSession.id, 'emergency_stop');
    queueRelayOff(deviceId, activeSession.id);
    db.prepare(
      `UPDATE sessions SET status = 'stopped', ended_at = unixepoch() WHERE id = ?`
    ).run(activeSession.id);
    logEvent(deviceId, activeSession.id, 'estop', null, 0, 'Physical emergency stop pressed');
    console.log(`[device] ESTOP on ${deviceId} — session ${activeSession.id} stopped`);
  }

  db.prepare(`UPDATE devices SET relay_state = 0 WHERE id = ?`).run(deviceId);

  return res.json({ ok: true, session_stopped: !!activeSession });
});

// ---------------------------------------------------------------------------
// Background job — mark devices offline if no heartbeat within timeout
// Runs every 15 seconds.
// ---------------------------------------------------------------------------
setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - DEVICE_TIMEOUT_SECONDS;
  const result = db.prepare(
    `UPDATE devices SET is_online = 0 WHERE is_online = 1 AND (last_seen IS NULL OR last_seen < ?)`
  ).run(cutoff);
  if (result.changes > 0) {
    console.log(`[device] Marked ${result.changes} device(s) offline`);
  }
}, 15000);

module.exports = router;
