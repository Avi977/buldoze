/**
 * Admin routes — protected by X-Admin-Key header
 *
 * GET  /admin/devices                    — list all devices with live status
 * POST /admin/devices                    — register a new device
 * POST /admin/devices/:id/start-session  — manually start a session (offline payments)
 * GET  /admin/sessions                   — list sessions (filterable)
 * GET  /admin/sessions/:id               — session detail + event log
 * POST /admin/sessions/:id/stop          — emergency stop a session
 */

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { stopTimer, startTimer } = require('../services/timer');
const { queueRelayOff, queueRelayOn } = require('../services/relay');
const { logEvent } = require('../services/events');

const PRICE_PER_MINUTE_AUD = parseFloat(process.env.PRICE_PER_MINUTE_AUD) || 0.20;
const LOW_BATTERY_THRESHOLD = parseFloat(process.env.LOW_BATTERY_THRESHOLD_PERCENT) || 15;

const router = Router();

// ---------------------------------------------------------------------------
// Admin auth middleware
// ---------------------------------------------------------------------------
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAdmin);

// ---------------------------------------------------------------------------
// GET /admin/devices
// Returns all devices with online status, battery, relay state, active session.
// ---------------------------------------------------------------------------
// Deterministic dummy battery so cards never show "—" during development.
// Returns a stable 45–94% value derived from the device id.
function dummyBattery(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return 45 + (h % 50);
}

router.get('/devices', (req, res) => {
  const rows = db.prepare(`
    SELECT
      d.id, d.name, d.location, d.is_online, d.battery_pct,
      d.relay_state, d.last_seen,
      s.id         AS active_session_id,
      s.customer_name,
      s.seconds_remaining,
      s.minutes_purchased
    FROM devices d
    LEFT JOIN sessions s ON s.device_id = d.id AND s.status = 'active'
    ORDER BY d.id
  `).all();

  const devices = rows.map(d => ({
    ...d,
    battery_pct: d.battery_pct ?? dummyBattery(d.id),
  }));

  return res.json({ devices });
});

// ---------------------------------------------------------------------------
// POST /admin/devices
// Register a new ESP32 device.
// Body: { id, name, location?, secret_key }
// ---------------------------------------------------------------------------
router.post('/devices', (req, res) => {
  const { id, name, location, secret_key } = req.body;

  if (!id || !name || !secret_key) {
    return res.status(400).json({ error: 'id, name, and secret_key are required' });
  }

  const existing = db.prepare(`SELECT id FROM devices WHERE id = ?`).get(id);
  if (existing) {
    return res.status(409).json({ error: `Device '${id}' already registered` });
  }

  db.prepare(
    `INSERT INTO devices (id, name, location, secret_key) VALUES (?, ?, ?, ?)`
  ).run(id, name, location || null, secret_key);

  console.log(`[admin] Registered device: ${id} (${name})`);
  return res.status(201).json({ id, name, location: location || null });
});

// ---------------------------------------------------------------------------
// DELETE /admin/devices/:id
// Remove a device (only if it has no sessions).
// ---------------------------------------------------------------------------
router.delete('/devices/:id', (req, res) => {
  const { id } = req.params;
  const sessionCount = db.prepare(
    `SELECT COUNT(*) as n FROM sessions WHERE device_id = ?`
  ).get(id).n;

  if (sessionCount > 0) {
    return res.status(409).json({
      error: `Cannot delete device with ${sessionCount} session record(s). Deactivate it instead.`,
    });
  }

  db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /admin/sessions?device_id=&status=&limit=50&offset=0
// List sessions, newest first. Optionally filter by device or status.
// ---------------------------------------------------------------------------
router.get('/sessions', (req, res) => {
  const { device_id, status, from, to, limit = 50, offset = 0 } = req.query;

  let query = `
    SELECT
      s.id, s.device_id, s.customer_name, s.amount_paid,
      s.minutes_purchased, s.seconds_remaining, s.status,
      s.started_at, s.ended_at, s.created_at,
      c.phone AS customer_phone, c.email AS customer_email
    FROM sessions s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE 1=1
  `;
  const params = [];

  if (device_id) { query += ` AND s.device_id = ?`; params.push(device_id); }
  if (status)    { query += ` AND s.status = ?`;    params.push(status); }
  // Time window: session overlaps [from, to] if started_at < to AND (ended_at > from OR status='active')
  if (from && to) {
    query += ` AND s.started_at < ? AND (s.ended_at > ? OR s.status = 'active')`;
    params.push(parseInt(to), parseInt(from));
  }

  query += ` ORDER BY s.created_at DESC LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), parseInt(offset));

  const sessions = db.prepare(query).all(...params);

  return res.json({ sessions, total: sessions.length, limit: parseInt(limit), offset: parseInt(offset) });
});

// ---------------------------------------------------------------------------
// GET /admin/sessions/:id
// Full session detail with event log.
// ---------------------------------------------------------------------------
router.get('/sessions/:id', (req, res) => {
  const session = db.prepare(`
    SELECT
      s.*, c.phone AS customer_phone, c.email AS customer_email
    FROM sessions s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!session) return res.status(404).json({ error: 'Session not found' });

  const events = db.prepare(`
    SELECT event_type, battery_pct, relay_state, note, created_at
    FROM device_events
    WHERE session_id = ?
    ORDER BY created_at ASC
  `).all(req.params.id);

  // Remove raw Square payload from response (keep it in DB for audit only)
  delete session.square_payload;

  return res.json({ session, events });
});

// ---------------------------------------------------------------------------
// POST /admin/sessions/:id/stop
// Emergency stop a specific session.
// ---------------------------------------------------------------------------
router.post('/sessions/:id/stop', (req, res) => {
  const session = db.prepare(
    `SELECT id, device_id, status FROM sessions WHERE id = ?`
  ).get(req.params.id);

  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') {
    return res.status(409).json({ error: `Session is already '${session.status}'` });
  }

  stopTimer(session.id, 'admin_stop');
  queueRelayOff(session.device_id, session.id);
  db.prepare(
    `UPDATE sessions SET status = 'stopped', ended_at = unixepoch() WHERE id = ?`
  ).run(session.id);
  logEvent(session.device_id, session.id, 'relay_off', null, null, 'Stopped by admin');
  _finaliseCustomerStats(session.id);

  console.log(`[admin] Session ${session.id} stopped on device ${session.device_id}`);
  return res.json({ ok: true, session_id: session.id });
});

// ---------------------------------------------------------------------------
// POST /admin/devices/:id/start-session
// Manually start a session — used when Square webhook is unavailable (offline).
// Body: { amount_aud, customer_name?, customer_phone? }
// ---------------------------------------------------------------------------
router.post('/devices/:id/start-session', (req, res) => {
  const deviceId = req.params.id;
  const { amount_aud, customer_name, customer_phone } = req.body;

  if (!amount_aud || isNaN(parseFloat(amount_aud)) || parseFloat(amount_aud) <= 0) {
    return res.status(400).json({ error: 'amount_aud is required and must be a positive number' });
  }

  const amountAud = parseFloat(amount_aud);

  const device = db.prepare(`SELECT id, battery_pct FROM devices WHERE id = ?`).get(deviceId);
  if (!device) {
    return res.status(404).json({ error: `Device '${deviceId}' not registered` });
  }
  if ((device.battery_pct ?? 100) < LOW_BATTERY_THRESHOLD) {
    return res.status(422).json({ error: `Device '${deviceId}' battery too low to start a session` });
  }

  // Stop any active session on this device first
  const activeSession = db.prepare(
    `SELECT id FROM sessions WHERE device_id = ? AND status = 'active'`
  ).get(deviceId);
  if (activeSession) {
    stopTimer(activeSession.id, 'replaced_by_manual_start');
    queueRelayOff(deviceId, activeSession.id);
    db.prepare(`UPDATE sessions SET status = 'stopped', ended_at = unixepoch() WHERE id = ?`).run(activeSession.id);
  }

  // Upsert customer
  const customerId = uuidv4();
  const existingCustomer = customer_phone
    ? db.prepare(`SELECT id FROM customers WHERE phone = ?`).get(customer_phone)
    : null;

  let resolvedCustomerId;
  if (existingCustomer) {
    resolvedCustomerId = existingCustomer.id;
    if (customer_name) {
      db.prepare(`UPDATE customers SET name = ? WHERE id = ?`).run(customer_name, resolvedCustomerId);
    }
  } else {
    resolvedCustomerId = customerId;
    db.prepare(
      `INSERT INTO customers (id, name, phone, email) VALUES (?, ?, ?, ?)`
    ).run(resolvedCustomerId, customer_name || 'Walk-in', customer_phone || null, null);
  }

  const minutesPurchased = Math.max(1, Math.floor(amountAud / PRICE_PER_MINUTE_AUD));
  const secondsPurchased = minutesPurchased * 60;
  const sessionId = uuidv4();

  db.prepare(`
    INSERT INTO sessions
      (id, device_id, customer_id, customer_name, amount_paid,
       minutes_purchased, seconds_remaining, status, started_at,
       square_payment_id, square_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', unixepoch(), NULL, NULL)
  `).run(
    sessionId, deviceId, resolvedCustomerId, customer_name || 'Walk-in',
    amountAud, minutesPurchased, secondsPurchased
  );

  queueRelayOn(deviceId, sessionId);
  logEvent(deviceId, sessionId, 'payment', null, null,
    `[MANUAL] $${amountAud} AUD → ${minutesPurchased} min for ${customer_name || 'Walk-in'}`);

  startTimer(sessionId, (expiredId, expiredDeviceId) => {
    queueRelayOff(expiredDeviceId, expiredId);
    console.log(`[timer] Session ${expiredId} expired — RELAY OFF queued for ${expiredDeviceId}`);
  });

  console.log(`[admin] Manual session ${sessionId} started — ${minutesPurchased} min on ${deviceId}`);

  return res.status(201).json({
    session_id: sessionId,
    device_id: deviceId,
    customer_name: customer_name || 'Walk-in',
    amount_aud: amountAud,
    minutes_purchased: minutesPurchased,
    seconds_remaining: secondsPurchased,
  });
});

// ---------------------------------------------------------------------------
// POST /admin/devices/:id/start-timed
// Staff dashboard: start a session by specifying minutes directly.
// Assumes payment has already been collected externally.
// Body: { minutes, customer_name? }
// ---------------------------------------------------------------------------
router.post('/devices/:id/start-timed', (req, res) => {
  const deviceId = req.params.id;
  const { minutes, customer_name, customer_id } = req.body;

  const minutesParsed = parseInt(minutes);
  if (!minutes || isNaN(minutesParsed) || minutesParsed <= 0) {
    return res.status(400).json({ error: 'minutes is required and must be a positive integer' });
  }

  const minutesPurchased = Math.max(1, minutesParsed);
  const secondsPurchased = minutesPurchased * 60;
  const sessionHours     = minutesPurchased / 60;

  const device = db.prepare(`SELECT id, battery_pct FROM devices WHERE id = ?`).get(deviceId);
  if (!device) {
    return res.status(404).json({ error: `Device '${deviceId}' not registered` });
  }
  if ((device.battery_pct ?? 100) < LOW_BATTERY_THRESHOLD) {
    return res.status(422).json({ error: `Device '${deviceId}' battery too low to start a session` });
  }

  // Reservation conflict check
  const nowTs         = Math.floor(Date.now() / 1000);
  const sessionEndsTs = nowTs + secondsPurchased;
  const resConflict   = db.prepare(`
    SELECT id, starts_at, customer_name FROM reservations
    WHERE device_id = ? AND status = 'active'
      AND starts_at < ? AND ends_at > ?
  `).get(deviceId, sessionEndsTs, nowTs);

  if (resConflict) {
    const when = new Date(resConflict.starts_at * 1000).toLocaleString();
    return res.status(409).json({
      error: `This dozer is reserved for "${resConflict.customer_name}" starting ${when}. Cannot double-book.`,
      reservation_id: resConflict.id,
    });
  }

  // Stop any active session on this device first
  const activeSession = db.prepare(
    `SELECT id FROM sessions WHERE device_id = ? AND status = 'active'`
  ).get(deviceId);
  if (activeSession) {
    stopTimer(activeSession.id, 'replaced_by_staff_start');
    queueRelayOff(deviceId, activeSession.id);
    db.prepare(`UPDATE sessions SET status = 'stopped', ended_at = unixepoch() WHERE id = ?`).run(activeSession.id);
  }

  // Resolve customer ─────────────────────────────────────────────────────────
  let resolvedCustomerId;
  let resolvedName;
  let hoursDeducted = 0;

  if (customer_id) {
    // Registered customer (returner or newly created)
    const customer = db.prepare(
      `SELECT id, name, hours_remaining FROM customers WHERE id = ?`
    ).get(customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    resolvedCustomerId = customer.id;
    resolvedName       = customer_name || customer.name;

    // Deduct from hours_remaining if the customer has enough credit
    if (customer.hours_remaining >= sessionHours) {
      db.prepare(
        `UPDATE customers SET hours_remaining = hours_remaining - ? WHERE id = ?`
      ).run(sessionHours, customer.id);
      hoursDeducted = sessionHours;
    }
  } else {
    // Guest — create a throwaway customer record
    resolvedCustomerId = uuidv4();
    resolvedName       = customer_name || 'Walk-in';
    db.prepare(
      `INSERT INTO customers (id, name, phone, email) VALUES (?, ?, NULL, NULL)`
    ).run(resolvedCustomerId, resolvedName);
  }

  const sessionId = uuidv4();
  db.prepare(`
    INSERT INTO sessions
      (id, device_id, customer_id, customer_name, amount_paid,
       minutes_purchased, seconds_remaining, status, started_at,
       square_payment_id, square_payload)
    VALUES (?, ?, ?, ?, 0, ?, ?, 'active', unixepoch(), NULL, NULL)
  `).run(sessionId, deviceId, resolvedCustomerId, resolvedName, minutesPurchased, secondsPurchased);

  queueRelayOn(deviceId, sessionId);
  logEvent(deviceId, sessionId, 'payment', null, null,
    `[STAFF] ${minutesPurchased} min for ${resolvedName}${hoursDeducted ? ` (${hoursDeducted.toFixed(2)} hrs deducted)` : ''}`);

  startTimer(sessionId, (expiredId, expiredDeviceId) => {
    // Update customer stats on natural expiry
    _finaliseCustomerStats(expiredId);
    queueRelayOff(expiredDeviceId, expiredId);
    console.log(`[timer] Session ${expiredId} expired — RELAY OFF queued for ${expiredDeviceId}`);
  });

  console.log(`[admin] Staff session ${sessionId} started — ${minutesPurchased} min on ${deviceId}`);
  return res.status(201).json({
    session_id:       sessionId,
    device_id:        deviceId,
    customer_name:    resolvedName,
    minutes_purchased: minutesPurchased,
    seconds_remaining: secondsPurchased,
    hours_deducted:   hoursDeducted,
  });
});

// Helper: update total_hours_played and points when a session ends
function _finaliseCustomerStats(sessionId) {
  const s = db.prepare(
    `SELECT customer_id, minutes_purchased FROM sessions WHERE id = ?`
  ).get(sessionId);
  if (!s?.customer_id) return;
  const hoursPlayed = s.minutes_purchased / 60;
  const pts         = Math.floor(hoursPlayed * 10); // 10 pts per hour
  db.prepare(
    `UPDATE customers SET total_hours_played = total_hours_played + ?, points = points + ? WHERE id = ?`
  ).run(hoursPlayed, pts, s.customer_id);
}

// ---------------------------------------------------------------------------
// POST /admin/sessions/:id/add-time
// Extend an active session. Body: { minutes }
// ---------------------------------------------------------------------------
router.post('/sessions/:id/add-time', (req, res) => {
  const { minutes } = req.body;
  const minutesParsed = parseInt(minutes);

  if (!minutes || isNaN(minutesParsed) || minutesParsed <= 0) {
    return res.status(400).json({ error: 'minutes is required and must be a positive integer' });
  }

  const session = db.prepare(
    `SELECT id, device_id, status, seconds_remaining, minutes_purchased FROM sessions WHERE id = ?`
  ).get(req.params.id);

  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') {
    return res.status(409).json({ error: `Session is not active (status: ${session.status})` });
  }

  const addSeconds   = minutesParsed * 60;
  const nowTs        = Math.floor(Date.now() / 1000);
  const currentEndTs = nowTs + session.seconds_remaining;
  const newEndTs     = currentEndTs + addSeconds;

  // Reject if the extension pushes into a future reservation on this device
  const resConflict = db.prepare(`
    SELECT id, starts_at, customer_name FROM reservations
    WHERE device_id = ? AND status = 'active'
      AND starts_at < ? AND ends_at > ?
      AND starts_at >= ?
  `).get(session.device_id, newEndTs, nowTs, currentEndTs);

  if (resConflict) {
    const when = new Date(resConflict.starts_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return res.status(409).json({
      error: `Adding ${minutesParsed} min would overlap a reservation for "${resConflict.customer_name}" at ${when}.`,
      reservation_id: resConflict.id,
    });
  }

  db.prepare(
    `UPDATE sessions
     SET seconds_remaining = seconds_remaining + ?,
         minutes_purchased = minutes_purchased + ?
     WHERE id = ?`
  ).run(addSeconds, minutesParsed, session.id);

  logEvent(session.device_id, session.id, 'relay_on', null, null,
    `Time extended by ${minutesParsed} min`);

  console.log(`[admin] Session ${session.id} extended by ${minutesParsed} min`);
  return res.json({
    ok: true,
    session_id: session.id,
    added_minutes: minutesParsed,
    new_seconds_remaining: session.seconds_remaining + addSeconds,
  });
});

// ---------------------------------------------------------------------------
// POST /admin/sessions/stop-all
// Stop every active session across all devices.
// ---------------------------------------------------------------------------
router.post('/sessions/stop-all', (req, res) => {
  const active = db.prepare(
    `SELECT id, device_id FROM sessions WHERE status = 'active'`
  ).all();

  if (!active.length) {
    return res.json({ ok: true, stopped: 0 });
  }

  for (const session of active) {
    stopTimer(session.id, 'admin_stop_all');
    queueRelayOff(session.device_id, session.id);
    db.prepare(
      `UPDATE sessions SET status = 'stopped', ended_at = unixepoch() WHERE id = ?`
    ).run(session.id);
    logEvent(session.device_id, session.id, 'relay_off', null, null, 'Stopped by admin (stop all)');
  }

  console.log(`[admin] stop-all: stopped ${active.length} session(s)`);
  return res.json({ ok: true, stopped: active.length });
});

// ---------------------------------------------------------------------------
// GET /admin/reservations?from=&to=
// Returns active reservations within the given unix-timestamp window.
// Defaults to now → now+7 days when params are omitted.
// ---------------------------------------------------------------------------
router.get('/reservations', (req, res) => {
  const now  = Math.floor(Date.now() / 1000);
  const from = parseInt(req.query.from) || now;
  const to   = parseInt(req.query.to)   || now + 7 * 86400;

  const reservations = db.prepare(`
    SELECT r.id, r.device_id, r.customer_id, r.customer_name,
           r.starts_at, r.ends_at, r.note, r.status, r.created_at,
           d.name AS device_name
    FROM reservations r
    JOIN devices d ON d.id = r.device_id
    WHERE r.status = 'active'
      AND r.starts_at < ?
      AND r.ends_at   > ?
    ORDER BY r.starts_at
  `).all(to, from);

  return res.json({ reservations });
});

// ---------------------------------------------------------------------------
// POST /admin/reservations
// Body: { device_ids, starts_at, ends_at, customer_id?, customer_name?, note? }
// ---------------------------------------------------------------------------
router.post('/reservations', (req, res) => {
  const { device_ids, starts_at, ends_at, customer_id, customer_name, note } = req.body;

  if (!Array.isArray(device_ids) || !device_ids.length) {
    return res.status(400).json({ error: 'device_ids must be a non-empty array' });
  }
  if (!starts_at || !ends_at || ends_at <= starts_at) {
    return res.status(400).json({ error: 'Valid starts_at and ends_at (unix timestamps) are required' });
  }

  // Check for conflicts on every device before inserting any
  const conflicts = [];
  for (const deviceId of device_ids) {
    const conflict = db.prepare(`
      SELECT id, starts_at, ends_at FROM reservations
      WHERE device_id = ? AND status = 'active'
        AND starts_at < ? AND ends_at > ?
    `).get(deviceId, ends_at, starts_at);
    if (conflict) {
      const d = db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId);
      conflicts.push(`${d?.name || deviceId} already reserved at that time`);
    }
  }
  if (conflicts.length) {
    return res.status(409).json({ error: conflicts.join('; ') });
  }

  const resolvedName = customer_name || 'Staff Hold';
  const created = device_ids.map(deviceId => {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO reservations (id, device_id, customer_id, customer_name, starts_at, ends_at, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, deviceId, customer_id || null, resolvedName, starts_at, ends_at, note || null);
    return { id, device_id: deviceId, customer_name: resolvedName, starts_at, ends_at };
  });

  console.log(`[admin] ${created.length} reservation(s) created for ${resolvedName}`);
  return res.status(201).json({ reservations: created });
});

// ---------------------------------------------------------------------------
// DELETE /admin/reservations/:id
// Soft-cancel a reservation.
// ---------------------------------------------------------------------------
router.delete('/reservations/:id', (req, res) => {
  const r = db.prepare(`SELECT id, status FROM reservations WHERE id = ?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });
  if (r.status === 'cancelled') return res.json({ ok: true, already_cancelled: true });

  db.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?`).run(r.id);
  console.log(`[admin] Reservation ${r.id} cancelled`);
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /admin/customers/search?q=
// Search registered customers by name, email or phone (min 2 chars).
// ---------------------------------------------------------------------------
router.get('/customers/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ customers: [] });
  const like = `%${q}%`;
  const customers = db.prepare(`
    SELECT id, name, email, phone, total_hours_played, hours_remaining, points, created_at
    FROM customers
    WHERE name LIKE ? OR email LIKE ? OR phone LIKE ?
    ORDER BY name
    LIMIT 10
  `).all(like, like, like);
  return res.json({ customers });
});

// ---------------------------------------------------------------------------
// POST /admin/customers
// Register a new customer profile.
// Body: { name, email, phone? }
// ---------------------------------------------------------------------------
router.post('/customers', (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) {
    return res.status(409).json({ error: 'A customer with this email already exists' });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO customers (id, name, phone, email) VALUES (?, ?, ?, ?)`
  ).run(id, name.trim(), phone?.trim() || null, email.toLowerCase().trim());

  const customer = db.prepare(
    `SELECT id, name, email, phone, total_hours_played, hours_remaining, points FROM customers WHERE id = ?`
  ).get(id);

  console.log(`[admin] New customer registered: ${name} <${email}>`);
  return res.status(201).json({ customer });
});

// ---------------------------------------------------------------------------
// GET /admin/summary
// Quick stats overview — useful for a dashboard.
// ---------------------------------------------------------------------------
router.get('/summary', (req, res) => {
  const totalDevices   = db.prepare(`SELECT COUNT(*) as n FROM devices`).get().n;
  const onlineDevices  = db.prepare(`SELECT COUNT(*) as n FROM devices WHERE is_online = 1`).get().n;
  const activeSessions = db.prepare(`SELECT COUNT(*) as n FROM sessions WHERE status = 'active'`).get().n;
  const todaySessions  = db.prepare(`
    SELECT COUNT(*) as n FROM sessions
    WHERE created_at >= unixepoch('now', 'start of day')
  `).get().n;
  const todayRevenue   = db.prepare(`
    SELECT COALESCE(SUM(amount_paid), 0) as total FROM sessions
    WHERE created_at >= unixepoch('now', 'start of day')
  `).get().total;

  return res.json({
    devices:         { total: totalDevices, online: onlineDevices },
    sessions:        { active: activeSessions, today: todaySessions },
    revenue_today_aud: parseFloat(todayRevenue.toFixed(2)),
  });
});

module.exports = router;
module.exports.finaliseCustomerStats = _finaliseCustomerStats;
