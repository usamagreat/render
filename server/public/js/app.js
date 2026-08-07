/**
 * app.js — Main dashboard application logic.
 */

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    devices: {},        // deviceId → device object
    activeDeviceId: null,
    feedItems: [],      // live feed log
};

// ── WebSocket Message Handler ─────────────────────────────────────────────────
function handleServerMessage(msg) {
    switch (msg.type) {
        case 'devices_list':
            msg.devices.forEach(d => {
                state.devices[d.id] = d;
            });
            renderDeviceList();
            break;

        case 'device_online':
            if (state.devices[msg.device_id]) {
                state.devices[msg.device_id].is_online = 1;
                renderDeviceList();
                if (state.activeDeviceId === msg.device_id) updateOnlineBadge(true);
            }
            break;

        case 'device_offline':
            if (state.devices[msg.device_id]) {
                state.devices[msg.device_id].is_online = 0;
                renderDeviceList();
                if (state.activeDeviceId === msg.device_id) updateOnlineBadge(false);
            }
            break;

        case 'device_update':
            if (state.devices[msg.device_id]) {
                state.devices[msg.device_id].state = msg.state;
                if (state.activeDeviceId === msg.device_id) {
                    updateDashboardState(msg.state);
                    appendFeedItem(msg.state);
                }
                updateDeviceListItem(msg.device_id);
            }
            break;

        case 'command_issued':
            if (msg.device_id === state.activeDeviceId) {
                appendCommandLog(msg.command.type, 'pending');
            }
            break;

        case 'command_done':
            appendCommandLog('Done', 'success');
            if (msg.files) {
                renderStorageList(msg.files);
            }
            if (msg.url) {
                window.open(msg.url, '_blank');
                showToast('Download started');
            }
            break;

        case 'webrtc_answer':
            handleWebRTCAnswer(msg);
            break;

        case 'webrtc_ice':
            handleWebRTCIce(msg);
            break;
    }
}

// ── Render Device Sidebar ─────────────────────────────────────────────────────
function renderDeviceList() {
    const list = document.getElementById('deviceList');
    const empty = document.getElementById('deviceListEmpty');
    const devices = Object.values(state.devices);

    if (devices.length === 0) {
        empty.style.display = '';
        return;
    }
    empty.style.display = 'none';

    const existing = list.querySelectorAll('.device-item');
    existing.forEach(e => e.remove());

    devices.forEach(device => {
        const item = document.createElement('div');
        item.className = `device-item ${device.id === state.activeDeviceId ? 'active' : ''}`;
        item.id = `device-item-${device.id}`;
        item.onclick = () => selectDevice(device.id);

        const online = device.is_online === 1;
        const battery = device.battery_level != null ? `${device.battery_level}%` : '';
        const lastApp = device.last_app_name ? device.last_app_name : '';

        item.innerHTML = `
            <div class="device-item-icon">📱</div>
            <div class="device-item-info">
                <div class="device-item-name">${escHtml(device.name)}</div>
                <div class="device-item-sub">${lastApp || battery || (online ? 'Active' : 'Offline')}</div>
            </div>
            <div class="device-item-dot ${online ? 'dot-online' : 'dot-offline'}"></div>
        `;
        list.appendChild(item);
    });
}

function updateDeviceListItem(deviceId) {
    const device = state.devices[deviceId];
    if (!device) return;
    const item = document.getElementById(`device-item-${deviceId}`);
    if (!item) { renderDeviceList(); return; }
    const sub = item.querySelector('.device-item-sub');
    const dot = item.querySelector('.device-item-dot');
    if (sub) sub.textContent = device.state?.last_app_name || device.state?.battery_level + '%' || '';
    if (dot) dot.className = `device-item-dot ${device.is_online ? 'dot-online' : 'dot-offline'}`;
}

// ── Select Device ─────────────────────────────────────────────────────────────
async function selectDevice(deviceId) {
    state.activeDeviceId = deviceId;
    state.feedItems = [];

    // Update sidebar active state
    document.querySelectorAll('.device-item').forEach(el => el.classList.remove('active'));
    const item = document.getElementById(`device-item-${deviceId}`);
    if (item) item.classList.add('active');

    // Show dashboard
    document.getElementById('welcomeScreen').classList.add('hidden');
    document.getElementById('deviceDashboard').classList.remove('hidden');

    const device = state.devices[deviceId];
    if (!device) return;

    // Set header info
    document.getElementById('dashDeviceName').textContent = device.name;
    document.getElementById('dashModel').textContent = [device.brand, device.model].filter(Boolean).join(' ') || '—';
    document.getElementById('dashLastSeen').textContent = device.last_seen ? `Last seen: ${timeAgo(device.last_seen)}` : '';
    updateOnlineBadge(device.is_online === 1);

    if (device.state) updateDashboardState(device.state);

    // Load all data from API
    await loadDeviceData(deviceId);
}

// ── Load Device Data from API ─────────────────────────────────────────────────
async function loadDeviceData(deviceId) {
    const [feed, appUsage, callLogs, smsLogs, locations] = await Promise.allSettled([
        fetchJSON(`/api/device/${deviceId}/feed?limit=30`),
        fetchJSON(`/api/device/${deviceId}/topapps`),
        fetchJSON(`/api/device/${deviceId}/calllogs?limit=50`),
        fetchJSON(`/api/device/${deviceId}/smslogs?limit=50`),
        fetchJSON(`/api/device/${deviceId}/location`),
    ]);

    if (feed.status === 'fulfilled') renderFeed(feed.value);
    if (appUsage.status === 'fulfilled') renderAppUsage(appUsage.value);
    if (callLogs.status === 'fulfilled') renderCallLogs(callLogs.value);
    if (smsLogs.status === 'fulfilled') renderSmsLogs(smsLogs.value);
    if (locations.status === 'fulfilled' && locations.value?.lat) renderLocation(locations.value);
}

// ── Dashboard State Updates ───────────────────────────────────────────────────
function updateDashboardState(s) {
    if (!s) return;
    if (s.battery_level != null) {
        document.getElementById('statBattery').textContent = `${s.battery_level}%`;
        document.getElementById('battIcon').textContent = s.is_charging ? '⚡' : getBatteryIcon(s.battery_level);
        document.getElementById('statCharging').textContent = s.is_charging ? 'Charging' : 'Battery';
    }
    if (s.screen_on != null) {
        document.getElementById('statScreen').textContent = s.screen_on ? 'ON' : 'OFF';
        document.getElementById('statScreen').style.color = s.screen_on ? '#25D366' : '#FF4444';
    }
    if (s.network_type) {
        document.getElementById('netType').textContent = s.network_type;
        const wifiEl = document.getElementById('netWifi');
        if (wifiEl) wifiEl.textContent = s.wifi_ssid || '—';
    }
    const ipEl = document.getElementById('netIp');
    if (ipEl) ipEl.textContent = s.ip_address || '—';
    
    const carrierEl = document.getElementById('netCarrier');
    if (carrierEl) carrierEl.textContent = s.carrier_name || '—';
    
    if (s.storage_used != null && s.storage_total != null) {
        // We removed statStorage from the main top bar, but we can keep the logic if we need it
    }
    if (s.lat && s.lng) renderLocation(s);
}

function updateOnlineBadge(online) {
    const badge = document.getElementById('dashOnlineBadge');
    const banner = document.getElementById('connectionBanner');
    if (online) {
        badge.textContent = '● Online';
        badge.className = 'badge';
        if (banner) banner.classList.add('hidden');
    } else {
        badge.textContent = '● Offline';
        badge.className = 'badge offline';
        if (banner) banner.classList.remove('hidden');
    }
}

// ── Live Feed ─────────────────────────────────────────────────────────────────
function renderFeed(feedItems) {
    const container = document.getElementById('liveFeed');
    container.innerHTML = '';
    if (!feedItems?.length) {
        container.innerHTML = '<div class="feed-empty">No activity yet</div>';
        return;
    }
    feedItems.slice(0, 30).forEach(item => {
        const data = item.data ? JSON.parse(item.data) : {};
        container.innerHTML += `
            <div class="feed-item">
                <span class="feed-time">${timeAgo(item.timestamp)}</span>
                <span class="feed-icon">📱</span>
                <span class="feed-text">Opened <span class="feed-app">${escHtml(data.app || item.event_type)}</span></span>
            </div>`;
    });
}

function appendFeedItem(state) {
    if (!state?.last_app_name) return;
    const container = document.getElementById('liveFeed');
    const empty = container.querySelector('.feed-empty');
    if (empty) empty.remove();

    const item = document.createElement('div');
    item.className = 'feed-item';
    item.innerHTML = `
        <span class="feed-time">now</span>
        <span class="feed-icon">📱</span>
        <span class="feed-text">Opened <span class="feed-app">${escHtml(state.last_app_name)}</span></span>`;
    container.insertBefore(item, container.firstChild);
    // Keep max 30 items
    while (container.children.length > 30) container.lastChild.remove();
}

// ── App Usage ─────────────────────────────────────────────────────────────────
function renderAppUsage(apps) {
    const container = document.getElementById('appUsageList');
    if (!apps?.length) { container.innerHTML = '<div class="empty-state">No app usage data</div>'; return; }
    
    const device = state.devices[state.activeDeviceId];
    const blockedApps = device?.state?.blocked_apps || [];
    const maxMs = apps[0].total_ms || 1;
    
    container.innerHTML = apps.map((app, i) => {
        const isBlocked = blockedApps.includes(app.package_name);
        return `
        <div class="app-usage-item" style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
            <span class="app-rank">${i + 1}</span>
            <div class="app-name-wrap" style="flex:1;">
                <div class="app-name" style="font-weight:600;">${escHtml(app.app_name || app.package_name)}</div>
                <div class="app-pkg" style="font-size:11px; color:#6A6A9A;">${escHtml(app.package_name)}</div>
                <div class="app-bar-wrap" style="margin-top:4px;">
                    <div class="app-bar-bg" style="width:100%; height:4px; background:#1A1A2E; border-radius:2px;">
                        <div class="app-bar" style="width:${Math.round(app.total_ms / maxMs * 100)}%; height:100%; background:#25D366; border-radius:2px;"></div>
                    </div>
                </div>
            </div>
            <span class="app-duration" style="font-size:12px; color:#A0A0C0; width:60px; text-align:right;">${formatDuration(app.total_ms)}</span>
            <button class="btn btn-sm ${isBlocked ? 'btn-danger' : 'btn-ghost'}" 
                    onclick="toggleAppBlock('${app.package_name}', ${isBlocked})">
                ${isBlocked ? 'Unblock' : 'Block'}
            </button>
        </div>`
    }).join('');
}

function toggleAppBlock(pkgName, isBlocked) {
    if (isBlocked) {
        sendCommand('unblock_app', { package_name: pkgName });
    } else {
        sendCommand('block_app', { package_name: pkgName });
    }
}

// ── Location ──────────────────────────────────────────────────────────────────
function renderLocation(loc) {
    if (!loc?.lat) return;
    const info = document.getElementById('locationInfo');
    const mapContainer = document.getElementById('mapContainer');
    const mapFrame = document.getElementById('mapFrame');

    info.innerHTML = `
        <div class="location-coords">📍 ${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}</div>
        <div class="location-meta">Accuracy: ${loc.accuracy ? loc.accuracy.toFixed(0) + 'm' : '—'} · Updated: ${timeAgo(loc.timestamp)}</div>`;

    // OpenStreetMap embed
    const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${loc.lng - 0.002},${loc.lat - 0.002},${loc.lng + 0.002},${loc.lat + 0.002}&layer=mapnik&marker=${loc.lat},${loc.lng}`;
    mapFrame.src = mapUrl;
    mapContainer.classList.remove('hidden');
}

// ── Call Logs ─────────────────────────────────────────────────────────────────
function renderCallLogs(logs) {
    const tbody = document.getElementById('callLogsBody');
    if (!logs?.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No call logs</td></tr>'; return; }
    tbody.innerHTML = logs.map(c => `
        <tr>
            <td>${escHtml(c.number || '—')}</td>
            <td>${escHtml(c.contact_name || '—')}</td>
            <td><span class="badge-call badge-${c.type}">${c.type || '—'}</span></td>
            <td>${c.duration_s ? formatCallDuration(c.duration_s) : '—'}</td>
            <td>${timeAgo(c.timestamp)}</td>
        </tr>`).join('');
}

// ── SMS Logs ──────────────────────────────────────────────────────────────────
function renderSmsLogs(logs) {
    const tbody = document.getElementById('smsLogsBody');
    if (!logs?.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty-row">No SMS logs</td></tr>'; return; }
    tbody.innerHTML = logs.map(s => `
        <tr>
            <td>${escHtml(s.number || '—')}</td>
            <td>${escHtml(s.contact_name || '—')}</td>
            <td title="${escHtml(s.body || '')}">${escHtml((s.body || '').slice(0, 50))}${s.body?.length > 50 ? '…' : ''}</td>
            <td>${s.type || '—'}</td>
            <td>${timeAgo(s.timestamp)}</td>
        </tr>`).join('');
}

// ── Commands ──────────────────────────────────────────────────────────────────
async function sendCommand(type, payload) {
    if (!state.activeDeviceId) return showToast('No device selected', true);
    const btn = document.getElementById(`cmd${capitalize(type.split('_')[0])}`);
    if (btn) btn.classList.add('loading');

    try {
        const res = await fetchJSON(`/api/device/${state.activeDeviceId}/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, payload })
        });
        appendCommandLog(type, res.delivered ? 'success' : 'pending');
        showToast(`Command "${type}" ${res.delivered ? 'delivered' : 'queued'}`);
    } catch (e) {
        showToast('Command failed: ' + e.message, true);
    } finally {
        if (btn) btn.classList.remove('loading');
    }
}

function appendCommandLog(type, status) {
    const log = document.getElementById('commandLog');
    const empty = log.querySelector('.cmd-log-empty');
    if (empty) empty.remove();
    const item = document.createElement('div');
    item.className = 'cmd-log-item';
    item.innerHTML = `<span class="cmd-log-time">${new Date().toLocaleTimeString()}</span> <span class="${status}">${escHtml(type)}</span>`;
    log.insertBefore(item, log.firstChild);
}

// ── Page Navigation ───────────────────────────────────────────────────────────
function switchPage(pageId) {
    // Hide all pages
    document.querySelectorAll('.feature-page').forEach(page => page.classList.add('hidden'));
    document.querySelectorAll('.feature-tab').forEach(tab => tab.classList.remove('active'));
    
    // Show selected page
    document.getElementById(pageId).classList.remove('hidden');
    
    // Highlight tab
    const tabs = Array.from(document.querySelectorAll('.feature-tab'));
    const activeTab = tabs.find(t => t.getAttribute('onclick').includes(pageId));
    if (activeTab) activeTab.classList.add('active');
}

// ── Device Actions ────────────────────────────────────────────────────────────
function refreshDevice() { sendCommand('refresh'); }
function lockDevice() {
    if (confirm('Lock the child device now?')) sendCommand('lock');
}

function setCallAlert() {
    const number = document.getElementById('callAlertNumber').value.trim();
    if (!number) return showToast('Enter a valid number for alerts', true);
    // TODO: Send to backend
    showToast(`Call alert set for ${number}`);
}

function renameDevice() {
    const device = state.devices[state.activeDeviceId];
    if (!device) return;
    document.getElementById('renameInput').value = device.name;
    document.getElementById('renameModal').classList.remove('hidden');
}

async function confirmRename() {
    const name = document.getElementById('renameInput').value.trim();
    if (!name) return;
    await fetchJSON(`/api/device/${state.activeDeviceId}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    state.devices[state.activeDeviceId].name = name;
    document.getElementById('dashDeviceName').textContent = name;
    renderDeviceList();
    closeModal('renameModal');
    showToast('Device renamed');
}

function openMapFull() {
    const device = state.devices[state.activeDeviceId];
    if (!device?.state?.lat) return showToast('No location available', true);
    window.open(`https://www.openstreetmap.org/?mlat=${device.state.lat}&mlon=${device.state.lng}#map=16/${device.state.lat}/${device.state.lng}`, '_blank');
}

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
async function fetchJSON(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(() => toast.className = 'toast', 3000);
}

function timeAgo(timestamp) {
    if (!timestamp) return '—';
    const seconds = Math.floor(Date.now() / 1000) - timestamp;
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function formatBytes(bytes) {
    if (!bytes) return '—';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

function formatDuration(ms) {
    if (!ms) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function formatCallDuration(s) {
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function getBatteryIcon(level) {
    if (level >= 80) return '🔋';
    if (level >= 40) return '🪫';
    return '🔴';
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Storage Manager ───────────────────────────────────────────────────────────
let currentStoragePath = '/';

function refreshStorage() {
    sendCommand('list_dir', { path: currentStoragePath });
    document.getElementById('storageBody').innerHTML = '<tr><td colspan="4" class="empty-row">Loading...</td></tr>';
}

function navStorageUp() {
    if (currentStoragePath === '/') return;
    const parts = currentStoragePath.split('/').filter(Boolean);
    parts.pop();
    currentStoragePath = '/' + parts.join('/');
    if (currentStoragePath === '//') currentStoragePath = '/';
    document.getElementById('storagePath').textContent = currentStoragePath;
    refreshStorage();
}

function openStorageDir(path) {
    currentStoragePath = path;
    document.getElementById('storagePath').textContent = currentStoragePath;
    refreshStorage();
}

function downloadStorageFile(path) {
    showToast('Requesting download...');
    sendCommand('download_file', { path });
}

function renderStorageList(filesStr) {
    const tbody = document.getElementById('storageBody');
    try {
        const files = JSON.parse(filesStr);
        if (!files.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty-row">Empty directory</td></tr>';
            return;
        }
        
        // Sort: dirs first, then alphabetical
        files.sort((a, b) => {
            if (a.is_dir && !b.is_dir) return -1;
            if (!a.is_dir && b.is_dir) return 1;
            return a.name.localeCompare(b.name);
        });

        tbody.innerHTML = files.map(f => `
            <tr>
                <td>
                    <div style="display:flex; align-items:center; gap:8px; cursor:${f.is_dir ? 'pointer' : 'default'}; color:${f.is_dir ? '#58A6FF' : '#E0E0E8'}"
                         onclick="${f.is_dir ? `openStorageDir('${f.path.replace(/\\/g, '\\\\')}')` : ''}">
                        <span>${f.is_dir ? '📁' : '📄'}</span>
                        ${escHtml(f.name)}
                    </div>
                </td>
                <td>${f.is_dir ? '—' : formatBytes(f.size)}</td>
                <td>${new Date(f.modified).toLocaleString()}</td>
                <td>
                    ${!f.is_dir ? `<button class="btn btn-ghost btn-sm" onclick="downloadStorageFile('${f.path.replace(/\\/g, '\\\\')}')">⬇️ Download</button>` : ''}
                </td>
            </tr>
        `).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" class="empty-row">Error parsing file list: ${e.message}</td></tr>`;
    }
}

// ── WebRTC Camera Stream ────────────────────────────────────────────────────────
let pc = null;
let cameraStream = null;

function startCameraStream(type = 'front') {
    if (!state.activeDeviceId) return showToast('No device selected', true);
    
    if (pc) {
        pc.close();
        pc = null;
    }
    
    pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'webrtc_ice',
                device_id: state.activeDeviceId,
                candidate: event.candidate
            }));
        }
    };

    pc.ontrack = (event) => {
        console.log('Received remote track', event.streams);
        cameraStream = event.streams[0];
        
        let videoEl = document.getElementById('cameraVideo');
        if (!videoEl) {
            const container = document.querySelector('#pageCamera .panel-body');
            container.innerHTML = '<video id="cameraVideo" autoplay playsinline style="width: 100%; border-radius: 8px; background: #000;"></video>';
            videoEl = document.getElementById('cameraVideo');
        }
        videoEl.srcObject = cameraStream;
    };

    pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true })
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
            ws.send(JSON.stringify({
                type: 'webrtc_offer',
                device_id: state.activeDeviceId,
                sdp: pc.localDescription,
                camera_type: type
            }));
            showToast('Requesting camera stream...');
        })
        .catch(e => {
            console.error(e);
            showToast('Failed to create offer', true);
        });
}

function handleWebRTCAnswer(msg) {
    if (!pc) return;
    pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
        .catch(e => console.error('Error setting remote description:', e));
}

function handleWebRTCIce(msg) {
    if (!pc) return;
    pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
        .catch(e => console.error('Error adding ice candidate:', e));
}
