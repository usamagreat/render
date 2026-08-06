/**
 * ws.js — WebSocket client for the dashboard.
 * Connects to the server, handles reconnection, and dispatches events.
 */

const WS_URL = (() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
})();

let ws = null;
let reconnectTimer = null;
let isConnected = false;

function connectWebSocket() {
    clearTimeout(reconnectTimer);
    updateServerStatus(false, 'Connecting…');

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        isConnected = true;
        updateServerStatus(true, 'Connected');
        // Identify as dashboard
        ws.send(JSON.stringify({ type: 'identify_dashboard' }));
        console.log('[WS] Dashboard connected');
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleServerMessage(msg);
        } catch (e) {
            console.error('[WS] Parse error:', e);
        }
    };

    ws.onclose = () => {
        isConnected = false;
        updateServerStatus(false, 'Disconnected — reconnecting…');
        console.log('[WS] Disconnected. Retrying in 5s…');
        reconnectTimer = setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = (err) => {
        console.error('[WS] Error:', err);
        ws.close();
    };
}

function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
        return true;
    }
    return false;
}

function updateServerStatus(connected, text) {
    const dot = document.getElementById('serverDot');
    const label = document.getElementById('serverStatusText');
    if (dot) {
        dot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
    }
    if (label) label.textContent = text;
}

// Start connection
connectWebSocket();
