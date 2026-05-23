const router = require('express').Router();
const pool = require('../db/pool');
const { requireSalonAccess } = require('../middleware/auth');

function normalizeRate(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? n / 100 : n;
}

// Public staff list for booking selector: /api/salons/:salonId/public-staff
router.get('/:salonId/public-staff', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, salon_id, name, phone, role, active, commission_rate, created_at
       FROM staff
       WHERE salon_id = $1 AND active = true
       ORDER BY created_at ASC`,
      [req.params.salonId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET public staff error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/salons/:salonId/staff
router.get('/:salonId/staff', requireSalonAccess, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, salon_id, name, phone, role, active, commission_rate, created_at
       FROM staff
       WHERE salon_id = $1
       ORDER BY created_at ASC`,
      [req.params.salonId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET staff error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/salons/:salonId/staff
router.post('/:salonId/staff', requireSalonAccess, async (req, res) => {
  try {
    const { name, phone, role, active, commission_rate, commissionRate } = req.body;
    if (!name) return res.status(400).json({ error: 'Nom du personnel obligatoire' });

    const { rows } = await pool.query(
      `INSERT INTO staff (salon_id, name, phone, role, active, commission_rate)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.salonId, name, phone || '', role || '', active !== false, normalizeRate(commission_rate ?? commissionRate)]
    );

    const staffId = rows[0].id;
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      await pool.query(
        `INSERT INTO staff_working_hours (staff_id, weekday, start_time, end_time, active)
         VALUES ($1, $2, '09:00', '23:59', true)
         ON CONFLICT (staff_id, weekday) DO NOTHING`,
        [staffId, weekday]
      );
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST staff error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/salons/:salonId/staff/:staffId
router.put('/:salonId/staff/:staffId', requireSalonAccess, async (req, res) => {
  try {
    const { salonId, staffId } = req.params;
    const { name, phone, role, active, commission_rate, commissionRate } = req.body;

    const { rows } = await pool.query(
      `UPDATE staff SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         role = COALESCE($3, role),
         active = COALESCE($4, active),
         commission_rate = COALESCE($5, commission_rate)
       WHERE id = $6 AND salon_id = $7
       RETURNING *`,
      [
        name || null,
        phone ?? null,
        role ?? null,
        typeof active === 'boolean' ? active : null,
        commission_rate !== undefined || commissionRate !== undefined ? normalizeRate(commission_rate ?? commissionRate) : null,
        staffId,
        salonId
      ]
    );

    if (!rows.length) return res.status(404).json({ error: 'Personnel introuvable' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT staff error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/salons/:salonId/staff/:staffId/services
router.get('/:salonId/staff/:staffId/services', requireSalonAccess, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         ss.id,
         ss.staff_id,
         ss.service_id,
         ss.duration_minutes,
         s.name AS service_name,
         s.price,
         s.category
       FROM staff_services ss
       JOIN services s ON s.id = ss.service_id
       JOIN staff st ON st.id = ss.staff_id
       WHERE ss.staff_id = $1
         AND st.salon_id = $2
       ORDER BY s.name ASC`,
      [req.params.staffId, req.params.salonId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET staff services error:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// POST /api/salons/:salonId/staff/:staffId/services
router.post('/:salonId/staff/:staffId/services', requireSalonAccess, async (req, res) => {
  try {
    const { serviceId, durationMinutes } = req.body;
    const staffCheck = await pool.query(
      `SELECT id FROM staff WHERE id = $1 AND salon_id = $2`,
      [req.params.staffId, req.params.salonId]
    );
    if (staffCheck.rowCount === 0) return res.status(404).json({ error: 'Personnel introuvable' });
    if (!serviceId) return res.status(400).json({ error: 'Service obligatoire' });

    const { rows } = await pool.query(
      `INSERT INTO staff_services (staff_id, service_id, duration_minutes)
       VALUES ($1, $2, $3)
       ON CONFLICT (staff_id, service_id)
       DO UPDATE SET duration_minutes = EXCLUDED.duration_minutes
       RETURNING *`,
      [req.params.staffId, serviceId, durationMinutes || 30]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST staff services error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/salons/:salonId/staff/:staffId/services - replace all staff services
router.put('/:salonId/staff/:staffId/services', requireSalonAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    const { salonId, staffId } = req.params;
    const { serviceIds, durationMinutes } = req.body;
    if (!Array.isArray(serviceIds)) return res.status(400).json({ error: 'serviceIds must be an array' });

    const staffCheck = await client.query(`SELECT id FROM staff WHERE id = $1 AND salon_id = $2`, [staffId, salonId]);
    if (staffCheck.rowCount === 0) return res.status(404).json({ error: 'Personnel introuvable' });

    await client.query('BEGIN');
    await client.query(`DELETE FROM staff_services WHERE staff_id = $1`, [staffId]);
    for (const serviceId of serviceIds.map(Number).filter(Boolean)) {
      await client.query(
        `INSERT INTO staff_services (staff_id, service_id, duration_minutes)
         VALUES ($1, $2, $3)
         ON CONFLICT (staff_id, service_id)
         DO UPDATE SET duration_minutes = EXCLUDED.duration_minutes`,
        [staffId, serviceId, durationMinutes || 30]
      );
    }
    await client.query('COMMIT');

    const { rows } = await pool.query(
      `SELECT ss.*, s.name AS service_name, s.category, s.price
       FROM staff_services ss
       JOIN services s ON s.id = ss.service_id
       WHERE ss.staff_id = $1
       ORDER BY s.name`,
      [staffId]
    );
    res.json(rows);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PUT staff services error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /api/salons/:salonId/staff/:staffId/hours
router.get('/:salonId/staff/:staffId/hours', requireSalonAccess, async (req, res) => {
  try {
    const { salonId, staffId } = req.params;
    const staffCheck = await pool.query(`SELECT id FROM staff WHERE id = $1 AND salon_id = $2`, [staffId, salonId]);
    if (staffCheck.rowCount === 0) return res.status(404).json({ error: 'Personnel introuvable' });

    const { rows } = await pool.query(
      `SELECT weekday, start_time, end_time, active
       FROM staff_working_hours
       WHERE staff_id = $1
       ORDER BY weekday ASC`,
      [staffId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET staff hours error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/salons/:salonId/staff/:staffId/hours
router.post('/:salonId/staff/:staffId/hours', requireSalonAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    const { salonId, staffId } = req.params;
    const { hours } = req.body;
    if (!Array.isArray(hours)) return res.status(400).json({ error: 'Horaires invalides' });

    const staffCheck = await client.query(`SELECT id FROM staff WHERE id = $1 AND salon_id = $2`, [staffId, salonId]);
    if (staffCheck.rowCount === 0) return res.status(404).json({ error: 'Personnel introuvable' });

    await client.query('BEGIN');
    for (const h of hours) {
      const weekday = Number(h.weekday);
      const startTime = String(h.start_time || h.startTime || '09:00').slice(0, 5);
      const endTime = String(h.end_time || h.endTime || '23:59').slice(0, 5);
      const active = h.active !== false;
      if (weekday < 0 || weekday > 6) continue;

      await client.query(
        `INSERT INTO staff_working_hours (staff_id, weekday, start_time, end_time, active)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (staff_id, weekday)
         DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, active = EXCLUDED.active`,
        [staffId, weekday, startTime, endTime, active]
      );
    }
    await client.query('COMMIT');

    const { rows } = await pool.query(
      `SELECT weekday, start_time, end_time, active
       FROM staff_working_hours
       WHERE staff_id = $1
       ORDER BY weekday ASC`,
      [staffId]
    );
    res.json(rows);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST staff hours error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/salons/:salonId/staff/:staffId
router.delete('/:salonId/staff/:staffId', requireSalonAccess, async (req, res) => {
  try {
    const { salonId, staffId } = req.params;
    const staffCheck = await pool.query(`SELECT id FROM staff WHERE id = $1 AND salon_id = $2`, [staffId, salonId]);
    if (staffCheck.rowCount === 0) return res.status(404).json({ error: 'Personnel introuvable' });
    await pool.query(`DELETE FROM staff WHERE id = $1 AND salon_id = $2`, [staffId, salonId]);
    res.json({ ok: true, message: 'Personnel supprimé' });
  } catch (err) {
    console.error('DELETE staff error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
