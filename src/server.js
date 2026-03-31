require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const paymentRoutes = require('./routes/payment');
const deviceRoutes  = require('./routes/device');
const adminRoutes   = require('./routes/admin');
const { finaliseCustomerStats } = adminRoutes;
const { restoreActiveTimers } = require('./services/timer');
const { queueRelayOff } = require('./services/relay');

const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------
app.use(helmet());
app.use(cors());

// Parse JSON and capture raw body for Square HMAC signature verification
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString(); },
}));
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Static dashboard
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/payment', paymentRoutes);
app.use('/device',  deviceRoutes);
app.use('/admin',   adminRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), env: process.env.NODE_ENV });
});

// Root — quick overview of available endpoints
app.get('/', (req, res) => {
  res.json({
    service: 'Dozer Rental Backend',
    status: 'running',
    endpoints: {
      health:          'GET  /health',
      payment_webhook: 'POST /payment/webhook',
      payment_test:    'POST /payment/test  (dev only)',
      device_poll:     'GET  /device/poll?device_id=&key=',
      device_heartbeat:'POST /device/heartbeat?device_id=&key=',
      device_estop:    'POST /device/estop?device_id=&key=',
      admin_summary:   'GET  /admin/summary',
      admin_devices:   'GET  /admin/devices',
      admin_sessions:  'GET  /admin/sessions',
    },
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[server] Dozer rental backend running on http://localhost:${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV}`);

  // Restore any sessions that were active before the server restarted
  restoreActiveTimers((expiredId, expiredDeviceId) => {
    finaliseCustomerStats(expiredId);
    queueRelayOff(expiredDeviceId, expiredId);
    console.log(`[timer] Restored session ${expiredId} expired — RELAY OFF queued for ${expiredDeviceId}`);
  });
});

module.exports = app;
