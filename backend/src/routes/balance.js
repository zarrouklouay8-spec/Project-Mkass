// src/routes/balance.js
const router = require('express').Router();
const pool = require('../db/pool');
const { requireSalonAccess, requireActiveSubscription } = require('../middleware/auth');

// ── GET /api/salons/:salonId/balance ─────────────────────────
// Gérant — total balance + transaction history
// Query params: ?type=all|booking|walkin&period=today|week|month|all
router.get('/:salonId/balance', requireSalonAccess, requireActiveSubscription, async (req, res) => {
  try {
    const { type, period } = req.query;
    const salonId = req.params.salonId;

    let q = `SELECT * FROM appointments WHERE salon_id = $1 AND status = 'done'`;
    const params = [salonId];

    if (type && type !== 'all') {
      params.push(type);
      q += ` AND type = $${params.length}`;
    }

    const today = new Date().toISOString().slice(0, 10);
    if (period === 'today') {
      params.push(today);
      q += ` AND appt_date = $${params.length}`;
    } else if (period === 'week') {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      params.push(weekAgo);
      q += ` AND appt_date >= $${params.length}`;
    } else if (period === 'month') {
      const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      params.push(monthAgo);
      q += ` AND appt_date >= $${params.length}`;
    }

    q += ' ORDER BY appt_date DESC, appt_time DESC';
    const { rows } = await pool.query(q, params);

    // Summary stats (always over all done transactions regardless of period filter)
    const allDone = await pool.query(
      `SELECT total, type, appt_date FROM appointments WHERE salon_id = $1 AND status = 'done'`,
      [salonId]
    );
    const all = allDone.rows;
    const totalRevenue = all.reduce((s, a) => s + parseFloat(a.total), 0);
    const todayRevenue = all.filter(a => a.appt_date.toISOString?.().slice(0,10) === today || a.appt_date === today)
                            .reduce((s, a) => s + parseFloat(a.total), 0);
    const bookingRevenue = all.filter(a => a.type === 'booking').reduce((s, a) => s + parseFloat(a.total), 0);
    const walkinRevenue  = all.filter(a => a.type === 'walkin').reduce((s, a) => s + parseFloat(a.total), 0);

    res.json({
      summary: {
        total: Math.round(totalRevenue * 100) / 100,
        today: Math.round(todayRevenue * 100) / 100,
        bookings: Math.round(bookingRevenue * 100) / 100,
        walkins: Math.round(walkinRevenue * 100) / 100,
        transactions: all.length,
      },
      transactions: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
