const express = require('express');

module.exports = ({ queries, uuidv4 }) => {
    const router = express.Router();

    // Register a new device
    router.post('/device/register', (req, res) => {
        try {
            const { name, model, brand, android_version } = req.body;
            if (!name) return res.status(400).json({ error: 'name is required' });
            const id = uuidv4();
            const token = uuidv4();
            queries.insertDevice.run(id, name, token, model || '', brand || '', android_version || '');
            console.log(`[API] Device registered: ${name} (${id})`);
            res.json({ id, token, message: 'Device registered successfully' });
        } catch (e) {
            console.error('[API] Register error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Get all devices
    router.get('/devices', (req, res) => {
        res.json(queries.getAllDevices.all());
    });

    // Get device by ID
    router.get('/device/:id', (req, res) => {
        const device = queries.getDevice.get(req.params.id);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        const state = queries.getState.get(req.params.id);
        res.json({ ...device, state });
    });

    // Rename device
    router.patch('/device/:id/name', (req, res) => {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });
        const info = queries.updateDeviceName.run(name, req.params.id);
        if (info.changes === 0) return res.status(404).json({ error: 'Device not found' });
        res.json({ success: true });
    });

    // Delete device
    router.delete('/device/:id', (req, res) => {
        queries.deleteDevice.run(req.params.id);
        res.json({ success: true });
    });

    return router;
};
