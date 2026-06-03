// src/routes/staff.js
// REAL PERSONNEL FIX v2026-06-03
// Fixes staff save/list reliability and returns explicit errors for the Personnel screen.
const router = require('express').Router();
const pool = require('../db/pool');
const bcrypt = require('bcryptjs');
const { requireSalonAccess, requireStaffOrSalonAccess, requireStaffAccount, requireProPlan, getSalonPlan } = require('../middleware/auth');

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
      username TEXT,
      password_hash TEXT,
      account_active BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE staff ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS role TEXT DEFAULT '';
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,4);
    ALTER TABLE staff ADD COLUMN IF NOT EXISTS username TEXT;
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_username_unique
    ON staff (LOWER(username))
    WHERE username IS NOT NULL AND username <> '';
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
    code: err.code || 'STAFF_SERVER_ERROR',
    details: err.message,
    hint: 'Vérifiez npm run db:migrate, le plan Pro actif, et les logs Railway après POST staff error / GET staff error.'
  });
}

function normalizeStaffPayload(body) {
  const username = body.username || body.login || body.staffUsername || body.staff_username || null;
  const password = body.password || body.staffPassword || body.staff_password || null;
  return {
    name: body.name || body.fullName || body.full_name || '',
    phone: body.phone || body.tel || '',
    role: body.role || body.job || '',
    active: body.active !== false && body.is_active !== false,
    commission_rate: body.commission_rate ?? body.commissionRate ?? body.commission ?? null,
    username: username ? String(username).toLowerCase().trim() : null,
    password: password ? String(password) : null,
    account_active: body.account_active ?? body.accountActive ?? body.accountEnabled ?? null,
    serviceIds: Array.isArray(body.serviceIds) ? body.serviceIds : (Array.isArray(body.service_ids) ? body.service_ids : []),
    hours: Array.isArray(body.hours) ? body.hours : []
  };
}

async function replaceStaffServices(staffId, salonId, serviceIds, durationMinutes = 30, client = pool) {
  const staffCheck = await client.query(
    `SELECT id FROM staff WHERE id = $1 AND salon_id = $2`,
    [staffId, salonId]
  );
  if (staffCheck.rowCount === 0) {
    const err = new Error('Personnel introuvable');
    err.statusCode = 404;
    throw err;
  }

  await client.query(`DELETE FROM staff_services WHERE staff_id = $1`, [staffId]);
  for (const rawId of serviceIds || []) {
    const serviceId = Number(rawId);
    if (!serviceId) continue;
    await client.query(
      `INSERT INTO staff_services (staff_id, service_id, duration_minutes)
       VALUES ($1, $2, $3)
       ON CONFLICT (staff_id, service_id)
       DO UPDATE SET duration_minutes = EXCLUDED.duration_minutes`,
      [staffId, serviceId, Number(durationMinutes || 30)]
    );
  }
}

async function replaceStaffHours(staffId, salonId, hours, client = pool) {
  const staffCheck = await client.query(
    `SELECT id FROM staff WHERE id = $1 AND salon_id = $2`,
    [staffId, salonId]
  );
  if (staffCheck.rowCount === 0) {
    const err = new Error('Personnel introuvable');
    err.statusCode = 404;
    throw err;
  }

  const finalHours = Array.isArray(hours) && hours.length ? hours : [0,1,2,3,4,5,6].map(weekday => ({ weekday, start_time: '09:00', end_time: '23:59', active: true }));
  for (const h of finalHours) {
    await client.query(
      `INSERT INTO staff_working_hours (staff_id, weekday, start_time, end_time, active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (staff_id, weekday)
       DO UPDATE SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, active = EXCLUDED.active`,
      [staffId, Number(h.weekday), cleanTime(h.start_time || h.startTime, '09:00'), cleanTime(h.end_time || h.endTime, '23:59'), h.active !== false]
    );
  }
}


// GET /api/salons/:salonId/staff-health
// Use this from browser/Railway to verify the staff schema and access quickly.
router.get('/:salonId/staff-health', requireSalonAccess, async (req, res) => {
  try {
    await ensureStaffSchema();
    const salon = await getSalonPlan(req.params.salonId);
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM staff WHERE salon_id = $1', [req.params.salonId]);
    res.json({ ok: true, salonId: req.params.salonId, plan: salon?.plan || 'starter', subscriptionStatus: salon?.subscription_status || 'active', staffCount: count.rows[0]?.count || 0 });
  } catch (err) {
    return sendServerError(res, 'GET staff health error:', err);
  }
});

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
    const payload = normalizeStaffPayload(req.body || {});
    const finalName = String(payload.name || '').trim();
    if (!finalName) return res.status(400).json({ error: 'Nom du personnel obligatoire' });

    const finalUsername = payload.username || null;
    const finalPasswordHash = payload.password ? await bcrypt.hash(payload.password, 10) : null;
    const finalAccountActive = payload.password ? true : Boolean(payload.account_active ?? (finalUsername && finalPasswordHash));

    const { rows } = await pool.query(
      `INSERT INTO staff (salon_id, name, phone, role, active, commission_rate, username, password_hash, account_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, salon_id, name, phone, role, active, commission_rate, username, account_active, created_at`,
      [
        req.params.salonId,
        finalName,
        String(payload.phone || '').trim(),
        String(payload.role || '').trim(),
        payload.active !== false,
        payload.commission_rate !== null && payload.commission_rate !== undefined ? normalizeRate(payload.commission_rate) : null,
        finalUsername,
        finalPasswordHash,
        finalAccountActive
      ]
    );

    await seedDefaultHours(rows[0].id);
    if (payload.serviceIds.length) await replaceStaffServices(rows[0].id, req.params.salonId, payload.serviceIds);
    if (payload.hours.length) await replaceStaffHours(rows[0].id, req.params.salonId, payload.hours);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Ce login personnel existe déjà. Choisissez un autre login.' });
    }
    return sendServerError(res, 'POST staff error:', err);
  }
});

// PUT /api/salons/:salonId/staff/:staffId
router.put('/:salonId/staff/:staffId', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    await ensureStaffSchema();
    const { salonId, staffId } = req.params;
    const payload = normalizeStaffPayload(req.body || {});
    const rawBody = req.body || {};
    const finalUsername = ('username' in rawBody || 'login' in rawBody || 'staffUsername' in rawBody || 'staff_username' in rawBody)
      ? (payload.username || null)
      : undefined;
    const finalPasswordHash = payload.password ? await bcrypt.hash(payload.password, 10) : undefined;
    const finalAccountActive = payload.password
      ? true
      : (payload.account_active !== null && payload.account_active !== undefined ? Boolean(payload.account_active) : undefined);

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
        payload.name ? String(payload.name).trim() : null,
        ('phone' in rawBody || 'tel' in rawBody) ? String(payload.phone || '').trim() : null,
        ('role' in rawBody || 'job' in rawBody) ? String(payload.role || '').trim() : null,
        ('active' in rawBody || 'is_active' in rawBody) ? payload.active : null,
        payload.commission_rate !== null && payload.commission_rate !== undefined ? normalizeRate(payload.commission_rate) : null,
        finalUsername === undefined ? null : finalUsername,
        finalPasswordHash === undefined ? null : finalPasswordHash,
        finalAccountActive === undefined ? null : finalAccountActive,
        staffId,
        salonId
      ]
    );

    if (!rows.length) return res.status(404).json({ error: 'Personnel introuvable' });
    await seedDefaultHours(staffId);
    if (payload.serviceIds.length) await replaceStaffServices(staffId, salonId, payload.serviceIds);
    if (payload.hours.length) await replaceStaffHours(staffId, salonId, payload.hours);
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
               WHERE a.salon_id = $1 AND a.staff_id = $2`;
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
    const allowed = new Set(['confirmed', 'done', 'no_show']);
    const status = String(req.body.status || '').trim();
    if (!allowed.has(status)) {
      return res.status(400).json({ error: 'Status autorisé: confirmed, done, no_show' });
    }

    const staffId = req.user.role === 'staff' ? req.user.staffId : Number(req.body.staffId || req.query.staffId);
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });

    const { rows } = await pool.query(
      `UPDATE appointments
       SET status = $1
       WHERE id = $2 AND salon_id = $3 AND staff_id = $4
       RETURNING *`,
      [status, req.params.id, req.params.salonId, staffId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Rendez-vous introuvable pour ce personnel' });
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

    res.status(201).json(rows[0]);
  } catch (err) {
    return sendServerError(res, 'POST staff me walkin error:', err);
  }
});

module.exports = router;
