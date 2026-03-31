/**
 * Payment routes
 *
 * POST /payment/webhook  — Square webhook (production)
 * POST /payment/test     — Simulated payment for local dev/testing only
 */

const { Router } = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { startTimer, stopTimer } = require('../services/timer');
const { queueRelayOn, queueRelayOff } = require('../services/relay');
const { logEvent } = require('../services/events');

const router = Router();

const PRICE_PER_MINUTE_AUD = parseFloat(process.env.PRICE_PER_MINUTE_AUD) || 0.20;
const LOW_BATTERY_THRESHOLD = parseFloat(process.env.LOW_BATTERY_THRESHOLD_PERCENT) || 15;

// ---------------------------------------------------------------------------
// Square HMAC signature verification
// Square signs with: HMAC-SHA256(signatureKey, webhookUrl + rawBody)
// In dev (no key set) this is skipped automatically.
// ---------------------------------------------------------------------------
function verifySquareSignature(req, res, next) {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!signatureKey) return next(); // dev mode — skip

  const signature = req.headers['x-square-hmacsha256-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'Missing Square signature header' });
  }

  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const hmac = crypto.createHmac('sha256', signatureKey);
  hmac.update(url + req.rawBody);
  const expected = hmac.digest('base64');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Invalid Square signature' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Shared session creation logic
// ---------------------------------------------------------------------------
function createSession(deviceId, amountAud, squarePaymentId, customerName, customerPhone, customerEmail, squarePayload) {
  const device = db.prepare(`SELECT id, battery_pct FROM devices WHERE id = ?`).get(deviceId);
  if (!device) {
    return { status: 404, error: `Device '${deviceId}' not registered` };
  }

  if ((device.battery_pct ?? 100) < LOW_BATTERY_THRESHOLD) {
    return { status: 422, error: `Device '${deviceId}' battery too low to start a session` };
  }

  if (squarePaymentId) {
    const duplicate = db.prepare(`SELECT id FROM sessions WHERE square_payment_id = ?`).get(squarePaymentId);
    if (duplicate) {
      return { status: 409, error: 'Payment already processed', session_id: duplicate.id };
    }
  }

  // Stop any active session on this device first
  const activeSession = db.prepare(
    `SELECT id FROM sessions WHERE device_id = ? AND status = 'active'`
  ).get(deviceId);
  if (activeSession) {
    stopTimer(activeSession.id, 'replaced_by_new_payment');
    queueRelayOff(deviceId, activeSession.id);
  }

  // Upsert customer
  let customerId = uuidv4();
  const existingCustomer = customerPhone
    ? db.prepare(`SELECT id FROM customers WHERE phone = ?`).get(customerPhone)
    : null;

  if (existingCustomer) {
    customerId = existingCustomer.id;
    if (customerName) {
      db.prepare(`UPDATE customers SET name = ? WHERE id = ?`).run(customerName, customerId);
    }
  } else {
    db.prepare(
      `INSERT INTO customers (id, name, phone, email) VALUES (?, ?, ?, ?)`
    ).run(customerId, customerName || 'Unknown', customerPhone || null, customerEmail || null);
  }

  const minutesPurchased = Math.max(1, Math.floor(amountAud / PRICE_PER_MINUTE_AUD));
  const secondsPurchased = minutesPurchased * 60;
  const sessionId = uuidv4();

  db.prepare(`
    INSERT INTO sessions
      (id, device_id, customer_id, customer_name, amount_paid,
       minutes_purchased, seconds_remaining, status, started_at,
       square_payment_id, square_payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', unixepoch(), ?, ?)
  `).run(
    sessionId, deviceId, customerId, customerName || 'Unknown',
    amountAud, minutesPurchased, secondsPurchased,
    squarePaymentId || null,
    squarePayload ? JSON.stringify(squarePayload) : null
  );

  queueRelayOn(deviceId, sessionId);
  logEvent(deviceId, sessionId, 'payment', null, null,
    `$${amountAud} AUD → ${minutesPurchased} min for ${customerName || 'Unknown'}`);

  startTimer(sessionId, (expiredId, expiredDeviceId) => {
    queueRelayOff(expiredDeviceId, expiredId);
    console.log(`[timer] Session ${expiredId} expired — RELAY OFF queued for ${expiredDeviceId}`);
  });

  console.log(`[payment] Session ${sessionId} started — ${minutesPurchased} min on ${deviceId}`);

  return {
    status: 201,
    body: {
      session_id: sessionId,
      device_id: deviceId,
      customer_name: customerName || 'Unknown',
      amount_aud: amountAud,
      minutes_purchased: minutesPurchased,
      seconds_remaining: secondsPurchased,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /payment/webhook — Square production webhook
// Square sends payment.completed events here.
// Staff enters the device_id (e.g. "dozer_01") in the Square terminal note field.
// ---------------------------------------------------------------------------
router.post('/webhook', verifySquareSignature, (req, res) => {
  const event = req.body;

  if (event.type !== 'payment.completed') {
    return res.status(200).json({ ignored: true, type: event.type });
  }

  const payment = event?.data?.object?.payment;
  if (!payment) {
    return res.status(400).json({ error: 'Malformed Square payload — missing payment object' });
  }

  const amountCents = payment?.amount_money?.amount;
  const currency = payment?.amount_money?.currency;
  const deviceId = (payment.note || '').trim();
  const squarePaymentId = payment.id;
  const customerEmail = payment.buyer_email_address || null;

  if (!amountCents || currency !== 'AUD') {
    return res.status(400).json({ error: 'Payment must be in AUD' });
  }
  if (!deviceId) {
    return res.status(400).json({ error: 'No device_id in Square payment note field' });
  }

  const amountAud = amountCents / 100;
  const result = createSession(deviceId, amountAud, squarePaymentId, null, null, customerEmail, event);

  return res.status(result.status).json(result.body || { error: result.error });
});

// ---------------------------------------------------------------------------
// POST /payment/test — local dev only
// Simulates a payment without a real Square terminal.
// Body: { device_id, amount_aud, customer_name, customer_phone? }
// ---------------------------------------------------------------------------
router.post('/test', (req, res) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ error: 'Not found' });
  }

  const { device_id, amount_aud, customer_name, customer_phone } = req.body;

  if (!device_id || !amount_aud) {
    return res.status(400).json({ error: 'device_id and amount_aud are required' });
  }

  const result = createSession(
    device_id,
    parseFloat(amount_aud),
    `TEST-${uuidv4()}`,
    customer_name || 'Test Customer',
    customer_phone || null,
    null,
    null
  );

  return res.status(result.status).json(result.body || { error: result.error });
});

module.exports = router;
