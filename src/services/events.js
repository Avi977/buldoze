const db = require('../db/database');

function logEvent(deviceId, sessionId, eventType, batteryPct, relayState, note) {
  db.prepare(`
    INSERT INTO device_events (device_id, session_id, event_type, battery_pct, relay_state, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, sessionId || null, eventType, batteryPct ?? null, relayState ?? null, note || null);
}

module.exports = { logEvent };
