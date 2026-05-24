// src/routes/admin.js
const router = require('express').Router();
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

// All routes here require admin role

// ── GET /api/admin/salons ────────────────────────────────────
// All salons with stats
router.get('/salons', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*,
        COUNT(a.id) AS total_appointments,
        COALESCE(SUM(CASE WHEN a.status='done' THEN a.total ELSE 0 END), 0) AS total_revenue
      FROM salons s
      LEFT JOIN appointments a ON a.salon_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at ASC
    `);
    rows.forEach(r => delete r.password);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/admin/stats ─────────────────────────────────────
// Platform-wide stats
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [salonCount, apptCount, revenueRes, todayRes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM salons'),
      pool.query('SELECT COUNT(*) FROM appointments'),
      pool.query(`SELECT COALESCE(SUM(total),0) AS total FROM appointments WHERE status='done'`),
      pool.query(`SELECT COALESCE(SUM(total),0) AS total FROM appointments WHERE status='done' AND appt_date=$1`, [today]),
    ]);
    res.json({
      salons: parseInt(salonCount.rows[0].count),
      appointments: parseInt(apptCount.rows[0].count),
      totalRevenue: parseFloat(revenueRes.rows[0].total),
      todayRevenue: parseFloat(todayRes.rows[0].total),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/admin/appointments ──────────────────────────────
// All appointments across all salons
router.get('/appointments', requireAdmin, async (req, res) => {
  try {
    const { date, status } = req.query;
    let q = `SELECT a.*, s.name AS salon_name FROM appointments a JOIN salons s ON s.id = a.salon_id WHERE 1=1`;
    const params = [];
    if (date)   { params.push(date);   q += ` AND a.appt_date = $${params.length}`; }
    if (status) { params.push(status); q += ` AND a.status = $${params.length}`; }
    q += ' ORDER BY a.appt_date DESC, a.appt_time ASC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});



// ── PATCH /api/admin/salons/:salonId/plan ───────────────────
// Admin changes a salon plan: starter or pro
router.patch('/salons/:salonId/plan', requireAdmin, async (req, res) => {
  try {
    const plan = String(req.body.plan || '').toLowerCase().trim();
    if (!['starter', 'pro'].includes(plan)) {
      return res.status(400).json({ error: 'Invalid plan. Use starter or pro.' });
    }

    const { rows } = await pool.query(
      `UPDATE salons
       SET plan = $1,
           subscription_status = COALESCE($2, subscription_status, 'active')
       WHERE id = $3
       RETURNING id, name, username, plan, subscription_status`,
      [plan, req.body.subscriptionStatus || req.body.subscription_status || 'active', req.params.salonId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Salon not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/admin/salons/:salonId/reset-password ─────────
// Admin resets a gérant's password
router.patch('/salons/:salonId/reset-password', requireAdmin, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    const { rows } = await pool.query(
      'UPDATE salons SET password=$1 WHERE id=$2 RETURNING id, name, username',
      [hash, req.params.salonId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Salon not found' });
    res.json({ message: `Password reset for ${rows[0].name}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
