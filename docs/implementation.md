# Miniature Dozer Rental System — Implementation Document

## Overview

A cloud-hosted backend system for a miniature bulldozer rental business operating in Australia. Customers pay via Square terminal and the dozer automatically starts and stops based on the time purchased. Each dozer has an ESP32 control circuit that communicates with the server over WiFi.

---

## System Architecture

```
[Square Terminal]
       |
       | HTTPS webhook (payment.completed)
       v
[Node.js Server on VPS]  <──── HTTPS poll every 5s ────  [ESP32 on Dozer]
       |                                                        |
  [SQLite DB]                                           Relay (ON/OFF)
       |                                               Voltage Sensor
  Sessions                                             Emergency Stop
  Customers
  Devices
  Event Log
```

### Flow Summary

1. Staff charges customer on Square Terminal — enters dozer ID (e.g. `dozer_01`) in the note field
2. Square sends a `payment.completed` webhook to the server
3. Server verifies the signature, calculates time purchased, creates a session, queues RELAY_ON
4. ESP32 on the matching dozer polls the server, receives RELAY_ON, activates the relay
5. Dozer powers on — countdown begins on server
6. When timer hits zero the server queues RELAY_OFF — ESP32 picks it up and cuts power
7. Dozer stops

---

## Components

### 1. ESP32 Firmware

**File:** `esp32/firmware/dozer_control.ino`

Each of the 15 units has this firmware flashed at setup time with unit-specific values.

#### Hardcoded per unit at flash time

| Constant | Example | Purpose |
|----------|---------|---------|
| `DEVICE_ID` | `"dozer_01"` | Unique ID matching the DB |
| `DEVICE_SECRET` | `"abc123xyz"` | Auth key for server requests |
| `SERVER_URL` | `"https://yourdomain.com"` | VPS address |
| `RELAY_PIN` | `26` | GPIO pin controlling relay |
| `VOLTAGE_PIN` | `34` | Analog pin on voltage sensor |
| `ESTOP_PIN` | `27` | Emergency stop button pin |
| `BATTERY_MAX_V` | `12.6` | 100% voltage for 12V battery |
| `BATTERY_MIN_V` | `10.5` | 0% voltage for 12V battery |

#### Behaviour Loop (every 5 seconds)

1. `GET /device/poll?device_id=<id>&key=<secret>`
   - Server responds with `{ command: "ON"|"OFF"|"NONE", seconds_remaining: 300 }`
   - Executes relay if command is `ON` or `OFF`
2. `POST /device/heartbeat`
   - Sends `{ device_id, battery_pct, relay_state }`
   - Server updates device record + logs event

#### Emergency Stop Button

- Wired as normally-closed (NC) interrupt
- On press: immediately cuts relay (hardware level) then notifies server
- Server marks session as `stopped`

#### Battery Monitoring

- Reads analog voltage, converts to percentage using min/max range
- Reported on every heartbeat
- If battery < 15%: sends `low_battery` flag to server
- Server blocks new sessions on that device and stops any active session

#### Display

- Not implemented in initial version
- `seconds_remaining` is included in the poll response for future use
- TM1637 display layer will be added as a later update

---

### 2. Node.js Backend Server

**Entry point:** `src/server.js`
**Runtime:** Node.js 18+
**Key packages:** express, better-sqlite3, dotenv, cors, helmet, uuid, express-validator

#### API Reference

##### Payment

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/payment/webhook` | Square HMAC signature | Receives Square payment event, starts session |

Square sends `payment.completed` events. The server:
- Verifies `x-square-hmacsha256-signature` header using the webhook signature key
- Reads `payment.amount_money.amount` (AUD cents) → converts to dollars
- Reads `payment.note` → this is the `device_id` (staff enters it on the terminal)
- Calculates minutes: `floor(aud / PRICE_PER_MINUTE_AUD)`
- Creates session, queues RELAY_ON, starts countdown

##### Device (ESP32)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/device/poll` | `?key=<device_secret>` | Returns pending relay command + seconds remaining |
| `POST` | `/device/heartbeat` | `?key=<device_secret>` | Receives battery %, relay state from ESP32 |

##### Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/admin/devices` | `X-Admin-Key` header | Live status of all 15 dozers |
| `POST` | `/admin/devices` | `X-Admin-Key` header | Register a new device |
| `GET` | `/admin/sessions` | `X-Admin-Key` header | All sessions, filterable by device/status/date |
| `GET` | `/admin/session/:id` | `X-Admin-Key` header | Session detail + full event log |
| `POST` | `/admin/session/:id/stop` | `X-Admin-Key` header | Emergency stop a session |

#### Timer Service (`src/services/timer.js`)

- One `setInterval` (1 tick/sec) per active session
- Each tick decrements `seconds_remaining` in the DB
- At 0: marks session `completed`, queues RELAY_OFF
- On server restart: reads all `active` sessions from DB and restores their countdowns

#### Relay Command Queue (`src/services/relay.js`)

- In-memory map: `device_id → { command, session_id }`
- Payment handler writes `RELAY_ON`; timer expiry writes `RELAY_OFF`
- Device poll endpoint reads and clears the command (consumed once)

---

### 3. Database (SQLite)

**File location:** `/var/lib/dozer/dozer.db` on VPS
**Driver:** better-sqlite3 (synchronous, no async complexity)

#### Table: `devices`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | e.g. `dozer_01` |
| `name` | TEXT | Human label e.g. `"Bay 1 Dozer"` |
| `location` | TEXT | Physical location |
| `secret_key` | TEXT | Device auth token |
| `last_seen` | INTEGER | Unix timestamp of last heartbeat |
| `battery_pct` | REAL | Last reported battery percentage |
| `relay_state` | INTEGER | 0 = OFF, 1 = ON |
| `is_online` | INTEGER | 0/1 — offline if no heartbeat in 30s |

#### Table: `customers`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `name` | TEXT | From Square receipt |
| `phone` | TEXT | Deduplication key |
| `email` | TEXT | From Square receipt if available |
| `created_at` | INTEGER | Unix timestamp |

#### Table: `sessions`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | UUID |
| `device_id` | TEXT FK | Which dozer |
| `customer_id` | TEXT FK | Links to customers table |
| `customer_name` | TEXT | Denormalised for quick reads |
| `amount_paid` | REAL | AUD |
| `minutes_purchased` | INTEGER | |
| `seconds_remaining` | INTEGER | Decremented live by timer service |
| `started_at` | INTEGER | Unix timestamp relay went ON |
| `ended_at` | INTEGER | Unix timestamp relay went OFF |
| `status` | TEXT | `pending / active / completed / stopped / low_battery` |
| `square_payment_id` | TEXT | Square's payment ID — dedup key |
| `square_payload` | TEXT | Raw Square JSON — audit record |
| `created_at` | INTEGER | |

#### Table: `device_events`

Append-only audit log. Never updated, only inserted.

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `device_id` | TEXT FK | |
| `session_id` | TEXT FK | Nullable |
| `event_type` | TEXT | `heartbeat / relay_on / relay_off / payment / low_battery / estop` |
| `battery_pct` | REAL | |
| `relay_state` | INTEGER | |
| `note` | TEXT | Human-readable description |
| `created_at` | INTEGER | |

---

## Business Rules

| Rule | Behaviour |
|------|-----------|
| Pricing | `PRICE_PER_MINUTE_AUD` in `.env` — update when rate is confirmed |
| Duplicate payment | Reject if `square_payment_id` already exists (idempotent) |
| New payment on active device | Stops current session, starts new one immediately |
| Low battery (<15%) | Block new sessions, stop active session, flag in admin |
| Device offline | Block new sessions until heartbeat resumes |
| Emergency stop (hardware) | ESP32 cuts relay immediately, notifies server |
| Emergency stop (admin) | Admin API stops timer + queues RELAY_OFF |
| Server restart | Active sessions restored from DB, countdowns resume |

---

## Environment Variables

All configured in `.env` (copy from `config/.env.example`):

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | `development` or `production` | `development` |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | From Square Developer Dashboard | required |
| `SQUARE_ENVIRONMENT` | `sandbox` or `production` | `sandbox` |
| `ADMIN_API_KEY` | Key for admin endpoints | required |
| `DB_PATH` | Path to SQLite file | `./data/dozer.db` |
| `PRICE_PER_MINUTE_AUD` | AUD per minute of ride time | `0.20` |
| `LOW_BATTERY_THRESHOLD_PERCENT` | % below which sessions are blocked | `15` |
| `BATTERY_MAX_VOLTAGE` | Voltage at 100% (12V lead-acid) | `12.6` |
| `BATTERY_MIN_VOLTAGE` | Voltage at 0% | `10.5` |
| `DEVICE_TIMEOUT_SECONDS` | Seconds before device marked offline | `30` |

---

## Square Setup (Australia)

1. Create a Square Developer account at [developer.squareup.com](https://developer.squareup.com)
2. Create a new application
3. Go to **Webhooks** → Add endpoint: `https://yourdomain.com/payment/webhook`
4. Subscribe to the `payment.completed` event
5. Copy the **Webhook Signature Key** into `SQUARE_WEBHOOK_SIGNATURE_KEY` in `.env`
6. Train staff: when processing a payment on the Square Terminal, enter the dozer's ID (e.g. `dozer_01`) in the **note / reference field**

> Test payments using Square's sandbox environment before going live. Set `SQUARE_ENVIRONMENT=sandbox` during testing.

---

## VPS Deployment

### Requirements

- Ubuntu 22.04 LTS (or similar)
- Node.js 18+
- Domain name pointed at the VPS IP
- SSL certificate (free via Let's Encrypt / Certbot) — required for Square webhooks

### Setup Steps

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Clone repo and install dependencies
git clone <repo> /opt/dozer
cd /opt/dozer
npm install

# Configure environment
cp config/.env.example .env
nano .env   # fill in all values

# Create data directory
sudo mkdir -p /var/lib/dozer
sudo chown $USER /var/lib/dozer

# Run as a systemd service (keeps running after SSH disconnect)
sudo nano /etc/systemd/system/dozer.service
```

**systemd service file:**
```ini
[Unit]
Description=Dozer Rental Backend
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/dozer
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
EnvironmentFile=/opt/dozer/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable dozer
sudo systemctl start dozer

# SSL via Certbot (run after pointing domain to VPS)
sudo apt install certbot
sudo certbot certonly --standalone -d yourdomain.com
# Then set up nginx as reverse proxy to forward port 443 → 3000
```

---

## Device Setup (Per Dozer)

For each of the 15 units:

1. Flash `dozer_control.ino` via USB with unique `DEVICE_ID` and `DEVICE_SECRET`
2. Register the device on the server via admin API:
   ```
   POST /admin/devices
   { "id": "dozer_01", "name": "Bay 1", "location": "Zone A", "secret_key": "<same key as firmware>" }
   ```
3. Connect to site WiFi — device will start polling automatically

---

## Hardware Wiring Reference

From the component spec:

```
Battery (+) → Fuse → Relay → RC Receiver (+)
Battery (-)         →        RC Receiver (-)
Battery (+/-)       → Voltage Sensor → ESP32 analog pin
Battery             → DC-DC Buck Converter (12V→5V) → ESP32 VIN
ESP32 GPIO          → Relay control pin
ESP32 GPIO          → Emergency stop button (NC, interrupt)
```

> Do not modify the ESC or RC remote system. Control is applied only at the RC receiver power level.

---

## Out of Scope (This Version)

- TM1637 countdown display on the dozer — `seconds_remaining` is in the poll response, will be wired up in a future update
- Customer-facing web portal
- Automated receipts / SMS
- Loyalty or top-up accounts
- Multi-site management

---

## Pending Decisions

| Item | Status |
|------|--------|
| Final pricing rate (AUD/min) | Placeholder `0.20` — update `PRICE_PER_MINUTE_AUD` when confirmed |
| VPS provider | Client has existing VPS — confirm specs before deploying |
| Domain name | Required for SSL and Square webhook registration |
