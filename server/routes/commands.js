const express = require('express');

module.exports = ({ queries, uuidv4, sendToDevice, broadcastToDashboards }) => {
    const router = express.Router();

    const VALID_COMMANDS = ['lock', 'refresh', 'capture_photo', 'record_audio', 'get_location', 'unlock_screen'];

    // Issue a command to a device
    router.post('/device/:id/command', (req, res) => {
        try {
            const { type, payload } = req.body;
            if (!VALID_COMMANDS.includes(type)) {
                return res.status(400).json({ error: `Invalid command. Valid: ${VALID_COMMANDS.join(', ')}` });
            }
            const device = queries.getDevice.get(req.params.id);
            if (!device) return res.status(404).json({ error: 'Device not found' });

            const cmdId = uuidv4();
            queries.insertCommand.run(cmdId, req.params.id, type, payload ? JSON.stringify(payload) : null);

            // Try to deliver via WebSocket immediately
            const delivered = sendToDevice(req.params.id, {
                type: 'command',
                id: cmdId,
                action: type,
                payload: payload || null
            });

            console.log(`[API] Command "${type}" → ${req.params.id} | WS delivered: ${delivered}`);
            broadcastToDashboards({ type: 'command_issued', device_id: req.params.id, command: { id: cmdId, type, status: 'pending' } });

            res.json({ id: cmdId, status: delivered ? 'delivered' : 'queued', delivered });
        } catch (e) {
            console.error('[API] Command error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Device polls for pending commands (HTTP fallback)
    router.get('/device/:id/commands/pending', (req, res) => {
        const token = req.headers['x-device-token'];
        const device = queries.getDevice.get(req.params.id);
        if (!device) return res.status(404).json({ error: 'Device not found' });
        if (token && device.token !== token) return res.status(401).json({ error: 'Invalid token' });
        res.json(queries.getPendingCommands.all(req.params.id));
    });

    // Mark command as done (HTTP fallback)
    router.patch('/command/:cmdId/done', (req, res) => {
        queries.updateCommandStatus.run('done', req.params.cmdId);
        res.json({ success: true });
    });

    // Get command history for a device
    router.get('/device/:id/commands', (req, res) => {
        res.json(queries.getCommandHistory.all(req.params.id));
    });

    return router;
};
