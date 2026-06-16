const router = require('express').Router();
const pool = require('../db/pool');
const bcrypt = require('bcryptjs');
const { requireSalonAccess, requireStaffOrSalonAccess, requireStaffAccount, requireProPlan, getSalonPlan } = require('../middleware/auth');
const { notifySalon } = require('../services/pushService');

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
      commission_rate NUMERIC(5,4),
      username TEXT UNIQUE,
      password_hash TEXT,
      account_active BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE staff ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS role TEXT DEFAULT '';
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,4);
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS account_active BOOLEAN DEFAULT false;
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
// Starter salons should not expose staff selection; they use simple salon-wide booking.
router.get('/:salonId/public-staff', async (req, res) => {
  try {
    const salon = await getSalonPlan(req.params.salonId);
    if (!salon) return res.status(404).json({ error: 'Salon not found' });
    if (String(salon.subscription_status || 'active').toLowerCase() !== 'active') return res.json([]);
    if (String(salon.plan || 'starter').toLowerCase() !== 'pro') return res.json([]);

    await ensureStaffSchema();
    const { rows } = await pool.query(
      `SELECT id, salon_id, name, phone, role, active, commission_rate, username, account_active, created_at
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
router.get('/:salonId/staff', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { rows } = await pool.query(
      `SELECT id, salon_id, name, phone, role, active, commission_rate, username, account_active, created_at
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
router.post('/:salonId/staff', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { name, phone, role, active, commission_rate, commissionRate, username, password, account_active, accountActive } = req.body;
    const finalName = String(name || '').trim();
    if (!finalName) return res.status(400).json({ error: 'Nom du personnel obligatoire' });

    const finalUsername = username ? String(username).toLowerCase().trim() : null;
    const finalPasswordHash = password ? await bcrypt.hash(String(password), 10) : null;
    const explicitAccountActive = account_active ?? accountActive;
    const finalAccountActive = password ? true : Boolean(explicitAccountActive ?? (finalUsername && finalPasswordHash));

    const { rows } = await pool.query(
      `INSERT INTO staff (salon_id, name, phone, role, active, commission_rate, username, password_hash, account_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, salon_id, name, phone, role, active, commission_rate, username, account_active, created_at`,
      [
        req.params.salonId,
        finalName,
        String(phone || '').trim(),
        String(role || '').trim(),
        active !== false,
        commission_rate !== undefined || commissionRate !== undefined ? normalizeRate(commission_rate ?? commissionRate) : null,
        finalUsername,
        finalPasswordHash,
        finalAccountActive
      ]
    );

    await seedDefaultHours(rows[0].id);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ce login personnel existe déjà. Choisissez un autre login.' });
    }
    return sendServerError(res, 'POST staff error:', err);
  }
});



// POST /api/salons/:salonId/staff/full-save
// Robust one-call save used by the frontend Personnel screen: staff + services + hours.
router.post('/:salonId/staff/full-save', requireSalonAccess, requireProPlan, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureStaffSchema();
    const { salonId } = req.params;
    const body = req.body || {};
    const staffId = body.id || body.staffId || body.staff_id || null;
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nom du personnel obligatoire' });

    const phone = String(body.phone || '').trim();
    const role = String(body.role || '').trim();
    const active = body.active !== false;
    const commissionRate = normalizeRate(body.commission_rate ?? body.commissionRate ?? 0);
    const username = body.username ? String(body.username).toLowerCase().trim() : null;
    const passwordHash = body.password ? await bcrypt.hash(String(body.password), 10) : null;
    const accountActive = body.password ? true : Boolean(body.account_active ?? body.accountActive ?? username);
    const serviceIds = Array.isArray(body.serviceIds)
      ? body.serviceIds.map(Number).filter(Boolean)
      : [];
    const hours = Array.isArray(body.hours) ? body.hours : [];

    await client.query('BEGIN');

    let saved;
    if (staffId) {
      const { rows } = await client.query(
        `UPDATE staff SET
           name = $1,
           phone = $2,
           role = $3,
           active = $4,
           commission_rate = $5,
           username = $6,
           password_hash = COALESCE($7, password_hash),
           account_active = $8
         WHERE id = $9 AND salon_id = $10
         RETURNING id, salon_id, name, phone, role, active, commission_rate, username, account_active, created_at`,
        [name, phone, role, active, commissionRate, username, passwordHash, accountActive, staffId, salonId]
      );
      if (!rows.length) throw Object.assign(new Error('Personnel introuvable'), { statusCode: 404 });
      saved = rows[0];
    } else {
      const { rows } = await client.query(
        `INSERT INTO staff (salon_id, name, phone, role, active, commission_rate, username, password_hash, account_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, salon_id, name, phone, role, active, commission_rate, username, account_active, created_at`,
        [salonId, name, phone, role, active, commissionRate, username, passwordHash, accountActive]
      );
      saved = rows[0];
    }

    await client.query(`DELETE FROM staff_services WHERE staff_id = $1`, [saved.id]);
    for (const serviceId of serviceIds) {
      const serviceCheck = await client.query(`SELECT id FROM services WHERE id = $1 AND salon_id = $2`, [serviceId, salonId]);
      if (serviceCheck.rowCount === 0) continue;
      await client.query(
        `INSERT INTO staff_services (staff_id, service_id, duration_minutes)
         VALUES ($1,$2,$3)
         ON CONFLICT (staff_id, service_id)
         DO UPDATE SET duration_minutes = EXCLUDED.duration_minutes`,
        [saved.id, serviceId, Number(body.durationMinutes || body.duration_minutes || 30) || 30]
      );
    }

    const finalHours = hours.length ? hours : [0,1,2,3,4,5,6].map(weekday => ({ weekday, active: true, start_time: '09:00', end_time: '23:59' }));
    for (const h of finalHours) {
      const weekday = Number(h.weekday);
      if (weekday < 0 || weekday > 6) continue;
      await client.query(
        `INSERT INTO staff_working_hours (staff_id, weekday, start_time, end_time, active)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (staff_id, weekday)
         DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, active = EXCLUDED.active`,
        [saved.id, weekday, cleanTime(h.start_time || h.startTime, '09:00'), cleanTime(h.end_time || h.endTime, '23:59'), h.active !== false]
      );
    }

    await client.query('COMMIT');
    return res.status(staffId ? 200 : 201).json(saved);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Ce login personnel existe déjà. Choisissez un autre login.' });
    return sendServerError(res, 'POST staff full-save error:', err);
  } finally {
    client.release();
  }
});

// PUT /api/salons/:salonId/staff/:staffId
router.put('/:salonId/staff/:staffId', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { salonId, staffId } = req.params;
    const { name, phone, role, active, commission_rate, commissionRate, username, password, account_active, accountActive } = req.body;
    const finalUsername = username !== undefined ? String(username || '').toLowerCase().trim() || null : undefined;
    const finalPasswordHash = password ? await bcrypt.hash(String(password), 10) : undefined;
    const explicitAccountActive = account_active ?? accountActive;
    const finalAccountActive = password
      ? true
      : (account_active !== undefined || accountActive !== undefined ? Boolean(explicitAccountActive) : undefined);

    const { rows } = await pool.query(
      `UPDATE staff SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         role = COALESCE($3, role),
         active = COALESCE($4, active),
         commission_rate = COALESCE($5, commission_rate),
         username = COALESCE($6, username),
         password_hash = COALESCE($7, password_hash),
         account_active = COALESCE($8, account_active)
       WHERE id = $9 AND salon_id = $10
       RETURNING id, salon_id, name, phone, role, active, commission_rate, username, account_active, created_at`,
      [
        name !== undefined ? String(name).trim() : null,
        phone !== undefined ? String(phone).trim() : null,
        role !== undefined ? String(role).trim() : null,
        typeof active === 'boolean' ? active : null,
        commission_rate !== undefined || commissionRate !== undefined ? normalizeRate(commission_rate ?? commissionRate) : null,
        finalUsername === undefined ? null : finalUsername,
        finalPasswordHash === undefined ? null : finalPasswordHash,
        finalAccountActive === undefined ? null : finalAccountActive,
        staffId,
        salonId
      ]
    );

    if (!rows.length) return res.status(404).json({ error: 'Personnel introuvable' });
    await seedDefaultHours(staffId);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ce login personnel existe déjà. Choisissez un autre login.' });
    }
    return sendServerError(res, 'PUT staff error:', err);
  }
});

// GET /api/salons/:salonId/staff/:staffId/services
router.get('/:salonId/staff/:staffId/services', requireSalonAccess, requireProPlan, async (req, res) => {
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



// POST /api/salons/:salonId/staff/full-save
// Robust one-call save used by the frontend Personnel screen: staff + services + hours.
router.post('/:salonId/staff/full-save', requireSalonAccess, requireProPlan, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureStaffSchema();
    const { salonId } = req.params;
    const body = req.body || {};
    const staffId = body.id || body.staffId || body.staff_id || null;
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nom du personnel obligatoire' });

    const phone = String(body.phone || '').trim();
    const role = String(body.role || '').trim();
    const active = body.active !== false;
    const commissionRate = normalizeRate(body.commission_rate ?? body.commissionRate ?? 0);
    const username = body.username ? String(body.username).toLowerCase().trim() : null;
    const passwordHash = body.password ? await bcrypt.hash(String(body.password), 10) : null;
    const accountActive = body.password ? true : Boolean(body.account_active ?? body.accountActive ?? username);
    const serviceIds = Array.isArray(body.serviceIds)
      ? body.serviceIds.map(Number).filter(Boolean)
      : [];
    const hours = Array.isArray(body.hours) ? body.hours : [];

    await client.query('BEGIN');

    let saved;
    if (staffId) {
      const { rows } = await client.query(
        `UPDATE staff SET
           name = $1,
           phone = $2,
           role = $3,
           active = $4,
           commission_rate = $5,
           username = $6,
           password_hash = COALESCE($7, password_hash),
           account_active = $8
         WHERE id = $9 AND salon_id = $10
         RETURNING id, salon_id, name, phone, role, active, commission_rate, username, account_active, created_at`,
        [name, phone, role, active, commissionRate, username, passwordHash, accountActive, staffId, salonId]
      );
      if (!rows.length) throw Object.assign(new Error('Personnel introuvable'), { statusCode: 404 });
      saved = rows[0];
    } else {
      const { rows } = await client.query(
        `INSERT INTO staff (salon_id, name, phone, role, active, commission_rate, username, password_hash, account_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, salon_id, name, phone, role, active, commission_rate, username, account_active, created_at`,
        [salonId, name, phone, role, active, commissionRate, username, passwordHash, accountActive]
      );
      saved = rows[0];
    }

    await client.query(`DELETE FROM staff_services WHERE staff_id = $1`, [saved.id]);
    for (const serviceId of serviceIds) {
      const serviceCheck = await client.query(`SELECT id FROM services WHERE id = $1 AND salon_id = $2`, [serviceId, salonId]);
      if (serviceCheck.rowCount === 0) continue;
      await client.query(
        `INSERT INTO staff_services (staff_id, service_id, duration_minutes)
         VALUES ($1,$2,$3)
         ON CONFLICT (staff_id, service_id)
         DO UPDATE SET duration_minutes = EXCLUDED.duration_minutes`,
        [saved.id, serviceId, Number(body.durationMinutes || body.duration_minutes || 30) || 30]
      );
    }

    const finalHours = hours.length ? hours : [0,1,2,3,4,5,6].map(weekday => ({ weekday, active: true, start_time: '09:00', end_time: '23:59' }));
    for (const h of finalHours) {
      const weekday = Number(h.weekday);
      if (weekday < 0 || weekday > 6) continue;
      await client.query(
        `INSERT INTO staff_working_hours (staff_id, weekday, start_time, end_time, active)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (staff_id, weekday)
         DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, active = EXCLUDED.active`,
        [saved.id, weekday, cleanTime(h.start_time || h.startTime, '09:00'), cleanTime(h.end_time || h.endTime, '23:59'), h.active !== false]
      );
    }

    await client.query('COMMIT');
    return res.status(staffId ? 200 : 201).json(saved);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Ce login personnel existe déjà. Choisissez un autre login.' });
    return sendServerError(res, 'POST staff full-save error:', err);
  } finally {
    client.release();
  }
});

// PUT /api/salons/:salonId/staff/:staffId/services - replace all staff services
router.put('/:salonId/staff/:staffId/services', requireSalonAccess, requireProPlan, async (req, res) => {
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
router.get('/:salonId/staff/:staffId/hours', requireSalonAccess, requireProPlan, async (req, res) => {
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
router.post('/:salonId/staff/:staffId/hours', requireSalonAccess, requireProPlan, async (req, res) => {
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
router.delete('/:salonId/staff/:staffId', requireSalonAccess, requireProPlan, async (req, res) => {
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


// GET /api/salons/:salonId/staff/me/appointments
// Limited personnel account: sees only own schedule.
router.get('/:salonId/staff/me/appointments', requireStaffOrSalonAccess, requireProPlan, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { salonId } = req.params;
    const staffId = req.user.role === 'staff' ? req.user.staffId : Number(req.query.staffId || req.body.staffId);
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });

    if (req.user.role === 'staff' && Number(req.user.staffId) !== Number(staffId)) {
      return res.status(403).json({ error: 'Personnel limité à son propre planning' });
    }

    const { date, status } = req.query;
    const params = [salonId, staffId];
    let sql = `SELECT a.*, st.name AS staff_name
               FROM appointments a
               LEFT JOIN staff st ON st.id = a.staff_id
               WHERE a.salon_id = $1
                 AND (a.staff_id = $2 OR a.staff_id IS NULL)`;
    if (date) { params.push(date); sql += ` AND a.appt_date = $${params.length}`; }
    if (status) { params.push(status); sql += ` AND a.status = $${params.length}`; }
    sql += ` ORDER BY a.appt_date ASC, a.appt_time ASC`;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    return sendServerError(res, 'GET staff me appointments error:', err);
  }
});

// PATCH /api/salons/:salonId/staff/me/appointments/:id/status
// Personnel can confirm or mark own appointments done/no-show.
router.patch('/:salonId/staff/me/appointments/:id/status', requireStaffOrSalonAccess, requireProPlan, async (req, res) => {
  try {
    const allowed = new Set(['confirmed', 'done', 'no_show', 'cancelled']);
    const status = String(req.body.status || '').trim();
    if (!allowed.has(status)) {
      return res.status(400).json({ error: 'Status autorisé: confirmed, done, no_show, cancelled' });
    }

    const staffId = req.user.role === 'staff' ? req.user.staffId : Number(req.body.staffId || req.query.staffId);
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });

    const apptRes = await pool.query(
      `SELECT * FROM appointments WHERE id = $1 AND salon_id = $2`,
      [req.params.id, req.params.salonId]
    );

    if (!apptRes.rows.length) return res.status(404).json({ error: 'Rendez-vous introuvable' });
    const appt = apptRes.rows[0];

    if (appt.staff_id && Number(appt.staff_id) !== Number(staffId)) {
      return res.status(403).json({ error: 'Ce rendez-vous est déjà pris par un autre membre du personnel' });
    }

    // If the client chose "Peu importe", the RDV is unassigned.
    // The first staff member who confirms/done/no-show claims it, unless they already have a conflict.
    const shouldClaim = !appt.staff_id && status !== 'cancelled';
    if (shouldClaim) {
      const conflict = await pool.query(
        `SELECT id FROM appointments
         WHERE salon_id = $1
           AND staff_id = $2
           AND appt_date = $3
           AND appt_time = $4
           AND id <> $5
           AND status NOT IN ('cancelled','no_show')
         LIMIT 1`,
        [req.params.salonId, staffId, appt.appt_date, appt.appt_time, req.params.id]
      );
      if (conflict.rows.length) {
        return res.status(409).json({ error: 'Vous avez déjà un rendez-vous sur ce créneau' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE appointments
       SET status = $1,
           staff_id = CASE WHEN staff_id IS NULL AND $5 = true THEN $4 ELSE staff_id END
       WHERE id = $2
         AND salon_id = $3
         AND (staff_id = $4 OR staff_id IS NULL)
       RETURNING *`,
      [status, req.params.id, req.params.salonId, staffId, shouldClaim]
    );

    if (!rows.length) return res.status(404).json({ error: 'Rendez-vous introuvable pour ce personnel' });

    const eventType = shouldClaim
      ? 'appointment_claimed'
      : status === 'confirmed'
        ? 'appointment_confirmed'
        : status === 'cancelled'
          ? 'appointment_cancelled'
          : status === 'done'
            ? 'appointment_done'
            : status === 'no_show'
              ? 'appointment_no_show'
              : 'appointment_status_changed';

    notifySalon(req.params.salonId, eventType, rows[0]).catch(err => console.warn('push notify failed:', err.message));

    res.json(rows[0]);
  } catch (err) {
    return sendServerError(res, 'PATCH staff me appointment status error:', err);
  }
});

// POST /api/salons/:salonId/staff/me/walkin
// Personnel can add walk-in only for themselves.
router.post('/:salonId/staff/me/walkin', requireStaffOrSalonAccess, requireProPlan, async (req, res) => {
  try {
    const staffId = req.user.role === 'staff' ? req.user.staffId : Number(req.body.staffId || req.query.staffId);
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });

    const { services, prices, total, payMode, paymentMode, payment, clientName, customerName, customer_name, name } = req.body;
    if (!services?.length) return res.status(400).json({ error: 'services are required' });

    const finalClientName = [clientName, customerName, customer_name, name]
      .find(v => typeof v === 'string' && v.trim() !== '') || 'Client';
    const finalPayMode = payMode || paymentMode || payment || 'cash';
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 5);
    const id = 'MKS-WI-' + Date.now();

    const { rows } = await pool.query(
      `INSERT INTO appointments (
        id, salon_id, client_name, client_phone, services, prices, total,
        appt_date, appt_time, status, note, type, pay_mode, staff_id, duration_minutes
       ) VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8,'done','','walkin',$9,$10,$11)
       RETURNING *`,
      [
        id,
        req.params.salonId,
        finalClientName,
        services,
        prices || [],
        Number(total || 0),
        date,
        time,
        finalPayMode,
        staffId,
        Number(req.body.durationMinutes || req.body.duration_minutes || 30)
      ]
    );

    notifySalon(req.params.salonId, 'staff_walkin_created', rows[0]).catch(err => console.warn('push notify failed:', err.message));

    res.status(201).json(rows[0]);
  } catch (err) {
    return sendServerError(res, 'POST staff me walkin error:', err);
  }
});

module.exports = router;
