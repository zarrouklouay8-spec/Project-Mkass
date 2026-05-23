const router = require('express').Router();
const pool = require('../db/pool');
const { requireSalonAccess } = require('../middleware/auth');

function normalizeRate(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? n / 100 : n;
}

function cleanTime(value, fallback) {
  const v = String(value || fallback || '').slice(0, 5);
  return /^\d{2}:\d{2}$/.test(v) ? v : fallback;
}

async function ensureStaffSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id SERIAL PRIMARY KEY,
      salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      role TEXT DEFAULT '',
      active BOOLEAN DEFAULT true,
      commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE staff ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS role TEXT DEFAULT '';
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS staff_services (
      id SERIAL PRIMARY KEY,
      staff_id INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      service_id INT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      duration_minutes INT NOT NULL DEFAULT 30,
      UNIQUE(staff_id, service_id)
    );

    CREATE TABLE IF NOT EXISTS staff_working_hours (
      id SERIAL PRIMARY KEY,
      staff_id INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      weekday INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
      start_time TEXT NOT NULL DEFAULT '09:00',
      end_time TEXT NOT NULL DEFAULT '23:59',
      active BOOLEAN DEFAULT true,
      UNIQUE(staff_id, weekday)
    );

    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS staff_id INT REFERENCES staff(id) ON DELETE SET NULL;
    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS duration_minutes INT DEFAULT 30;
  `);
}

async function seedDefaultHours(staffId) {
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await pool.query(
      `INSERT INTO staff_working_hours (staff_id, weekday, start_time, end_time, active)
       VALUES ($1, $2, '09:00', '23:59', true)
       ON CONFLICT (staff_id, weekday) DO NOTHING`,
      [staffId, weekday]
    );
  }
}

function sendServerError(res, label, err) {
  console.error(label, err);
  return res.status(500).json({
    error: 'Erreur serveur personnel',
    details: err.message
  });
}

// Public staff list for booking selector: /api/salons/:salonId/public-staff
router.get('/:salonId/public-staff', async (req, res) => {
  try {
    await ensureStaffSchema();
    const { rows } = await pool.query(
      `SELECT id, salon_id, name, phone, role, active, commission_rate, created_at
       FROM staff
       WHERE salon_id = $1 AND active = true
       ORDER BY created_at ASC`,
      [req.params.salonId]
    );
    res.json(rows);
  } catch (err) {
    return sendServerError(res, 'GET public staff error:', err);
  }
});

// GET /api/salons/:salonId/staff
router.get('/:salonId/staff', requireSalonAccess, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { rows } = await pool.query(
      `SELECT id, salon_id, name, phone, role, active, commission_rate, created_at
       FROM staff
       WHERE salon_id = $1
       ORDER BY created_at ASC`,
      [req.params.salonId]
    );
    res.json(rows);
  } catch (err) {
    return sendServerError(res, 'GET staff error:', err);
  }
});

// POST /api/salons/:salonId/staff
router.post('/:salonId/staff', requireSalonAccess, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { name, phone, role, active, commission_rate, commissionRate } = req.body;
    const finalName = String(name || '').trim();
    if (!finalName) return res.status(400).json({ error: 'Nom du personnel obligatoire' });

    const { rows } = await pool.query(
      `INSERT INTO staff (salon_id, name, phone, role, active, commission_rate)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.params.salonId,
        finalName,
        String(phone || '').trim(),
        String(role || '').trim(),
        active !== false,
        normalizeRate(commission_rate ?? commissionRate)
      ]
    );

    await seedDefaultHours(rows[0].id);
    res.status(201).json(rows[0]);
  } catch (err) {
    return sendServerError(res, 'POST staff error:', err);
  }
});

// PUT /api/salons/:salonId/staff/:staffId
router.put('/:salonId/staff/:staffId', requireSalonAccess, async (req, res) => {
  try {
    await ensureStaffSchema();
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
        name !== undefined ? String(name).trim() : null,
        phone !== undefined ? String(phone).trim() : null,
        role !== undefined ? String(role).trim() : null,
        typeof active === 'boolean' ? active : null,
        commission_rate !== undefined || commissionRate !== undefined ? normalizeRate(commission_rate ?? commissionRate) : null,
        staffId,
        salonId
      ]
    );

    if (!rows.length) return res.status(404).json({ error: 'Personnel introuvable' });
    await seedDefaultHours(staffId);
    res.json(rows[0]);
  } catch (err) {
    return sendServerError(res, 'PUT staff error:', err);
  }
});

// GET /api/salons/:salonId/staff/:staffId/services
router.get('/:salonId/staff/:staffId/services', requireSalonAccess, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { rows } = await pool.query(
      `SELECT ss.id, ss.staff_id, ss.service_id, ss.duration_minutes,
              s.name AS service_name, s.price, s.category
       FROM staff_services ss
       JOIN services s ON s.id = ss.service_id
       JOIN staff st ON st.id = ss.staff_id
       WHERE ss.staff_id = $1 AND st.salon_id = $2
       ORDER BY s.name ASC`,
      [req.params.staffId, req.params.salonId]
    );
    res.json(rows);
  } catch (err) {
    return sendServerError(res, 'GET staff services error:', err);
  }
});

// PUT /api/salons/:salonId/staff/:staffId/services - replace all staff services
router.put('/:salonId/staff/:staffId/services', requireSalonAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureStaffSchema();
    const { salonId, staffId } = req.params;
    const serviceIds = Array.isArray(req.body.serviceIds)
      ? req.body.serviceIds.map(Number).filter(Boolean)
      : [];
    const durationMinutes = Number(req.body.durationMinutes || req.body.duration_minutes || 30) || 30;

    const staffCheck = await client.query(
      `SELECT id FROM staff WHERE id = $1 AND salon_id = $2`,
      [staffId, salonId]
    );
    if (staffCheck.rowCount === 0) return res.status(404).json({ error: 'Personnel introuvable' });

    await client.query('BEGIN');
    await client.query(`DELETE FROM staff_services WHERE staff_id = $1`, [staffId]);

    for (const serviceId of serviceIds) {
      const serviceCheck = await client.query(
        `SELECT id FROM services WHERE id = $1 AND salon_id = $2`,
        [serviceId, salonId]
      );
      if (serviceCheck.rowCount === 0) continue;

      await client.query(
        `INSERT INTO staff_services (staff_id, service_id, duration_minutes)
         VALUES ($1, $2, $3)
         ON CONFLICT (staff_id, service_id)
         DO UPDATE SET duration_minutes = EXCLUDED.duration_minutes`,
        [staffId, serviceId, durationMinutes]
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
    return sendServerError(res, 'PUT staff services error:', err);
  } finally {
    client.release();
  }
});

// GET /api/salons/:salonId/staff/:staffId/hours
router.get('/:salonId/staff/:staffId/hours', requireSalonAccess, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { salonId, staffId } = req.params;
    const staffCheck = await pool.query(
      `SELECT id FROM staff WHERE id = $1 AND salon_id = $2`,
      [staffId, salonId]
    );
    if (staffCheck.rowCount === 0) return res.status(404).json({ error: 'Personnel introuvable' });
    await seedDefaultHours(staffId);

    const { rows } = await pool.query(
      `SELECT weekday, start_time, end_time, active
       FROM staff_working_hours
       WHERE staff_id = $1
       ORDER BY weekday ASC`,
      [staffId]
    );
    res.json(rows);
  } catch (err) {
    return sendServerError(res, 'GET staff hours error:', err);
  }
});

// POST /api/salons/:salonId/staff/:staffId/hours
router.post('/:salonId/staff/:staffId/hours', requireSalonAccess, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureStaffSchema();
    const { salonId, staffId } = req.params;
    const hours = Array.isArray(req.body.hours) ? req.body.hours : [];
    if (!hours.length) return res.status(400).json({ error: 'Horaires invalides' });

    const staffCheck = await client.query(
      `SELECT id FROM staff WHERE id = $1 AND salon_id = $2`,
      [staffId, salonId]
    );
    if (staffCheck.rowCount === 0) return res.status(404).json({ error: 'Personnel introuvable' });

    await client.query('BEGIN');
    for (const h of hours) {
      const weekday = Number(h.weekday);
      if (weekday < 0 || weekday > 6) continue;

      await client.query(
        `INSERT INTO staff_working_hours (staff_id, weekday, start_time, end_time, active)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (staff_id, weekday)
         DO UPDATE SET
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           active = EXCLUDED.active`,
        [
          staffId,
          weekday,
          cleanTime(h.start_time || h.startTime, '09:00'),
          cleanTime(h.end_time || h.endTime, '23:59'),
          h.active !== false
        ]
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
    return sendServerError(res, 'POST staff hours error:', err);
  } finally {
    client.release();
  }
});

// DELETE /api/salons/:salonId/staff/:staffId
router.delete('/:salonId/staff/:staffId', requireSalonAccess, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { salonId, staffId } = req.params;
    const staffCheck = await pool.query(
      `SELECT id FROM staff WHERE id = $1 AND salon_id = $2`,
      [staffId, salonId]
    );
    if (staffCheck.rowCount === 0) return res.status(404).json({ error: 'Personnel introuvable' });
    await pool.query(`DELETE FROM staff WHERE id = $1 AND salon_id = $2`, [staffId, salonId]);
    res.json({ ok: true, message: 'Personnel supprimé' });
  } catch (err) {
    return sendServerError(res, 'DELETE staff error:', err);
  }
});

module.exports = router;
