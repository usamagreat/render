// In-memory state storage (Replaces SQLite)

const state = {
    devices: new Map(),       // deviceId -> { id, name, token, model, brand, android_version, is_online, last_seen, created_at }
    device_state: new Map(),  // deviceId -> { ...state }
    locations: [],            // [{ id, device_id, lat, lng, accuracy, altitude, speed, timestamp }]
    app_usage: [],            // [{ id, device_id, package_name, app_name, timestamp, duration_ms }]
    call_logs: [],            // [{ id, device_id, number, contact_name, type, duration_s, timestamp }]
    sms_logs: [],             // [{ id, device_id, number, contact_name, body, type, timestamp }]
    commands: new Map(),      // commandId -> { id, device_id, type, payload, status, created_at, executed_at }
    live_feed: []             // [{ id, device_id, event_type, data, timestamp }]
};

// Auto-increment IDs
let locId = 1;
let usageId = 1;
let callId = 1;
let smsId = 1;
let feedId = 1;

// Helper to keep arrays bounded
function pushBounded(arr, item, maxLen = 500) {
    arr.push(item);
    if (arr.length > maxLen) arr.shift();
}

const queries = {
    getDevice: (id) => state.devices.get(id) || null,
    
    getAllDevices: () => {
        return Array.from(state.devices.values()).sort((a, b) => b.last_seen - a.last_seen).map(d => {
            const s = state.device_state.get(d.id) || {};
            return {
                ...d,
                battery_level: s.battery_level,
                is_charging: s.is_charging,
                screen_on: s.screen_on,
                last_app_name: s.last_app_name,
                lat: s.lat,
                lng: s.lng,
                state_updated: s.updated_at
            };
        });
    },

    insertDevice: (id, name, token, model, brand, av) => {
        state.devices.set(id, {
            id, name, token, model, brand, android_version: av,
            is_online: 0, last_seen: null, created_at: Math.floor(Date.now() / 1000)
        });
    },

    updateDeviceSeen: (online, id) => {
        const d = state.devices.get(id);
        if (d) {
            d.last_seen = Math.floor(Date.now() / 1000);
            d.is_online = online;
        }
    },

    updateDeviceName: (name, id) => {
        const d = state.devices.get(id);
        if (d) d.name = name;
    },

    deleteDevice: (id) => {
        state.devices.delete(id);
        state.device_state.delete(id);
        state.locations = state.locations.filter(l => l.device_id !== id);
        state.app_usage = state.app_usage.filter(a => a.device_id !== id);
        state.call_logs = state.call_logs.filter(c => c.device_id !== id);
        state.sms_logs = state.sms_logs.filter(s => s.device_id !== id);
        state.live_feed = state.live_feed.filter(f => f.device_id !== id);
    },

    getDeviceByToken: (token) => {
        for (const d of state.devices.values()) {
            if (d.token === token) return d;
        }
        return null;
    },

    upsertState: (deviceId, s) => {
        const existing = state.device_state.get(deviceId) || { device_id: deviceId };
        
        const merged = {
            ...existing,
            updated_at: Math.floor(Date.now() / 1000)
        };
        
        if (s.battery_level != null) merged.battery_level = s.battery_level;
        if (s.is_charging != null) merged.is_charging = s.is_charging ? 1 : 0;
        if (s.screen_on != null) merged.screen_on = s.screen_on ? 1 : 0;
        if (s.last_app != null) merged.last_app = s.last_app;
        if (s.last_app_name != null) merged.last_app_name = s.last_app_name;
        if (s.wifi_ssid != null) merged.wifi_ssid = s.wifi_ssid;
        if (s.ip_address != null) merged.ip_address = s.ip_address;
        if (s.network_type != null) merged.network_type = s.network_type;
        if (s.signal_strength != null) merged.signal_strength = s.signal_strength;
        if (s.storage_used != null) merged.storage_used = s.storage_used;
        if (s.storage_total != null) merged.storage_total = s.storage_total;
        if (s.lat != null) merged.lat = s.lat;
        if (s.lng != null) merged.lng = s.lng;
        if (s.location_accuracy != null) merged.location_accuracy = s.location_accuracy;
        if (s.carrier_name != null) merged.carrier_name = s.carrier_name;
        if (s.blocked_apps != null) merged.blocked_apps = s.blocked_apps;

        state.device_state.set(deviceId, merged);
    },

    getState: (deviceId) => state.device_state.get(deviceId) || null,

    insertLocation: (d, lat, lng, acc, alt, spd, ts) => {
        pushBounded(state.locations, { id: locId++, device_id: d, lat, lng, accuracy: acc, altitude: alt, speed: spd, timestamp: ts });
    },
    getLocations: (d, limit = 100) => {
        return state.locations.filter(l => l.device_id === d)
            .sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    },
    getLastLocation: (d) => {
        const locs = queries.getLocations(d, 1);
        return locs.length > 0 ? locs[0] : null;
    },

    insertAppUsage: (d, pkg, name, ts, dur) => {
        // Find existing for same pkg and ts
        const exists = state.app_usage.find(a => a.device_id === d && a.package_name === pkg && a.timestamp === ts);
        if (!exists) {
            pushBounded(state.app_usage, { id: usageId++, device_id: d, package_name: pkg, app_name: name, timestamp: ts, duration_ms: dur });
        }
    },
    getAppUsage: (d, limit = 100) => {
        return state.app_usage.filter(a => a.device_id === d)
            .sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    },
    getTopApps: (d, since) => {
        const filtered = state.app_usage.filter(a => a.device_id === d && a.timestamp > since);
        const map = new Map();
        for (const a of filtered) {
            const curr = map.get(a.package_name) || { package_name: a.package_name, app_name: a.app_name, total_ms: 0, opens: 0 };
            curr.total_ms += a.duration_ms;
            curr.opens += 1;
            map.set(a.package_name, curr);
        }
        return Array.from(map.values()).sort((a, b) => b.total_ms - a.total_ms).slice(0, 20);
    },

    insertCall: (d, num, name, type, dur, ts) => {
        const exists = state.call_logs.find(c => c.device_id === d && c.number === num && c.timestamp === ts);
        if (!exists) {
            pushBounded(state.call_logs, { id: callId++, device_id: d, number: num, contact_name: name, type, duration_s: dur, timestamp: ts });
        }
    },
    getCallLogs: (d, limit = 100) => {
        return state.call_logs.filter(c => c.device_id === d)
            .sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    },

    insertSms: (d, num, name, body, type, ts) => {
        const exists = state.sms_logs.find(s => s.device_id === d && s.number === num && s.timestamp === ts);
        if (!exists) {
            pushBounded(state.sms_logs, { id: smsId++, device_id: d, number: num, contact_name: name, body, type, timestamp: ts });
        }
    },
    getSmsLogs: (d, limit = 100) => {
        return state.sms_logs.filter(s => s.device_id === d)
            .sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    },

    insertCommand: (id, deviceId, type, payload) => {
        state.commands.set(id, {
            id, device_id: deviceId, type, payload,
            status: 'pending', created_at: Math.floor(Date.now() / 1000), executed_at: null
        });
    },
    getPendingCommands: (deviceId) => {
        return Array.from(state.commands.values())
            .filter(c => c.device_id === deviceId && c.status === 'pending')
            .sort((a, b) => a.created_at - b.created_at);
    },
    updateCommandStatus: (status, id) => {
        const c = state.commands.get(id);
        if (c) {
            c.status = status;
            c.executed_at = Math.floor(Date.now() / 1000);
        }
    },
    getCommandHistory: (deviceId) => {
        return Array.from(state.commands.values())
            .filter(c => c.device_id === deviceId)
            .sort((a, b) => b.created_at - a.created_at).slice(0, 50);
    },

    insertFeed: (d, type, data) => {
        pushBounded(state.live_feed, { id: feedId++, device_id: d, event_type: type, data, timestamp: Math.floor(Date.now() / 1000) }, 100);
    },
    getFeed: (d, limit = 50) => {
        return state.live_feed.filter(f => f.device_id === d)
            .sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }
};

// ── Batch Data Save ───────────────────────────────────────────────────────────
function saveDeviceData(deviceId, payload) {
    queries.updateDeviceSeen(1, deviceId);

    if (payload.state) {
        queries.upsertState(deviceId, payload.state);
    }
    if (payload.location) {
        const l = payload.location;
        queries.insertLocation(deviceId, l.lat, l.lng, l.accuracy, l.altitude, l.speed, l.timestamp || Math.floor(Date.now() / 1000));
    }
    if (payload.app_usage?.length) {
        for (const a of payload.app_usage) {
            queries.insertAppUsage(deviceId, a.package_name, a.app_name, a.timestamp, a.duration_ms ?? 0);
        }
    }
    if (payload.call_logs?.length) {
        for (const c of payload.call_logs) {
            queries.insertCall(deviceId, c.number, c.contact_name, c.type, c.duration_s, c.timestamp);
        }
    }
    if (payload.sms_logs?.length) {
        for (const s of payload.sms_logs) {
            queries.insertSms(deviceId, s.number, s.contact_name, s.body, s.type, s.timestamp);
        }
    }
    if (payload.state?.last_app_name) {
        queries.insertFeed(deviceId, 'app_open', JSON.stringify({ app: payload.state.last_app_name, pkg: payload.state.last_app }));
    }
}

// Ensure dummy device for testing doesn't break
if (state.devices.size === 0) {
    // queries.insertDevice('test_dev_1', 'Demo Android', 'demo_tok', 'Pixel 6', 'Google', '13');
}

module.exports = { db: null, queries, saveDeviceData };
