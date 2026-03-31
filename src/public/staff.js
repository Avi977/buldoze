const API = '';
let adminKey = '';

// ── Loader ───────────────────────────────────────────────────────────────────
(function () {
  const loader = document.getElementById('loader');
  // Show for at least 1.4 s so the animation is visible, then fade out
  setTimeout(() => {
    loader.classList.add('hidden');
    loader.addEventListener('transitionend', () => loader.remove(), { once: true });
  }, 1400);
}());
let refreshTimer = null;
let tickTimer = null;
let selectedHours = null;
let dozerCount = 1;
let availableDevices = [];
let checkedDeviceIds = new Set();
const sessionEndsAt = {};
const pendingStops  = new Set();

// Calendar state
let calendarActive = false;
let calView        = 'day';   // 'day' | 'week'
let calDate        = new Date(); // anchor date

// ── Helpers ─────────────────────────────────────────────────────────────────

function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = ''), 3200);
}

// Format seconds → H:MM:SS
function fmt(seconds) {
  if (!seconds || seconds <= 0) return '0:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
    headers: {
      'x-admin-key': adminKey,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── Login ────────────────────────────────────────────────────────────────────

async function tryLogin() {
  const key = document.getElementById('key-input').value.trim();
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
document.getElementById('key-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryLogin();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  clearInterval(refreshTimer);
  clearInterval(tickTimer);
  adminKey = '';
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('key-input').value = '';
});

// ── Dashboard ────────────────────────────────────────────────────────────────

function startDashboard() {
  loadAll();
  refreshTimer = setInterval(loadAll, 3000);
  tickTimer    = setInterval(tickCountdowns, 1000);
}

function tickCountdowns() {
  const now = Date.now();
  document.querySelectorAll('[data-ends-at]').forEach(el => {
    const remaining = Math.max(0, Math.round((+el.dataset.endsAt - now) / 1000));
    el.textContent = fmt(remaining);
  });
}

async function loadAll() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const [summaryData, devicesData, resData] = await Promise.all([
      apiFetch('/admin/summary'),
      apiFetch('/admin/devices'),
      apiFetch(`/admin/reservations?from=${now}&to=${now + 86400}`), // next 24h
    ]);
    renderSummary(summaryData);
    renderDozers(devicesData.devices, resData.reservations);

    if (calendarActive) renderCalendar();

    const dot = document.getElementById('live-dot');
    dot.classList.add('live');
    document.getElementById('last-refresh').textContent =
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setTimeout(() => dot.classList.remove('live'), 700);
    setServerError(false);
  } catch {
    setServerError(true);
  }
}

function setServerError(on) {
  const banner = document.getElementById('server-error-banner');
  if (banner) banner.style.display = on ? 'flex' : 'none';
  if (on) {
    document.getElementById('live-dot').classList.remove('live');
    document.getElementById('last-refresh').textContent = 'Server unreachable';
  }
}

function renderSummary(d) {
  document.getElementById('s-online').textContent    = d.devices.total;
  document.getElementById('s-active').textContent    = d.sessions.active;
  document.getElementById('s-available').textContent = Math.max(0, d.devices.total - d.sessions.active);
}

function renderDozers(devices, reservations = []) {
  const active    = devices.filter(d => !!d.active_session_id);
  const available = devices.filter(d => !d.active_session_id);

  availableDevices = available;

  document.getElementById('active-count').textContent    = active.length;
  document.getElementById('available-count').textContent = available.length;

  renderActiveGrid(active);
  renderAvailableGrid(available, reservations);
}

// Deterministic dummy battery (mirrors server-side logic as a client fallback)
function dummyBattery(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return 45 + (h % 50);
}

function buildCardBase(d) {
  // Use real value if positive, otherwise fall back to deterministic dummy
  const bat      = (d.battery_pct > 0) ? d.battery_pct : dummyBattery(d.id);
  const isLowBat = bat < 15;
  const batPct   = bat.toFixed(0) + '%';
  const batFill  = Math.max(0, Math.min(100, bat));
  const batColor = batteryColor(bat);

  return { isLowBat, batPct, batFill, batColor };
}

function renderActiveGrid(active) {
  const grid = document.getElementById('active-grid');

  // Don't blow away cards that are showing an inline stop confirmation
  if (pendingStops.size > 0) return;

  if (!active.length) {
    grid.innerHTML = '<div class="empty">No dozers currently running.</div>';
    return;
  }

  const now = Date.now();

  grid.innerHTML = active.map(d => {
    const { batPct, batFill, batColor } = buildCardBase(d);

    // Record when this session ends so the tick can update it without a server call
    const endsAt = now + (d.seconds_remaining || 0) * 1000;
    sessionEndsAt[d.id] = endsAt;

    const hoursLabel = d.minutes_purchased
      ? (d.minutes_purchased / 60 % 1 === 0
          ? `${d.minutes_purchased / 60} hr`
          : `${(d.minutes_purchased / 60).toFixed(1)} hrs`)
      : '';

    return `
      <div class="dozer-card running">
        <div class="dozer-top">
          <div>
            <div class="dozer-name">${d.name || d.id}</div>
            <div class="dozer-loc">${d.id}${d.location ? ' &middot; ' + d.location : ''}</div>
          </div>
          <span class="status-pill pill-running">Running</span>
        </div>
        <div class="battery-row">
          <span class="key">Battery</span>
          <span style="color:${batColor};font-weight:600;font-size:0.82rem">${batPct} &middot; ${batLifeLabel(batFill)}</span>
        </div>
        <div class="battery-bar">
          <div class="battery-fill" style="width:${batFill}%;background:${batColor};"></div>
        </div>
        <div class="countdown-area">
          <div class="countdown-time" data-ends-at="${endsAt}">${fmt(d.seconds_remaining)}</div>
          <div class="countdown-label">${d.customer_name || 'Walk-in'}${hoursLabel ? ' &middot; ' + hoursLabel : ''}</div>
        </div>
        <button class="btn-add-time" data-session="${d.active_session_id}" data-device="${d.id}" data-name="${d.name || d.id}">+ Add Time</button>
        <button class="btn-stop" data-session="${d.active_session_id}" data-device="${d.id}">&#9632; Stop</button>
      </div>`;
  }).join('');

  grid.querySelectorAll('.btn-add-time').forEach(btn => {
    btn.addEventListener('click', () => openAddTimeModal(btn.dataset.session, btn.dataset.device, btn.dataset.name));
  });
  grid.querySelectorAll('.btn-stop').forEach(btn => {
    btn.addEventListener('click', () => confirmStop(btn.dataset.session, btn.dataset.device));
  });
}

function batLifeLabel(batPct) {
  const hrs = (batPct / 100) * 5;
  if (hrs < 0.5) return '< 30 min';
  if (hrs % 1 === 0) return `~${hrs} hr`;
  return `~${hrs.toFixed(1)} hrs`;
}

function renderAvailableGrid(available, reservations = []) {
  const grid = document.getElementById('available-grid');
  const now  = Math.floor(Date.now() / 1000);

  if (!available.length) {
    grid.innerHTML = '<div class="empty">No dozers available right now.</div>';
    return;
  }

  grid.innerHTML = available.map(d => {
    const { isLowBat, batPct, batFill, batColor } = buildCardBase(d);
    const bat = (d.battery_pct > 0) ? d.battery_pct : dummyBattery(d.id);

    let cardClass = 'dozer-card';
    let pillHtml  = '';
    if (isLowBat) {
      cardClass += ' low-bat';
      pillHtml = '<span class="status-pill pill-lowbat">Low Bat</span>';
    } else {
      cardClass += ' available';
      pillHtml = '<span class="status-pill pill-available">Available</span>';
    }

    // Upcoming reservation within next 24 h for this device
    const nextRes = reservations.find(r => r.device_id === d.id && r.starts_at > now);
    const resBadge = nextRes
      ? `<div class="upcoming-res">&#128197; Reserved ${new Date(nextRes.starts_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} &middot; ${nextRes.customer_name}</div>`
      : '';

    return `
      <div class="${cardClass}">
        <div class="dozer-top">
          <div>
            <div class="dozer-name">${d.name || d.id}</div>
            <div class="dozer-loc">${d.id}${d.location ? ' &middot; ' + d.location : ''}</div>
          </div>
          ${pillHtml}
        </div>
        <div class="battery-row">
          <span class="key">Battery</span>
          <span style="color:${batColor};font-weight:600;font-size:0.82rem">${batPct} &middot; ${batLifeLabel(bat)}</span>
        </div>
        <div class="battery-bar">
          <div class="battery-fill" style="width:${batFill}%;background:${batColor};"></div>
        </div>
        <div class="countdown-area">
          <div class="countdown-idle">Ready to assign</div>
          ${resBadge}
        </div>
      </div>`;
  }).join('');
}

// ── Stop All ──────────────────────────────────────────────────────────────────

document.getElementById('stop-all-btn').addEventListener('click', () => {
  document.getElementById('stop-all-modal').classList.add('open');
});
document.getElementById('stop-all-cancel').addEventListener('click', () => {
  document.getElementById('stop-all-modal').classList.remove('open');
});
document.getElementById('stop-all-confirm').addEventListener('click', stopAll);
document.getElementById('stop-all-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('stop-all-modal'))
    document.getElementById('stop-all-modal').classList.remove('open');
});

async function stopAll() {
  document.getElementById('stop-all-modal').classList.remove('open');
  try {
    const d = await apiFetch('/admin/sessions/stop-all', { method: 'POST' });
    if (d.stopped === 0) {
      toast('No active sessions to stop');
    } else {
      toast(`Stopped ${d.stopped} session${d.stopped !== 1 ? 's' : ''}`);
    }
    loadAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ── Stop (inline confirmation on card) ───────────────────────────────────────

function confirmStop(sessionId, deviceId) {
  const btn  = document.querySelector(`.btn-stop[data-session="${sessionId}"]`);
  if (!btn) return;
  const card = btn.closest('.dozer-card');
  const name = card?.querySelector('.dozer-name')?.textContent || deviceId;

  pendingStops.add(sessionId);

  const row = document.createElement('div');
  row.className = 'stop-confirm-row';
  row.innerHTML = `
    <button class="btn-stop-cancel">Cancel</button>
    <button class="btn-stop-confirm">Stop ${name}?</button>`;
  btn.replaceWith(row);

  row.querySelector('.btn-stop-cancel').addEventListener('click', () => {
    pendingStops.delete(sessionId);
    row.replaceWith(btn);
  });
  row.querySelector('.btn-stop-confirm').addEventListener('click', async () => {
    const confirmBtn = row.querySelector('.btn-stop-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Stopping\u2026';
    try {
      await apiFetch(`/admin/sessions/${sessionId}/stop`, { method: 'POST' });
      pendingStops.delete(sessionId);
      toast(`Session stopped on ${name}`);
      loadAll();
    } catch (e) {
      pendingStops.delete(sessionId);
      toast(e.message, 'error');
      row.replaceWith(btn);
    }
  });
}

// ── Modal ─────────────────────────────────────────────────────────────────────

// ── Customer state ────────────────────────────────────────────────────────────
let customerMode     = null;   // 'returner' | 'new' | 'guest'
let selectedCustomer = null;   // customer object for returner mode
let searchDebounce   = null;

document.getElementById('assign-btn').addEventListener('click', openModal);

function openModal() {
  customerMode     = null;
  selectedCustomer = null;
  dozerCount       = 1;
  selectedHours    = null;
  checkedDeviceIds = new Set();

  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('selected'));
  document.querySelectorAll('.cust-type-card').forEach(b => b.classList.remove('active'));

  document.getElementById('modal-overlay').classList.add('open');
  goToStep('type');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

function goToStep(name) {
  document.querySelectorAll('.modal-step').forEach(s => s.style.display = 'none');
  document.getElementById(`step-${name}`).style.display = 'block';
}

// ── Step: Customer Type ───────────────────────────────────────────────────────

document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

document.querySelectorAll('.cust-type-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.cust-type-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    customerMode = card.dataset.type;

    if (customerMode === 'returner') {
      document.getElementById('cust-search-input').value   = '';
      document.getElementById('cust-search-results').innerHTML = '';
      document.getElementById('cust-selected-card').style.display = 'none';
      document.getElementById('returner-error').textContent = '';
      selectedCustomer = null;
      document.getElementById('returner-continue').disabled = true;
      document.getElementById('returner-continue').style.opacity = '0.4';
      goToStep('returner');
    } else if (customerMode === 'new') {
      document.getElementById('nc-name').value  = '';
      document.getElementById('nc-email').value = '';
      document.getElementById('nc-phone').value = '';
      document.getElementById('nc-error').textContent = '';
      goToStep('new');
    } else {
      goToAssign();
    }
  });
});

// ── Step: Returner Search ─────────────────────────────────────────────────────

document.getElementById('cust-search-input').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  if (q.length < 2) {
    document.getElementById('cust-search-results').innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(() => searchCustomers(q), 300);
});

async function searchCustomers(q) {
  try {
    const data = await apiFetch(`/admin/customers/search?q=${encodeURIComponent(q)}`);
    renderSearchResults(data.customers);
  } catch {
    document.getElementById('cust-search-results').innerHTML =
      '<div style="color:var(--muted);font-size:0.82rem;padding:6px 0;">Search failed.</div>';
  }
}

function renderSearchResults(customers) {
  const el = document.getElementById('cust-search-results');
  if (!customers.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:0.82rem;padding:6px 0;">No customers found.</div>';
    return;
  }
  el.innerHTML = `<div class="cust-result-list">${customers.map(c => `
    <div class="cust-result-item" data-id="${c.id}">
      <div>
        <div class="cust-result-name">${c.name}</div>
        <div class="cust-result-meta">${c.email || ''}${c.phone ? ' · ' + c.phone : ''} · ${c.hours_remaining.toFixed(1)} hrs remaining</div>
      </div>
    </div>`).join('')}</div>`;
  el.querySelectorAll('.cust-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const c = customers.find(x => x.id === item.dataset.id);
      if (c) selectCustomer(c);
    });
  });
}

function selectCustomer(c) {
  selectedCustomer = c;
  document.getElementById('cust-search-results').innerHTML = '';

  const hrsClass = c.hours_remaining >= 1 ? 'hrs-ok' : c.hours_remaining > 0 ? 'hrs-low' : 'hrs-none';
  const hrsText  = c.hours_remaining > 0
    ? `${c.hours_remaining.toFixed(1)} hrs`
    : 'No balance';

  const card = document.getElementById('cust-selected-card');
  card.style.display = 'block';
  card.innerHTML = `
    <div class="cust-card">
      <div class="cust-card-name">${c.name}</div>
      <div class="cust-card-row"><span class="cust-card-label">Email</span><span class="cust-card-val">${c.email || '—'}</span></div>
      <div class="cust-card-row"><span class="cust-card-label">Phone</span><span class="cust-card-val">${c.phone || '—'}</span></div>
      <div class="cust-card-row"><span class="cust-card-label">Hours Remaining</span><span class="cust-card-val ${hrsClass}">${hrsText}</span></div>
      <div class="cust-card-row"><span class="cust-card-label">Total Played</span><span class="cust-card-val">${c.total_hours_played.toFixed(1)} hrs</span></div>
      <div class="cust-card-row"><span class="cust-card-label">Points</span><span class="cust-card-val">${c.points}</span></div>
    </div>`;

  const continueBtn = document.getElementById('returner-continue');
  continueBtn.disabled     = false;
  continueBtn.style.opacity = '1';
}

document.getElementById('returner-back').addEventListener('click', () => goToStep('type'));
document.getElementById('returner-continue').addEventListener('click', () => {
  if (!selectedCustomer) return;
  goToAssign();
});

// ── Step: New Customer ────────────────────────────────────────────────────────

document.getElementById('new-back').addEventListener('click', () => goToStep('type'));
document.getElementById('new-continue').addEventListener('click', () => {
  const name  = document.getElementById('nc-name').value.trim();
  const email = document.getElementById('nc-email').value.trim();
  if (!name)  { document.getElementById('nc-error').textContent = 'Name is required.';  return; }
  if (!email) { document.getElementById('nc-error').textContent = 'Email is required.'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('nc-error').textContent = 'Enter a valid email.';
    return;
  }
  document.getElementById('nc-error').textContent = '';
  goToAssign();
});

// ── Step: Assign ─────────────────────────────────────────────────────────────

function goToAssign() {
  // Reset assign-step state
  dozerCount   = 1;
  selectedHours = null;
  checkedDeviceIds = new Set();
  document.getElementById('dozer-count-display').value = 1;
  document.getElementById('custom-hours').value         = '';
  document.getElementById('modal-error').textContent    = '';
  document.querySelectorAll('#time-presets .preset-btn').forEach(b => b.classList.remove('selected'));

  // Show context banner
  const banner = document.getElementById('cust-context-banner');
  if (customerMode === 'returner' && selectedCustomer) {
    const hasHrs = selectedCustomer.hours_remaining > 0;
    banner.className = 'cust-context-banner mode-returner';
    banner.style.display = 'flex';
    banner.textContent = hasHrs
      ? `${selectedCustomer.name} · ${selectedCustomer.hours_remaining.toFixed(1)} hrs in account`
      : `${selectedCustomer.name} · No remaining balance`;
  } else if (customerMode === 'new') {
    banner.className = 'cust-context-banner mode-new';
    banner.style.display = 'flex';
    banner.textContent = `New customer: ${document.getElementById('nc-name').value.trim()}`;
  } else {
    banner.className = 'cust-context-banner mode-guest';
    banner.style.display = 'flex';
    banner.textContent = 'Guest session — no customer profile';
  }

  renderPicker();
  updateStepperButtons();
  goToStep('assign');
}

document.getElementById('assign-back').addEventListener('click', () => {
  if (customerMode === 'returner') goToStep('returner');
  else if (customerMode === 'new') goToStep('new');
  else goToStep('type');
});

function renderPicker() {
  const picker = document.getElementById('dozer-picker');
  if (!availableDevices.length) {
    picker.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;padding:8px 0;">No available dozers right now.</div>';
    return;
  }
  picker.innerHTML = availableDevices.map(d => {
    const bat     = (d.battery_pct > 0) ? d.battery_pct : dummyBattery(d.id);
    const batPct  = bat.toFixed(0) + '%';
    const batColor = batteryColor(bat);
    const checked = checkedDeviceIds.has(d.id);
    return `
      <div class="picker-item${checked ? ' checked' : ''}" data-device="${d.id}">
        <div class="picker-check"><span class="picker-check-mark">&#10003;</span></div>
        <div class="picker-info">
          <div class="picker-name">${d.name || d.id}</div>
          <div class="picker-bat">Battery: <span style="color:${batColor}">${batPct}</span></div>
        </div>
      </div>`;
  }).join('');
  picker.querySelectorAll('.picker-item').forEach(item => {
    item.addEventListener('click', () => togglePickerItem(item.dataset.device));
  });
}

function togglePickerItem(deviceId) {
  if (checkedDeviceIds.has(deviceId)) { checkedDeviceIds.delete(deviceId); }
  else { checkedDeviceIds.add(deviceId); }
  dozerCount = checkedDeviceIds.size || 1;
  document.getElementById('dozer-count-display').value = checkedDeviceIds.size;
  updateStepperButtons();
  renderPicker();
}

function autoSelectDozers(n) {
  checkedDeviceIds = new Set();
  availableDevices.slice(0, n).forEach(d => checkedDeviceIds.add(d.id));
  renderPicker();
}

function updateStepperButtons() {
  document.getElementById('count-minus').disabled = dozerCount <= 1;
  document.getElementById('count-plus').disabled  = dozerCount >= availableDevices.length;
}

document.getElementById('count-minus').addEventListener('click', () => {
  if (dozerCount > 1) { dozerCount--; document.getElementById('dozer-count-display').value = dozerCount; autoSelectDozers(dozerCount); updateStepperButtons(); }
});
document.getElementById('count-plus').addEventListener('click', () => {
  if (dozerCount < availableDevices.length) { dozerCount++; document.getElementById('dozer-count-display').value = dozerCount; autoSelectDozers(dozerCount); updateStepperButtons(); }
});

document.getElementById('time-presets').addEventListener('click', e => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  document.querySelectorAll('#time-presets .preset-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedHours = parseFloat(btn.dataset.hrs);
  document.getElementById('custom-hours').value = '';
  document.getElementById('modal-error').textContent = '';
});

document.getElementById('custom-hours').addEventListener('input', () => {
  document.querySelectorAll('#time-presets .preset-btn').forEach(b => b.classList.remove('selected'));
  selectedHours = null;
  document.getElementById('modal-error').textContent = '';
});

document.getElementById('modal-confirm').addEventListener('click', startSessions);

// ── Start (bulk) ──────────────────────────────────────────────────────────────

async function startSessions() {
  const customVal = document.getElementById('custom-hours').value.trim();
  const hours     = selectedHours ?? (customVal ? parseFloat(customVal) : null);

  if (!hours || isNaN(hours) || hours <= 0) {
    document.getElementById('modal-error').textContent = 'Please select or enter a duration.';
    return;
  }
  const selected = [...checkedDeviceIds];
  if (!selected.length) {
    document.getElementById('modal-error').textContent = 'Please select at least one dozer.';
    return;
  }

  const minutes = Math.round(hours * 60);
  const btn     = document.getElementById('modal-confirm');
  btn.disabled  = true;
  btn.textContent = 'Starting\u2026';

  // Resolve customer_id for registered customers
  let customerId   = null;
  let customerName = null;

  if (customerMode === 'new') {
    // Create the customer record now
    try {
      const data = await apiFetch('/admin/customers', {
        method: 'POST',
        body: JSON.stringify({
          name:  document.getElementById('nc-name').value.trim(),
          email: document.getElementById('nc-email').value.trim(),
          phone: document.getElementById('nc-phone').value.trim() || undefined,
        }),
      });
      customerId   = data.customer.id;
      customerName = data.customer.name;
    } catch (e) {
      document.getElementById('modal-error').textContent = e.message;
      btn.disabled    = false;
      btn.textContent = '\u25b6 Start Dozers';
      return;
    }
  } else if (customerMode === 'returner' && selectedCustomer) {
    customerId   = selectedCustomer.id;
    customerName = selectedCustomer.name;
  }

  const results = await Promise.allSettled(
    selected.map(deviceId =>
      apiFetch(`/admin/devices/${deviceId}/start-timed`, {
        method: 'POST',
        body: JSON.stringify({
          minutes,
          ...(customerId   ? { customer_id:   customerId }   : {}),
          ...(customerName ? { customer_name: customerName } : {}),
        }),
      })
    )
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;
  btn.disabled    = false;
  btn.textContent = '\u25b6 Start Dozers';

  if (succeeded > 0) {
    closeModal();
    const hrLabel = hours % 1 === 0 ? `${hours} hr` : `${hours} hrs`;
    toast(
      `${succeeded} dozer${succeeded !== 1 ? 's' : ''} started \u2014 ${hrLabel}` +
      (failed ? ` (${failed} failed)` : ''),
      failed ? 'error' : 'success'
    );
    loadAll();
  } else {
    const firstErr = results.find(r => r.status === 'rejected')?.reason?.message || 'Unknown error';
    document.getElementById('modal-error').textContent = firstErr;
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeAddTimeModal(); closeCalDetail(); }
  if (e.key === 'Enter' && document.getElementById('add-time-overlay').classList.contains('open')) {
    const focused = document.activeElement;
    if (!focused || focused.tagName !== 'BUTTON') confirmAddTime();
  }
});

// ── Add Time modal ────────────────────────────────────────────────────────────

let addTimeSessionId = null;
let addTimeDeviceId  = null;
let addTimeHours     = null;

function openAddTimeModal(sessionId, deviceId, name) {
  addTimeSessionId = sessionId;
  addTimeDeviceId  = deviceId;
  addTimeHours     = null;

  document.getElementById('add-time-sub').textContent   = `Extend the session on ${name}`;
  document.getElementById('add-time-custom').value      = '';
  document.getElementById('add-time-error').textContent = '';
  document.querySelectorAll('#add-time-presets .preset-btn').forEach(b => b.classList.remove('selected'));

  document.getElementById('add-time-overlay').classList.add('open');
}

function closeAddTimeModal() {
  document.getElementById('add-time-overlay').classList.remove('open');
  addTimeSessionId = null;
  addTimeDeviceId  = null;
  addTimeHours     = null;
}

document.getElementById('add-time-presets').addEventListener('click', e => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  document.querySelectorAll('#add-time-presets .preset-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  addTimeHours = parseFloat(btn.dataset.hrs);
  document.getElementById('add-time-custom').value      = '';
  document.getElementById('add-time-error').textContent = '';
});

document.getElementById('add-time-custom').addEventListener('input', () => {
  document.querySelectorAll('#add-time-presets .preset-btn').forEach(b => b.classList.remove('selected'));
  addTimeHours = null;
  document.getElementById('add-time-error').textContent = '';
});

document.getElementById('add-time-cancel').addEventListener('click', closeAddTimeModal);
document.getElementById('add-time-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('add-time-overlay')) closeAddTimeModal();
});
document.getElementById('add-time-confirm').addEventListener('click', confirmAddTime);

async function confirmAddTime() {
  const customVal = document.getElementById('add-time-custom').value.trim();
  const hours = addTimeHours ?? (customVal ? parseFloat(customVal) : null);

  if (!hours || isNaN(hours) || hours <= 0) {
    document.getElementById('add-time-error').textContent = 'Please select or enter a duration.';
    return;
  }

  const minutes = Math.round(hours * 60);
  const btn     = document.getElementById('add-time-confirm');
  btn.disabled  = true;
  btn.textContent = 'Adding\u2026';

  try {
    const data = await apiFetch(`/admin/sessions/${addTimeSessionId}/add-time`, {
      method: 'POST',
      body: JSON.stringify({ minutes }),
    });

    // Update the client-side end timestamp immediately so the countdown jumps
    if (addTimeDeviceId) {
      const el = document.querySelector(`[data-ends-at]`);
      // Find the countdown element for this device's card
      const card = document.querySelector(`.btn-stop[data-session="${addTimeSessionId}"]`)?.closest('.dozer-card');
      const countdownEl = card?.querySelector('[data-ends-at]');
      if (countdownEl) {
        const newEndsAt = Date.now() + data.new_seconds_remaining * 1000;
        countdownEl.dataset.endsAt = newEndsAt;
      }
    }

    const hrLabel = hours % 1 === 0 ? `${hours} hr` : `${hours} hrs`;
    closeAddTimeModal();
    toast(`Added ${hrLabel} to session`);
    loadAll();
  } catch (e) {
    document.getElementById('add-time-error').textContent = e.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = '+ Add Time';
  }
}

// ── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    calendarActive = (tab === 'calendar');
    document.getElementById('tab-dashboard').style.display = calendarActive ? 'none' : 'block';
    document.getElementById('tab-calendar').style.display  = calendarActive ? 'block' : 'none';
    if (calendarActive) renderCalendar();
  });
});

// ── Calendar ──────────────────────────────────────────────────────────────────

document.getElementById('cal-prev').addEventListener('click', () => {
  calView === 'week' ? (calDate = addDays(calDate, -7)) : (calDate = addDays(calDate, -1));
  renderCalendar();
});
document.getElementById('cal-next').addEventListener('click', () => {
  calView === 'week' ? (calDate = addDays(calDate, 7)) : (calDate = addDays(calDate, 1));
  renderCalendar();
});
document.getElementById('cal-today').addEventListener('click', () => {
  calDate = new Date(); renderCalendar();
});
document.querySelectorAll('.cal-view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cal-view-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    calView = btn.dataset.view;
    renderCalendar();
  });
});

function addDays(d, n) {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}

function dayStart(d) {
  const r = new Date(d); r.setHours(0, 0, 0, 0); return r;
}

function fmtDate(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

async function renderCalendar() {
  const wrap = document.getElementById('cal-grid-wrap');
  wrap.innerHTML = '<div class="empty">Loading…</div>';

  let fromTs, toTs;
  if (calView === 'day') {
    const s = dayStart(calDate);
    fromTs = Math.floor(s.getTime() / 1000);
    toTs   = fromTs + 86400;
    document.getElementById('cal-range-label').textContent = fmtDate(calDate);
  } else {
    const s = dayStart(calDate);
    s.setDate(s.getDate() - s.getDay()); // start of week (Sun)
    fromTs = Math.floor(s.getTime() / 1000);
    toTs   = fromTs + 7 * 86400;
    const eDate = new Date((toTs - 1) * 1000);
    document.getElementById('cal-range-label').textContent =
      `${fmtDate(s)} – ${fmtDate(eDate)}`;
  }

  try {
    const [devData, resData, sesData] = await Promise.all([
      apiFetch('/admin/devices'),
      apiFetch(`/admin/reservations?from=${fromTs}&to=${toTs}`),
      apiFetch(`/admin/sessions?from=${fromTs}&to=${toTs}&limit=500`),
    ]);

    if (calView === 'day') {
      renderDayView(wrap, devData.devices, resData.reservations, sesData.sessions, fromTs);
    } else {
      renderWeekView(wrap, devData.devices, resData.reservations, sesData.sessions, fromTs);
    }
  } catch (e) {
    wrap.innerHTML = `<div class="empty">Failed to load calendar: ${e.message}</div>`;
  }
}

const CAL_START_H = 8;   // 8 am
const CAL_END_H   = 20;  // 8 pm
const SLOT_MINS   = 30;
const SLOTS       = ((CAL_END_H - CAL_START_H) * 60) / SLOT_MINS;

function renderDayView(wrap, devices, reservations, sessions, dayStartTs) {
  const slotWidth = 64; // px per 30-min slot
  const labelW    = 130;
  const totalW    = labelW + SLOTS * slotWidth;

  // Build hour labels row
  let headerCells = `<div class="cal-label" style="width:${labelW}px;min-width:${labelW}px;"></div>`;
  for (let i = 0; i < SLOTS; i++) {
    const mins  = (CAL_START_H * 60) + i * SLOT_MINS;
    const hh    = Math.floor(mins / 60);
    const mm    = mins % 60;
    const label = mm === 0 ? `${hh % 12 || 12}${hh < 12 ? 'am' : 'pm'}` : '';
    headerCells += `<div class="cal-slot" style="width:${slotWidth}px;min-width:${slotWidth}px;"><div class="cal-slot-hour">${label}</div></div>`;
  }

  let rows = `<div class="cal-header-row" style="grid-template-columns:${labelW}px repeat(${SLOTS},${slotWidth}px);">${headerCells}</div>`;

  for (const dev of devices) {
    const devRes = reservations.filter(r => r.device_id === dev.id);
    const devSes = sessions.filter(s => s.device_id === dev.id);

    // Build events as absolutely-positioned spans inside the slots container
    let events = '';
    const renderEvent = (startsAt, endsAt, cls, label, obj) => {
      const dayOffsetMins = Math.max(0, (startsAt - dayStartTs) / 60 - CAL_START_H * 60);
      const durMins       = Math.min((endsAt - startsAt) / 60, (CAL_END_H - CAL_START_H) * 60 - dayOffsetMins);
      if (durMins <= 0) return;
      const left  = (dayOffsetMins / SLOT_MINS) * slotWidth;
      const width = (durMins / SLOT_MINS) * slotWidth - 2;
      const key   = `${cls}:${obj.id}`;
      calEventMap.set(key, { type: cls, obj, deviceName: dev.name || dev.id });
      events += `<div class="cal-event ${cls}" data-cal-key="${key}" style="left:${left}px;width:${width}px;">${label}</div>`;
    };

    devRes.forEach(r => renderEvent(r.starts_at, r.ends_at, 'reservation', `&#128197; ${r.customer_name}`, r));
    devSes.forEach(s => {
      const endTs = s.started_at + s.minutes_purchased * 60;
      renderEvent(s.started_at || dayStartTs, endTs, 'session', `&#9654; ${s.customer_name || 'Session'}`, s);
    });

    rows += `
      <div class="cal-device-row" style="grid-template-columns:${labelW}px 1fr;">
        <div class="cal-label"><div class="cal-device-name">${dev.name || dev.id}</div></div>
        <div class="cal-slots-wrap" style="position:relative;width:${SLOTS * slotWidth}px;">
          ${Array.from({length: SLOTS}, (_, i) =>
            `<div class="cal-slot" style="width:${slotWidth}px;min-width:${slotWidth}px;"></div>`
          ).join('')}
          ${events}
        </div>
      </div>`;
  }

  wrap.innerHTML = `<div class="cal-grid"><div class="cal-inner" style="width:${totalW}px;">${rows}</div></div>`;
  wrap.querySelectorAll('[data-cal-key]').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); openCalDetail(el.dataset.calKey); });
  });
}

function renderWeekView(wrap, devices, reservations, sessions, weekStartTs) {
  const days = Array.from({length: 7}, (_, i) => weekStartTs + i * 86400);
  const todayMidnight = Math.floor(dayStart(new Date()).getTime() / 1000);

  let html = '<div class="cal-week-grid">';

  // Header row: empty corner + 7 day labels
  html += '<div class="cal-week-header" style="border-right:1px solid var(--border);"></div>';
  days.forEach(ts => {
    const d = new Date(ts * 1000);
    const isToday = ts === todayMidnight;
    html += `<div class="cal-week-header${isToday ? ' today' : ''}">${d.toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'})}</div>`;
  });

  // Device rows
  for (const dev of devices) {
    html += `<div class="cal-week-device">${dev.name || dev.id}</div>`;
    days.forEach(dayTs => {
      const dayEnd = dayTs + 86400;
      const devRes = reservations.filter(r => r.device_id === dev.id && r.starts_at < dayEnd && r.ends_at > dayTs);
      const devSes = sessions.filter(s => {
        const endTs = (s.started_at || 0) + s.minutes_purchased * 60;
        return s.device_id === dev.id && (s.started_at || 0) < dayEnd && endTs > dayTs;
      });
      let pills = '';
      devSes.forEach(s => {
        const key = `session:${s.id}`;
        calEventMap.set(key, { type: 'session', obj: s, deviceName: dev.name || dev.id });
        pills += `<div class="cal-event-pill session" data-cal-key="${key}">&#9654; ${s.customer_name || 'Session'}</div>`;
      });
      devRes.forEach(r => {
        const t = new Date(r.starts_at * 1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
        const key = `reservation:${r.id}`;
        calEventMap.set(key, { type: 'reservation', obj: r, deviceName: dev.name || dev.id });
        pills += `<div class="cal-event-pill reservation" data-cal-key="${key}">&#128197; ${t} ${r.customer_name}</div>`;
      });
      html += `<div class="cal-week-cell">${pills || ''}</div>`;
    });
  }

  html += '</div>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('[data-cal-key]').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); openCalDetail(el.dataset.calKey); });
  });
}

// ── Calendar detail modal ────────────────────────────────────────────────────

const calEventMap = new Map();

function openCalDetail(key) {
  const entry = calEventMap.get(key);
  if (!entry) return;
  const { type, obj, deviceName } = entry;

  const badge = document.getElementById('cal-detail-badge');
  badge.className = `cal-detail-badge ${type}`;
  badge.textContent = type === 'session' ? 'Session' : 'Reservation';

  const title = document.getElementById('cal-detail-title');
  title.textContent = obj.customer_name || (type === 'session' ? 'Walk-in' : 'Staff Hold');

  const rows = document.getElementById('cal-detail-rows');
  const fmtTs = ts => ts
    ? new Date(ts * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  if (type === 'session') {
    const endTs = (obj.started_at || 0) + obj.minutes_purchased * 60;
    const hrs   = (obj.minutes_purchased / 60 % 1 === 0)
      ? `${obj.minutes_purchased / 60} hr`
      : `${(obj.minutes_purchased / 60).toFixed(1)} hrs`;
    rows.innerHTML = `
      <div class="cal-detail-row"><span class="key">Dozer</span><span class="val">${deviceName}</span></div>
      <div class="cal-detail-row"><span class="key">Started</span><span class="val">${fmtTs(obj.started_at)}</span></div>
      <div class="cal-detail-row"><span class="key">Duration</span><span class="val">${hrs}</span></div>
      <div class="cal-detail-row"><span class="key">Ends at</span><span class="val">${fmtTs(endTs)}</span></div>
      <div class="cal-detail-row"><span class="key">Status</span><span class="val">${obj.status}</span></div>`;
  } else {
    const hrs = ((obj.ends_at - obj.starts_at) / 3600 % 1 === 0)
      ? `${(obj.ends_at - obj.starts_at) / 3600} hr`
      : `${((obj.ends_at - obj.starts_at) / 3600).toFixed(1)} hrs`;
    rows.innerHTML = `
      <div class="cal-detail-row"><span class="key">Dozer</span><span class="val">${deviceName}</span></div>
      <div class="cal-detail-row"><span class="key">Start</span><span class="val">${fmtTs(obj.starts_at)}</span></div>
      <div class="cal-detail-row"><span class="key">End</span><span class="val">${fmtTs(obj.ends_at)}</span></div>
      <div class="cal-detail-row"><span class="key">Duration</span><span class="val">${hrs}</span></div>
      ${obj.note ? `<div class="cal-detail-row"><span class="key">Note</span><span class="val">${obj.note}</span></div>` : ''}`;
  }

  const actions = document.getElementById('cal-detail-actions');
  actions.innerHTML = '';

  if (type === 'session' && obj.status === 'active') {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-confirm';
    addBtn.style.cssText = 'background:var(--blue);color:#fff;';
    addBtn.textContent = '+ Add Time';
    addBtn.addEventListener('click', () => {
      closeCalDetail();
      openAddTimeModal(obj.id, obj.device_id, deviceName);
    });

    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn-cancel';
    stopBtn.style.cssText = 'color:var(--red);border-color:rgba(239,68,68,0.3);';
    stopBtn.textContent = '⬛ Stop';
    stopBtn.addEventListener('click', () => calDetailStop(obj.id, deviceName, stopBtn));

    actions.appendChild(addBtn);
    actions.appendChild(stopBtn);
  } else if (type === 'reservation' && obj.status === 'active') {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel';
    cancelBtn.style.cssText = 'color:var(--red);border-color:rgba(239,68,68,0.3);';
    cancelBtn.textContent = 'Cancel Reservation';
    cancelBtn.addEventListener('click', () => calDetailCancelRes(obj.id, cancelBtn));
    actions.appendChild(cancelBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-cancel';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeCalDetail);
  actions.appendChild(closeBtn);

  document.getElementById('cal-detail-modal').classList.add('open');
}

function closeCalDetail() {
  document.getElementById('cal-detail-modal').classList.remove('open');
}

document.getElementById('cal-detail-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('cal-detail-modal')) closeCalDetail();
});

async function calDetailStop(sessionId, deviceName, btn) {
  if (btn.dataset.confirming) {
    btn.disabled = true;
    btn.textContent = 'Stopping…';
    try {
      await apiFetch(`/admin/sessions/${sessionId}/stop`, { method: 'POST' });
      closeCalDetail();
      toast(`Session stopped on ${deviceName}`);
      loadAll();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = '⬛ Stop';
      delete btn.dataset.confirming;
    }
  } else {
    btn.dataset.confirming = '1';
    btn.textContent = 'Confirm stop?';
    btn.style.background = 'rgba(239,68,68,0.15)';
  }
}

async function calDetailCancelRes(resId, btn) {
  if (btn.dataset.confirming) {
    btn.disabled = true;
    btn.textContent = 'Cancelling…';
    try {
      await apiFetch(`/admin/reservations/${resId}`, { method: 'DELETE' });
      closeCalDetail();
      toast('Reservation cancelled');
      loadAll();
      if (calendarActive) renderCalendar();
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Cancel Reservation';
      delete btn.dataset.confirming;
    }
  } else {
    btn.dataset.confirming = '1';
    btn.textContent = 'Confirm cancel?';
    btn.style.background = 'rgba(239,68,68,0.15)';
  }
}

// ── Reserve Modal ─────────────────────────────────────────────────────────────

let resHours        = null;
let resCheckedIds   = new Set();

document.getElementById('reserve-btn').addEventListener('click', openReserveModal);

function openReserveModal() {
  resHours      = null;
  resCheckedIds = new Set();

  // Default date = today, time = next round hour
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);

  document.getElementById('res-date').value   = now.toISOString().slice(0, 10);
  document.getElementById('res-time').value   = nextHour.toTimeString().slice(0, 5);
  document.getElementById('res-dur-custom').value = '';
  document.getElementById('res-customer-name').value = '';
  document.getElementById('res-note').value   = '';
  document.getElementById('res-when-error').textContent   = '';
  document.getElementById('res-dozers-error').textContent = '';
  document.getElementById('res-info-error').textContent   = '';
  document.querySelectorAll('#res-dur-presets .preset-btn').forEach(b => b.classList.remove('selected'));

  document.querySelectorAll('#reserve-modal .modal-step').forEach(s => s.style.display = 'none');
  document.getElementById('step-r-when').style.display = 'block';
  document.getElementById('reserve-modal').classList.add('open');
}

function closeReserveModal() {
  document.getElementById('reserve-modal').classList.remove('open');
}

document.getElementById('res-cancel').addEventListener('click', closeReserveModal);
document.getElementById('reserve-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('reserve-modal')) closeReserveModal();
});

// Duration presets
document.getElementById('res-dur-presets').addEventListener('click', e => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  document.querySelectorAll('#res-dur-presets .preset-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  resHours = parseFloat(btn.dataset.hrs);
  document.getElementById('res-dur-custom').value = '';
  document.getElementById('res-when-error').textContent = '';
});
document.getElementById('res-dur-custom').addEventListener('input', () => {
  document.querySelectorAll('#res-dur-presets .preset-btn').forEach(b => b.classList.remove('selected'));
  resHours = null;
  document.getElementById('res-when-error').textContent = '';
});

// Step R1 → R2
document.getElementById('res-when-next').addEventListener('click', async () => {
  const dateVal = document.getElementById('res-date').value;
  const timeVal = document.getElementById('res-time').value;
  const customDur = document.getElementById('res-dur-custom').value.trim();
  const hours = resHours ?? (customDur ? parseFloat(customDur) : null);

  if (!dateVal || !timeVal) { document.getElementById('res-when-error').textContent = 'Date and time are required.'; return; }
  if (!hours || hours <= 0) { document.getElementById('res-when-error').textContent = 'Please select a duration.'; return; }
  document.getElementById('res-when-error').textContent = '';

  const startsAt = Math.floor(new Date(`${dateVal}T${timeVal}`).getTime() / 1000);
  const endsAt   = startsAt + Math.round(hours * 3600);

  // Build dozer picker with conflict awareness
  const hrLabel = hours % 1 === 0 ? `${hours} hr` : `${hours} hrs`;
  document.getElementById('res-dozers-sub').textContent =
    `${new Date(startsAt * 1000).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'})} · ${new Date(startsAt*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} for ${hrLabel}`;

  // Fetch existing conflicts for these times
  let conflicts = [];
  try {
    const data = await apiFetch(`/admin/reservations?from=${startsAt}&to=${endsAt}`);
    conflicts = data.reservations.map(r => r.device_id);
  } catch {}

  const picker = document.getElementById('res-dozer-picker');
  const allDevices = [...availableDevices]; // visible available devices

  // Also include all devices (some may be active) — fetch if needed
  let devData;
  try { devData = await apiFetch('/admin/devices'); } catch { devData = { devices: allDevices }; }

  picker.innerHTML = devData.devices.map(d => {
    const isConflict = conflicts.includes(d.id);
    const bat     = (d.battery_pct > 0) ? d.battery_pct : dummyBattery(d.id);
    const batColor = batteryColor(bat);
    const checked  = resCheckedIds.has(d.id);
    return `
      <div class="picker-item${checked ? ' checked' : ''}${isConflict ? ' conflict' : ''}" data-device="${d.id}" ${isConflict ? 'style="opacity:0.4;pointer-events:none;"' : ''}>
        <div class="picker-check"><span class="picker-check-mark">&#10003;</span></div>
        <div class="picker-info">
          <div class="picker-name">${d.name || d.id}${isConflict ? ' <span style="color:var(--red);font-size:0.7rem;">(Conflict)</span>' : ''}</div>
          <div class="picker-bat">Battery: <span style="color:${batColor}">${bat.toFixed(0)}%</span></div>
        </div>
      </div>`;
  }).join('');

  picker.querySelectorAll('.picker-item:not(.conflict)').forEach(item => {
    item.addEventListener('click', () => {
      if (resCheckedIds.has(item.dataset.device)) { resCheckedIds.delete(item.dataset.device); item.classList.remove('checked'); }
      else { resCheckedIds.add(item.dataset.device); item.classList.add('checked'); }
    });
  });

  document.querySelectorAll('#reserve-modal .modal-step').forEach(s => s.style.display = 'none');
  document.getElementById('step-r-dozers').style.display = 'block';
});

document.getElementById('res-dozers-back').addEventListener('click', () => {
  document.querySelectorAll('#reserve-modal .modal-step').forEach(s => s.style.display = 'none');
  document.getElementById('step-r-when').style.display = 'block';
});

// Step R2 → R3
document.getElementById('res-dozers-next').addEventListener('click', () => {
  if (!resCheckedIds.size) {
    document.getElementById('res-dozers-error').textContent = 'Please select at least one dozer.';
    return;
  }
  document.getElementById('res-dozers-error').textContent = '';
  document.querySelectorAll('#reserve-modal .modal-step').forEach(s => s.style.display = 'none');
  document.getElementById('step-r-info').style.display = 'block';
});

document.getElementById('res-info-back').addEventListener('click', () => {
  document.querySelectorAll('#reserve-modal .modal-step').forEach(s => s.style.display = 'none');
  document.getElementById('step-r-dozers').style.display = 'block';
});

// Step R3 → Submit
document.getElementById('res-confirm').addEventListener('click', async () => {
  const dateVal   = document.getElementById('res-date').value;
  const timeVal   = document.getElementById('res-time').value;
  const customDur = document.getElementById('res-dur-custom').value.trim();
  const hours     = resHours ?? (customDur ? parseFloat(customDur) : null);
  const startsAt  = Math.floor(new Date(`${dateVal}T${timeVal}`).getTime() / 1000);
  const endsAt    = startsAt + Math.round(hours * 3600);

  const custName = document.getElementById('res-customer-name').value.trim() || 'Staff Hold';
  const note     = document.getElementById('res-note').value.trim() || undefined;
  const btn      = document.getElementById('res-confirm');
  btn.disabled   = true;
  btn.textContent = 'Reserving\u2026';

  try {
    await apiFetch('/admin/reservations', {
      method: 'POST',
      body: JSON.stringify({
        device_ids:    [...resCheckedIds],
        starts_at:     startsAt,
        ends_at:       endsAt,
        customer_name: custName,
        note,
      }),
    });
    const hrLabel = hours % 1 === 0 ? `${hours} hr` : `${hours} hrs`;
    closeReserveModal();
    toast(`${resCheckedIds.size} dozer${resCheckedIds.size !== 1 ? 's' : ''} reserved — ${hrLabel}`);
    loadAll();
    if (calendarActive) renderCalendar();
  } catch (e) {
    document.getElementById('res-info-error').textContent = e.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = '&#128197; Reserve';
  }
});
