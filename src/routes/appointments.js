// src/routes/appointments.js
const router = require('express').Router();
const pool = require('../db/pool');
const { requireSalonAccess } = require('../middleware/auth');


function cleanPhone(phone) {
  return String(phone || '').replace(/\s+/g, '').trim();
}

async function getSalonRules(salonId) {
  const { rows } = await pool.query(
    `SELECT * FROM salon_rules WHERE salon_id = $1`,
    [salonId]
  );
  return rows[0] || {
    no_show_enabled: true,
    no_show_limit: 1,
    no_show_window_days: 30,
    ban_duration_days: 30,
    ban_message: 'Ce numéro est temporairement bloqué suite à une réservation non honorée. Veuillez contacter le salon.',
    loyalty_enabled: true,
    loyalty_required_visits: 10,
    loyalty_reward_type: 'free_service',
    loyalty_reward_value: 100,
    loyalty_valid_days: 60
  };
}

async function checkClientBan(salonId, phone) {
  const finalPhone = cleanPhone(phone);
  if (!finalPhone) return null;

  const { rows } = await pool.query(
    `SELECT b.*, COALESCE(r.ban_message, 'Ce numéro est temporairement bloqué. Veuillez contacter le salon.') AS ban_message
     FROM banned_clients b
     LEFT JOIN salon_rules r ON r.salon_id = b.salon_id
     WHERE b.salon_id = $1
       AND b.phone = $2
       AND b.active = true
       AND (b.banned_until IS NULL OR b.banned_until >= CURRENT_DATE)
     ORDER BY b.created_at DESC
     LIMIT 1`,
    [salonId, finalPhone]
  );
  return rows[0] || null;
}

async function applyNoShowRules(salonId, appointment) {
  const rules = await getSalonRules(salonId);
  if (!rules.no_show_enabled) return;

  const phone = cleanPhone(appointment.client_phone);
  if (!phone) return;

  const windowDays = Number(rules.no_show_window_days || 30);
  const limit = Number(rules.no_show_limit || 1);
  const banDays = Number(rules.ban_duration_days || 30);

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM appointments
     WHERE salon_id = $1
       AND REPLACE(client_phone, ' ', '') = $2
       AND status = 'no_show'
       AND appt_date >= CURRENT_DATE - ($3::int * INTERVAL '1 day')`,
    [salonId, phone, windowDays]
  );

  const count = Number(rows[0]?.count || 0);
  if (count < limit) return;

  await pool.query(
    `UPDATE banned_clients
     SET active = false
     WHERE salon_id = $1
       AND phone = $2
       AND active = true`,
    [salonId, phone]
  );

  await pool.query(
    `INSERT INTO banned_clients (
      salon_id,
      phone,
      client_name,
      reason,
      no_show_count,
      banned_until,
      active
     )
     VALUES ($1,$2,$3,'no_show',$4,CURRENT_DATE + ($5::int * INTERVAL '1 day'),true)`,
    [salonId, phone, appointment.client_name || '', count, banDays]
  );
}

async function applyLoyaltyRules(salonId, appointment) {
  const rules = await getSalonRules(salonId);
  if (!rules.loyalty_enabled) return;

  const phone = cleanPhone(appointment.client_phone);
  if (!phone) return;

  const required = Number(rules.loyalty_required_visits || 10);
  const validDays = Number(rules.loyalty_valid_days || 60);

  const { rows } = await pool.query(
    `INSERT INTO loyalty_progress (
      salon_id,
      phone,
      client_name,
      visits_count,
      reward_status,
      reward_type,
      reward_value,
      updated_at
     )
     VALUES ($1,$2,$3,1,'progress',$4,$5,NOW())
     ON CONFLICT (salon_id, phone)
     DO UPDATE SET
       client_name = EXCLUDED.client_name,
       visits_count = loyalty_progress.visits_count + 1,
       updated_at = NOW()
     RETURNING *`,
    [salonId, phone, appointment.client_name || '', rules.loyalty_reward_type || 'free_service', Number(rules.loyalty_reward_value || 100)]
  );

  const progress = rows[0];
  if (Number(progress.visits_count || 0) >= required && progress.reward_status !== 'earned') {
    await pool.query(
      `UPDATE loyalty_progress SET
         reward_status = 'earned',
         reward_type = $1,
         reward_value = $2,
         earned_at = COALESCE(earned_at, NOW()),
         expires_at = COALESCE(expires_at, CURRENT_DATE + ($3::int * INTERVAL '1 day')),
         updated_at = NOW()
       WHERE salon_id = $4 AND phone = $5`,
      [rules.loyalty_reward_type || 'free_service', Number(rules.loyalty_reward_value || 100), validDays, salonId, phone]
    );
  }
}

// ── GET bookings by phone ────────────────────────────────────
// Public: /api/salons/appointments/by-phone?phone=...
router.get('/appointments/by-phone', async (req, res) => {
  try {
    let { phone } = req.query;

    if (!phone) {
      return res.status(400).json({ error: 'Numéro de téléphone obligatoire' });
    }

    phone = String(phone).replace(/\s+/g, '').trim();

    const { rows } = await pool.query(
      `SELECT 
         a.*,
         s.name AS salon_name
       FROM appointments a
       LEFT JOIN salons s ON s.id = a.salon_id
       WHERE REPLACE(a.client_phone, ' ', '') = $1
       ORDER BY a.appt_date DESC, a.appt_time DESC`,
      [phone]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET appointments ─────────────────────────────────────────
// Gérant: /api/salons/:salonId/appointments
router.get('/:salonId/appointments', requireSalonAccess, async (req, res) => {
  try {
    const { date, status, type } = req.query;
    let q = `
  SELECT 
    a.*,
    st.name AS staff_name
  FROM appointments a
  LEFT JOIN staff st ON st.id = a.staff_id
  WHERE a.salon_id = $1
`;
    const params = [req.params.salonId];

    if (date) {
  params.push(date);
  q += ` AND a.appt_date = $${params.length}`;
}

if (status) {
  params.push(status);
  q += ` AND a.status = $${params.length}`;
}

if (type) {
  params.push(type);
  q += ` AND a.type = $${params.length}`;
}

q += ' ORDER BY a.appt_date DESC, a.appt_time ASC';
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET today dashboard ──────────────────────────────────────
router.get('/:salonId/appointments/today', requireSalonAccess, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const { rows } = await pool.query(
      `SELECT *
       FROM appointments
       WHERE salon_id = $1
         AND appt_date = $2
       ORDER BY appt_time ASC`,
      [req.params.salonId, today]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET slots fallback ───────────────────────────────────────
// This is the old fallback slots route. Smart slots are in src/routes/salons.js.
// Keep this only for compatibility if something still calls /api/salons/:salonId/slots here.
router.get('/:salonId/slots', async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'date is required' });
    }

    const ALL_SLOTS = [
      '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
      '12:00', '14:00', '14:30', '15:00', '15:30', '16:00',
      '16:30', '17:00', '17:30'
    ];

    const { rows } = await pool.query(
      `SELECT appt_time
       FROM appointments
       WHERE salon_id = $1
         AND appt_date = $2
         AND status NOT IN ('cancelled','no_show')`,
      [req.params.salonId, date]
    );

    const taken = rows.map(r => String(r.appt_time).slice(0, 5));

    res.json(ALL_SLOTS.map(time => ({
      time,
      available: !taken.includes(time)
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST booking ─────────────────────────────────────────────
// Public customer booking.
// Saves staff_id and duration_minutes when smart slots selected a staff member.
router.post('/:salonId/appointments', async (req, res) => {
  try {
    let {
      clientName,
      customer_name,
      customerName,
      name,
      phone,
      clientPhone,
      services,
      service_names,
      prices,
      total,
      date,
      appointment_date,
      time,
      appointment_time,
      note,
      staff_id,
      staffId,
      duration_minutes,
      durationMinutes
    } = req.body;

    const finalStaffId = staff_id || staffId || null;
    const finalDurationMinutes = duration_minutes || durationMinutes || 30;

    const finalClientName = clientName || customer_name || customerName || name;
    const finalPhone = clientPhone || phone;

    if (!finalClientName) {
      return res.status(400).json({ error: 'Le nom du client est obligatoire' });
    }

    let cleanPhone = '';

    if (finalPhone) {
      cleanPhone = String(finalPhone).replace(/\s+/g, '');

      if (!/^[0-9]{8}$/.test(cleanPhone) && !/^\+216[0-9]{8}$/.test(cleanPhone)) {
        return res.status(400).json({ error: 'Numéro de téléphone invalide' });
      }
    }

    const now = new Date();
    const safeDate = date || appointment_date || now.toISOString().slice(0, 10);
    const safeTime = time || appointment_time || now.toTimeString().slice(0, 5);

    // Booking must be from tomorrow minimum
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const bookingDate = new Date(safeDate + 'T00:00:00');

    if (bookingDate < tomorrow) {
      return res.status(400).json({ error: 'La réservation doit être à partir de demain' });
    }

    const activeBan = await checkClientBan(req.params.salonId, cleanPhone);
    if (activeBan) {
      return res.status(403).json({
        error: activeBan.ban_message || 'Ce numéro est temporairement bloqué. Veuillez contacter le salon.',
        bannedUntil: activeBan.banned_until
      });
    }

    // Prevent double booking.
    // If staff_id exists, only block if that exact staff member is busy.
    // If staff_id is missing, fallback to old salon-wide conflict check.
    if (finalStaffId) {
      const conflict = await pool.query(
        `SELECT id
         FROM appointments
         WHERE salon_id = $1
           AND appt_date = $2
           AND appt_time = $3
           AND staff_id = $4
           AND status NOT IN ('cancelled','no_show')`,
        [req.params.salonId, safeDate, safeTime, finalStaffId]
      );

      if (conflict.rows.length > 0) {
        return res.status(409).json({
          error: 'Ce membre du personnel est déjà réservé à ce créneau'
        });
      }
    } else {
      const conflict = await pool.query(
        `SELECT id
         FROM appointments
         WHERE salon_id = $1
           AND appt_date = $2
           AND appt_time = $3
           AND status NOT IN ('cancelled','no_show')`,
        [req.params.salonId, safeDate, safeTime]
      );

      if (conflict.rows.length > 0) {
        return res.status(409).json({ error: 'Ce créneau est déjà réservé' });
      }
    }

    const id = 'MKS-' + Date.now();

    const { rows } = await pool.query(`
      INSERT INTO appointments (
        id,
        salon_id,
        client_name,
        client_phone,
        services,
        prices,
        total,
        appt_date,
        appt_time,
        status,
        note,
        type,
        pay_mode,
        staff_id,
        duration_minutes
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        'pending',$10,'booking','online',
        $11,$12
      )
      RETURNING *
    `, [
      id,
      req.params.salonId,
      finalClientName,
      cleanPhone,
      services || service_names || [],
      prices || [],
      total || 0,
      safeDate,
      safeTime,
      note || '',
      finalStaffId,
      finalDurationMinutes
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST walk-in ─────────────────────────────────────────────
router.post('/:salonId/appointments/walkin', requireSalonAccess, async (req, res) => {
  try {
    const {
      clientName,
      customerName,
      customer_name,
      name,
      services,
      prices,
      total,
      payMode,
      paymentMode,
      payment
    } = req.body;

    const finalClientName = [clientName, customerName, customer_name, name]
      .find(v => typeof v === 'string' && v.trim() !== '') || 'Client';

    const finalPayMode = payMode || paymentMode || payment || 'cash';

    if (!services?.length) {
      return res.status(400).json({ error: 'services are required' });
    }

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 5);

    const id = 'MKS-WI-' + Date.now();

    const { rows } = await pool.query(`
      INSERT INTO appointments (
        id,
        salon_id,
        client_name,
        client_phone,
        services,
        prices,
        total,
        appt_date,
        appt_time,
        status,
        note,
        type,
        pay_mode
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        'done','',
        'walkin',$10
      )
      RETURNING *
    `, [
      id,
      req.params.salonId,
      finalClientName,
      '',
      services,
      prices || [],
      total || 0,
      date,
      time,
      finalPayMode
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── UPDATE status ────────────────────────────────────────────
router.patch('/:salonId/appointments/:id/status', requireSalonAccess, async (req, res) => {
  try {
    const { status } = req.body;

    const { rows } = await pool.query(
      `UPDATE appointments
       SET status = $1
       WHERE id = $2
         AND salon_id = $3
       RETURNING *`,
      [status, req.params.id, req.params.salonId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (status === 'no_show') {
      await applyNoShowRules(req.params.salonId, rows[0]);
    }

    if (status === 'done') {
      await applyLoyaltyRules(req.params.salonId, rows[0]);
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
