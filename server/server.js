require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { db, queries, saveDeviceData } = require('./database');

const app = express();
const server = http.createServer(app);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket Server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });

// Connected clients maps
const deviceSockets = new Map();   // deviceId → ws
const dashboardSockets = new Set(); // ws set

function broadcastToDashboards(data) {
    const msg = JSON.stringify(data);
    dashboardSockets.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
}

function sendToDevice(deviceId, data) {
    const ws = deviceSockets.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
        return true;
    }
    return false;
}

wss.on('connection', (ws, req) => {
    let deviceId = null;
    let isDashboard = false;
    console.log(`[WS] New connection from ${req.socket.remoteAddress}`);

    ws.on('message', (rawMsg) => {
        try {
            const msg = JSON.parse(rawMsg.toString());

            switch (msg.type) {
                case 'identify_device': {
                    deviceId = msg.device_id;
                    if (!deviceId) { ws.send(JSON.stringify({ type: 'error', message: 'Missing device_id' })); return; }
                    let device = queries.getDevice(deviceId);
                    if (!device) {
                        queries.insertDevice(deviceId, msg.name || 'Unknown Device', deviceId, msg.model || '', msg.brand || '', msg.android_version || '');
                        device = queries.getDevice(deviceId);
                    }
                    deviceSockets.set(deviceId, ws);
                    queries.updateDeviceSeen(1, deviceId);
                    console.log(`[WS] Device connected: ${device?.name} (${deviceId})`);
                    ws.send(JSON.stringify({ type: 'identified', device_id: deviceId }));
                    broadcastToDashboards({ type: 'device_online', device_id: deviceId, name: device?.name });
                    
                    const pending = queries.getPendingCommands(deviceId) || [];
                    pending.forEach(cmd => ws.send(JSON.stringify({ type: 'command', id: cmd.id, action: cmd.type, payload: cmd.payload ? JSON.parse(cmd.payload) : null })));
                    break;
                }

                case 'identify_dashboard': {
                    isDashboard = true;
                    dashboardSockets.add(ws);
                    console.log('[WS] Dashboard connected');
                    const devices = queries.getAllDevices() || [];
                    ws.send(JSON.stringify({ type: 'devices_list', devices }));
                    break;
                }

                case 'data': {
                    if (!deviceId) return;
                    saveDeviceData(deviceId, msg.payload);
                    const state = queries.getState(deviceId);
                    broadcastToDashboards({ type: 'device_update', device_id: deviceId, state });
                    console.log(`[WS] Data from ${deviceId}: ${msg.payload.state?.last_app_name || 'no app'}`);
                    break;
                }

                case 'command_ack': {
                    if (!deviceId) return;
                    queries.updateCommandStatus('done', msg.id);
                    broadcastToDashboards({ type: 'command_done', command_id: msg.id, device_id: deviceId });
                    console.log(`[WS] Command ACK: ${msg.id}`);
                    break;
                }

                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
            }
        } catch (e) {
            console.error('[WS] Parse error:', e.message);
        }
    });

    ws.on('close', () => {
        if (isDashboard) {
            dashboardSockets.delete(ws);
            console.log('[WS] Dashboard disconnected');
        } else if (deviceId) {
            deviceSockets.delete(deviceId);
            queries.updateDeviceSeen(0, deviceId);
            broadcastToDashboards({ type: 'device_offline', device_id: deviceId });
            console.log(`[WS] Device disconnected: ${deviceId}`);
        }
    });

    ws.on('error', (err) => console.error('[WS] Error:', err.message));
});

// ── REST API Routes ───────────────────────────────────────────────────────────
app.use('/api', require('./routes/devices')({ queries, uuidv4 }));
app.use('/api', require('./routes/data')({ queries, saveDeviceData, broadcastToDashboards }));
app.use('/api', require('./routes/commands')({ queries, uuidv4, sendToDevice, broadcastToDashboards }));

// Ping endpoint for connectivity check
app.get('/ping', (req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/health', (req, res) => res.json({ status: 'healthy', devices: deviceSockets.size, dashboards: dashboardSockets.size }));

// Serve dashboard for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Parent Control Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket: ws://localhost:${PORT}/ws`);
});

module.exports = { sendToDevice, broadcastToDashboards };
