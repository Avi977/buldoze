const API = '';
let adminKey = '';
let refreshTimer = null;
let sessionOffset = 0;
const SESSION_LIMIT = 20;

// ── Helpers ─────────────────────────────────────────────────────────────────

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = '', 3000);
}

function fmt(seconds) {
  if (!seconds || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function batteryColor(pct) {
  if (pct == null) return 'var(--muted)';
  if (pct < 15) return 'var(--red)';
  if (pct < 30) return 'var(--yellow)';
  return 'var(--green)';
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'x-admin-key': adminKey, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── Login ────────────────────────────────────────────────────────────────────

async function tryLogin() {
  const key = document.getElementById('api-key-input').value.trim();
  if (!key) return;
  try {
    adminKey = key;
    await apiFetch('/admin/summary');
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    startDashboard();
  } catch {
    adminKey = '';
    document.getElementById('login-error').textContent = 'Invalid key — try again.';
  }
}

document.getElementById('login-btn').addEventListener('click', tryLogin);
document.getElementById('api-key-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryLogin();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  clearInterval(refreshTimer);
  adminKey = '';
  sessionOffset = 0;
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('api-key-input').value = '';
});

// ── Dashboard ────────────────────────────────────────────────────────────────

function startDashboard() {
  loadAll();
  refreshTimer = setInterval(loadAll, 5000);

  document.getElementById('filter-status').addEventListener('change', () => { sessionOffset = 0; loadSessions(); });
  document.getElementById('filter-device').addEventListener('change', () => { sessionOffset = 0; loadSessions(); });
  document.getElementById('prev-btn').addEventListener('click', () => { sessionOffset = Math.max(0, sessionOffset - SESSION_LIMIT); loadSessions(); });
  document.getElementById('next-btn').addEventListener('click', () => { sessionOffset += SESSION_LIMIT; loadSessions(); });
}

async function loadAll() {
  await Promise.all([loadSummary(), loadDevices(), loadSessions()]);
  const dot = document.getElementById('live-dot');
  dot.classList.add('live');
  document.getElementById('last-refresh').textContent = 'Updated ' + new Date().toLocaleTimeString();
  setTimeout(() => dot.classList.remove('live'), 800);
}

// ── Summary ──────────────────────────────────────────────────────────────────

async function loadSummary() {
  try {
    const d = await apiFetch('/admin/summary');
    document.getElementById('s-online').textContent = d.devices.online;
    document.getElementById('s-total').textContent = `of ${d.devices.total} total`;
    document.getElementById('s-active').textContent = d.sessions.active;
    document.getElementById('s-today').textContent = d.sessions.today;
    document.getElementById('s-revenue').textContent = `$${d.revenue_today_aud.toFixed(2)}`;
  } catch {}
}

// ── Devices ──────────────────────────────────────────────────────────────────

async function loadDevices() {
  try {
    const { devices } = await apiFetch('/admin/devices');

    // Populate device filter
    const sel = document.getElementById('filter-device');
    const current = sel.value;
    sel.innerHTML = '<option value="">All devices</option>';
    devices.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.name || d.id;
      if (d.id === current) o.selected = true;
      sel.appendChild(o);
    });

    const grid = document.getElementById('devices-grid');
    if (!devices.length) {
      grid.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;">No devices registered.</div>';
      return;
    }

    grid.innerHTML = devices.map(d => {
      const isActive  = !!d.active_session_id;
      const isOffline = !d.is_online;
      const isLowBat  = (d.battery_pct != null) && d.battery_pct < 15;

      let cardClass = '';
      if (isActive)       cardClass = 'active';
      else if (isOffline) cardClass = 'offline';
      else if (isLowBat)  cardClass = 'low-battery';

      let badgeHtml = '';
      if (isActive)       badgeHtml = '<span class="status-badge badge-active">Active</span>';
      else if (isOffline) badgeHtml = '<span class="status-badge badge-offline">Offline</span>';
      else if (isLowBat)  badgeHtml = '<span class="status-badge badge-low">Low Bat</span>';
      else                badgeHtml = '<span class="status-badge badge-online">Online</span>';

      const batPct   = d.battery_pct != null ? d.battery_pct.toFixed(0) + '%' : '—';
      const batFill  = d.battery_pct != null ? Math.max(0, Math.min(100, d.battery_pct)) : 0;
      const batColor = batteryColor(d.battery_pct);

      const countdownHtml = isActive
        ? `<div class="countdown">${fmt(d.seconds_remaining)}</div>
           <div style="font-size:0.75rem;color:var(--muted);">${d.customer_name || 'Customer'} · ${d.minutes_purchased} min</div>`
        : `<div class="countdown idle">No active session</div>`;

      const estopHtml = isActive
        ? `<button class="estop-btn" data-session="${d.active_session_id}" data-device="${d.id}">Stop Session</button>`
        : (!isOffline
            ? `<button class="start-btn" data-device="${d.id}">Start Session</button>`
            : '');

      return `
        <div class="device-card ${cardClass}">
          <div class="device-header">
            <div>
              <div class="device-name">${d.name || d.id}</div>
              <div class="device-id">${d.id}${d.location ? ' · ' + d.location : ''}</div>
            </div>
            ${badgeHtml}
          </div>
          <div class="device-stats">
            <div class="stat-row">
              <span class="key">Battery</span>
              <span class="val" style="color:${batColor}">${batPct}</span>
            </div>
            <div class="battery-bar">
              <div class="battery-fill" style="width:${batFill}%;background:${batColor};"></div>
            </div>
            <div class="stat-row">
              <span class="key">Relay</span>
              <span class="val" style="color:${d.relay_state ? 'var(--green)' : 'var(--muted)'}">
                ${d.relay_state ? 'ON' : 'OFF'}
              </span>
            </div>
          </div>
          ${countdownHtml}
          ${estopHtml}
        </div>`;
    }).join('');

    // Attach buttons via event delegation
    document.getElementById('devices-grid').addEventListener('click', e => {
      const stopBtn  = e.target.closest('.estop-btn');
      const startBtn = e.target.closest('.start-btn');
      if (stopBtn)  emergencyStop(stopBtn.dataset.session, stopBtn.dataset.device);
      if (startBtn) promptStartSession(startBtn.dataset.device);
    }, { once: true });

  } catch {}
}

async function promptStartSession(deviceId) {
  const amountStr = prompt(`Start session on ${deviceId}\n\nEnter amount paid (AUD):`);
  if (amountStr === null) return; // cancelled
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) { toast('Invalid amount', 'error'); return; }
  const customerName = prompt('Customer name (optional — press Enter to skip):') || '';
  try {
    const d = await apiFetch(`/admin/devices/${deviceId}/start-session`, {
      method: 'POST',
      body: JSON.stringify({ amount_aud: amount, customer_name: customerName || undefined }),
    });
    toast(`Started ${d.minutes_purchased} min session on ${deviceId}`);
    loadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function emergencyStop(sessionId, deviceId) {
  if (!confirm(`Stop session on ${deviceId}?`)) return;
  try {
    await apiFetch(`/admin/sessions/${sessionId}/stop`, { method: 'POST' });
    toast(`Session stopped on ${deviceId}`);
    loadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────────

async function loadSessions() {
  const status   = document.getElementById('filter-status').value;
  const deviceId = document.getElementById('filter-device').value;

  let url = `/admin/sessions?limit=${SESSION_LIMIT}&offset=${sessionOffset}`;
  if (status)   url += `&status=${status}`;
  if (deviceId) url += `&device_id=${deviceId}`;

  try {
    const { sessions, total } = await apiFetch(url);
    const tbody = document.getElementById('sessions-body');

    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px;">No sessions found.</td></tr>';
    } else {
      tbody.innerHTML = sessions.map(s => `
        <tr>
          <td style="font-weight:500">${s.device_id}</td>
          <td>${s.customer_name || '—'}${s.customer_phone ? `<br><span style="color:var(--muted);font-size:0.76rem;">${s.customer_phone}</span>` : ''}</td>
          <td>$${parseFloat(s.amount_paid).toFixed(2)}</td>
          <td>${s.minutes_purchased} min</td>
          <td><span class="pill pill-${s.status}">${s.status.replace('_', ' ')}</span></td>
          <td style="color:var(--muted)">${fmtDate(s.started_at)}</td>
        </tr>`).join('');
    }

    const start = sessionOffset + 1;
    const end   = Math.min(sessionOffset + sessions.length, total);
    document.getElementById('page-info').textContent = total ? `${start}–${end} of ${total}` : '0 results';
    document.getElementById('prev-btn').disabled = sessionOffset === 0;
    document.getElementById('next-btn').disabled = sessionOffset + SESSION_LIMIT >= total;
  } catch {}
}
