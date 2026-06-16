// src/routes/push.js
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { isPushConfigured, ensurePushTables, saveSubscription } = require('../services/pushService');

router.get('/public-key', async (req, res) => {
  try {
    const configured = isPushConfigured();
    res.json({
      enabled: configured,
      publicKey: configured ? process.env.VAPID_PUBLIC_KEY : null,
    });
  } catch (err) {
    console.error('push public-key error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    if (!isPushConfigured()) {
      return res.status(400).json({ error: 'Browser push is not configured on the backend' });
    }

    const salonId = req.user?.salonId || req.body?.salonId;
    if (!salonId) {
      return res.status(400).json({ error: 'salonId is required' });
    }

    const subscription = req.body?.subscription || req.body;
    const saved = await saveSubscription({
      salonId,
      role: req.user?.role || null,
      staffId: req.user?.staffId || null,
      subscription,
    });

    res.json({ ok: true, id: saved.id });
  } catch (err) {
    console.error('push subscribe error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/ensure-tables', requireAuth, async (req, res) => {
  try {
    await ensurePushTables();
    res.json({ ok: true });
  } catch (err) {
    console.error('push ensure-tables error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
