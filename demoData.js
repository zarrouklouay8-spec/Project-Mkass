// src/routes/services.js
const router = require('express').Router();
const pool = require('../db/pool');
const { requireSalonAccess, requireActiveSubscription } = require('../middleware/auth');

// ── GET /api/salons/:salonId/services ────────────────────────
// Public — list services for a salon (used on booking page)
router.get('/:salonId/services', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM services WHERE salon_id = $1 ORDER BY category, name',
      [req.params.salonId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/salons/:salonId/services ───────────────────────
// Gérant adds a service to their salon
router.post('/:salonId/services', requireSalonAccess, requireActiveSubscription, async (req, res) => {
  try {
    const { category, name, duration, price } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price are required' });
    const { rows } = await pool.query(`
      INSERT INTO services (salon_id, category, name, duration, price)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [req.params.salonId, category || 'Autre', name, duration || '30 min', price]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/salons/:salonId/services/:serviceId ─────────────
// Gérant updates a service (e.g. change price)
router.put('/:salonId/services/:serviceId', requireSalonAccess, requireActiveSubscription, async (req, res) => {
  try {
    const { category, name, duration, price } = req.body;
    const { rows } = await pool.query(`
      UPDATE services SET
        category = COALESCE($1, category),
        name     = COALESCE($2, name),
        duration = COALESCE($3, duration),
        price    = COALESCE($4, price)
      WHERE id = $5 AND salon_id = $6
      RETURNING *
    `, [category, name, duration, price, req.params.serviceId, req.params.salonId]);
    if (!rows.length) return res.status(404).json({ error: 'Service not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/salons/:salonId/services/:serviceId ──────────
router.delete('/:salonId/services/:serviceId', requireSalonAccess, requireActiveSubscription, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM services WHERE id = $1 AND salon_id = $2',
      [req.params.serviceId, req.params.salonId]
    );
    res.json({ message: 'Service deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
