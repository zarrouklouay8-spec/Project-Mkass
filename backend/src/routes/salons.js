// src/routes/salons.js
const router = require('express').Router();
const pool = require('../db/pool');
const bcrypt = require('bcryptjs');
const { requireAdmin, requireSalonAccess, requireActiveSubscription } = require('../middleware/auth');

function toMinutes(time) {
  const [h, m] = String(time).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

function overlaps(startA, durationA, startB, durationB) {
  const endA = startA + durationA;
  const endB = startB + durationB;
  return startA < endB && startB < endA;
}


let schedulingSchemaReadyPromise = null;

async function ensureSchedulingSchema() {
  if (schedulingSchemaReadyPromise) return schedulingSchemaReadyPromise;

  schedulingSchemaReadyPromise = (async () => {
    // Make the slots/hours routes tolerant of older test/prod databases.
    // The canonical column used by current code is `weekday`; older fixes used `day_of_week`.
    await pool.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
    await pool.query(`UPDATE services SET active = true WHERE active IS NULL;`);

    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
    await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS account_active BOOLEAN DEFAULT false;`);
    await pool.query(`UPDATE staff SET active = true WHERE active IS NULL;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff_services (
        id SERIAL PRIMARY KEY,
        staff_id INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        service_id INT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        duration_minutes INT NOT NULL DEFAULT 30,
        active BOOLEAN DEFAULT true
      );
    `);
    await pool.query(`ALTER TABLE staff_services ADD COLUMN IF NOT EXISTS duration_minutes INT DEFAULT 30;`);
    await pool.query(`ALTER TABLE staff_services ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
    await pool.query(`UPDATE staff_services SET duration_minutes = 30 WHERE duration_minutes IS NULL;`);
    await pool.query(`UPDATE staff_services SET active = true WHERE active IS NULL;`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_services_staff_service_unique ON staff_services(staff_id, service_id);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS staff_working_hours (
        id SERIAL PRIMARY KEY,
        staff_id INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        weekday INT,
        day_of_week INT,
        start_time TEXT DEFAULT '09:00',
        end_time TEXT DEFAULT '23:59',
        active BOOLEAN DEFAULT true
      );
    `);
    await pool.query(`ALTER TABLE staff_working_hours ADD COLUMN IF NOT EXISTS weekday INT;`);
    await pool.query(`ALTER TABLE staff_working_hours ADD COLUMN IF NOT EXISTS day_of_week INT;`);
    await pool.query(`ALTER TABLE staff_working_hours ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
    await pool.query(`ALTER TABLE staff_working_hours ADD COLUMN IF NOT EXISTS start_time TEXT DEFAULT '09:00';`);
    await pool.query(`ALTER TABLE staff_working_hours ADD COLUMN IF NOT EXISTS end_time TEXT DEFAULT '23:59';`);
    await pool.query(`UPDATE staff_working_hours SET weekday = COALESCE(weekday, day_of_week, 0);`);
    await pool.query(`UPDATE staff_working_hours SET day_of_week = COALESCE(day_of_week, weekday, 0);`);
    await pool.query(`UPDATE staff_working_hours SET active = true WHERE active IS NULL;`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_working_hours_staff_weekday_unique ON staff_working_hours(staff_id, weekday);`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS salon_opening_hours (
        id SERIAL PRIMARY KEY,
        salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
        weekday INT,
        day_of_week INT,
        active BOOLEAN DEFAULT true,
        is_open BOOLEAN DEFAULT true,
        start_time TEXT DEFAULT '09:00',
        end_time TEXT DEFAULT '23:59',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`ALTER TABLE salon_opening_hours ADD COLUMN IF NOT EXISTS weekday INT;`);
    await pool.query(`ALTER TABLE salon_opening_hours ADD COLUMN IF NOT EXISTS day_of_week INT;`);
    await pool.query(`ALTER TABLE salon_opening_hours ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
    await pool.query(`ALTER TABLE salon_opening_hours ADD COLUMN IF NOT EXISTS is_open BOOLEAN DEFAULT true;`);
    await pool.query(`ALTER TABLE salon_opening_hours ADD COLUMN IF NOT EXISTS start_time TEXT DEFAULT '09:00';`);
    await pool.query(`ALTER TABLE salon_opening_hours ADD COLUMN IF NOT EXISTS end_time TEXT DEFAULT '23:59';`);
    await pool.query(`ALTER TABLE salon_opening_hours ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`);
    await pool.query(`UPDATE salon_opening_hours SET weekday = COALESCE(weekday, day_of_week, 0);`);
    await pool.query(`UPDATE salon_opening_hours SET day_of_week = COALESCE(day_of_week, weekday, 0);`);
    await pool.query(`UPDATE salon_opening_hours SET active = COALESCE(active, is_open, true);`);
    await pool.query(`UPDATE salon_opening_hours SET is_open = COALESCE(is_open, active, true);`);
    await pool.query(`UPDATE salon_opening_hours SET start_time = COALESCE(NULLIF(start_time, ''), '09:00');`);
    await pool.query(`UPDATE salon_opening_hours SET end_time = COALESCE(NULLIF(end_time, ''), '23:59');`);
    await pool.query(`
      INSERT INTO salon_opening_hours (salon_id, weekday, day_of_week, active, is_open, start_time, end_time)
      SELECT s.id, d.weekday, d.weekday, true, true, '09:00', '23:59'
      FROM salons s
      CROSS JOIN (
        SELECT 0 AS weekday UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL
        SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
      ) d
      WHERE NOT EXISTS (
        SELECT 1 FROM salon_opening_hours h
        WHERE h.salon_id = s.id AND COALESCE(h.weekday, h.day_of_week) = d.weekday
      );
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_salon_opening_hours_salon_weekday_unique ON salon_opening_hours(salon_id, weekday);`);

    await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS staff_id INT REFERENCES staff(id) ON DELETE SET NULL;`);
    await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS duration_minutes INT DEFAULT 30;`);
    await pool.query(`UPDATE appointments SET duration_minutes = 30 WHERE duration_minutes IS NULL;`);
  })();

  try {
    await schedulingSchemaReadyPromise;
  } catch (err) {
    schedulingSchemaReadyPromise = null;
    throw err;
  }
}

// Public - list all salons for Explore page
router.get('/', async (req, res) => {
  try {
    const { type, status, search } = req.query;

    let query = `
      SELECT s.*,
        COALESCE(
          (
            SELECT json_agg(r ORDER BY r.created_at DESC)
            FROM reviews r
            WHERE r.salon_id = s.id
          ),
          '[]'
        ) AS reviews,
        COUNT(DISTINCT a.id) AS total_appointments
      FROM salons s
      LEFT JOIN appointments a ON a.salon_id = s.id
    `;

    const conditions = [];
    const params = [];

    if (type && type !== 'all') {
      params.push(type);
      conditions.push(`s.type = $${params.length}`);
    }

    if (status) {
      params.push(status);
      conditions.push(`s.status = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(s.name ILIKE $${params.length} OR s.address ILIKE $${params.length})`);
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += `
      GROUP BY s.id
      ORDER BY total_appointments DESC, s.rating DESC, s.created_at ASC
    `;

    const { rows } = await pool.query(query, params);
    rows.forEach(row => delete row.password);

    res.json(rows);
  } catch (err) {
    console.error('GET /api/salons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Gerant - get salon opening hours
router.get('/:salonId/hours', requireSalonAccess, requireActiveSubscription, async (req, res) => {
  try {
    await ensureSchedulingSchema();
    const { salonId } = req.params;

    const { rows } = await pool.query(
      `SELECT weekday, active, start_time, end_time
       FROM salon_opening_hours
       WHERE salon_id = $1
       ORDER BY weekday`,
      [salonId]
    );

    res.json(rows);
  } catch (err) {
    console.error('GET /api/salons/:salonId/hours error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Gerant - update salon opening hours
router.put('/:salonId/hours', requireSalonAccess, requireActiveSubscription, async (req, res) => {
  await ensureSchedulingSchema();
  const client = await pool.connect();

  try {
    const { salonId } = req.params;
    const { hours } = req.body;

    if (!Array.isArray(hours)) {
      return res.status(400).json({ error: 'hours must be an array' });
    }

    await client.query('BEGIN');

    for (const h of hours) {
      const weekday = Number(h.weekday);
      const active = Boolean(h.active);
      const startTime = String(h.start_time || h.startTime || '09:00').slice(0, 5);
      const endTime = String(h.end_time || h.endTime || '18:00').slice(0, 5);

      if (weekday < 0 || weekday > 6) continue;

      await client.query(
        `INSERT INTO salon_opening_hours (
           salon_id,
           weekday,
           active,
           start_time,
           end_time
         )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (salon_id, weekday)
         DO UPDATE SET
           active = EXCLUDED.active,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time`,
        [salonId, weekday, active, startTime, endTime]
      );
    }

    await client.query('COMMIT');

    const { rows } = await pool.query(
      `SELECT weekday, active, start_time, end_time
       FROM salon_opening_hours
       WHERE salon_id = $1
       ORDER BY weekday`,
      [salonId]
    );

    res.json(rows);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/salons/:salonId/hours error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Public - slots based on salon opening hours, plan, staff, and service duration
router.get('/:salonId/slots', async (req, res) => {
  try {
    await ensureSchedulingSchema();
    const { salonId } = req.params;
    const { date, serviceIds, staffId } = req.query;
    const requestedStaffId = staffId ? Number(staffId) : null;

    if (!date) {
      return res.status(400).json({ error: 'Date obligatoire' });
    }

    const requestedServiceIds = String(serviceIds || '')
      .split(',')
      .map(x => Number(x.trim()))
      .filter(Boolean);

    const allSlots = [
      '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
      '12:00', '12:30', '13:00', '13:30',
      '14:00', '14:30', '15:00', '15:30',
      '16:00', '16:30', '17:00', '17:30',
      '18:00', '18:30', '19:00', '19:30',
      '20:00', '20:30', '21:00', '21:30',
      '22:00', '22:30', '23:00', '23:30'
    ];

    const selectedDate = new Date(date + 'T12:00:00');
    const weekday = selectedDate.getDay();

    const { rows: salonHoursRows } = await pool.query(
      `SELECT active, start_time, end_time
       FROM salon_opening_hours
       WHERE salon_id = $1
         AND weekday = $2`,
      [salonId, weekday]
    );

    let allowedSlots = allSlots;

    if (salonHoursRows.length) {
      const h = salonHoursRows[0];

      if (!h.active) {
        return res.json(allSlots.map(time => ({
          time,
          available: false,
          staffId: null,
          staffName: null,
          durationMinutes: 30
        })));
      }

      const openStart = toMinutes(h.start_time);
      const openEnd = toMinutes(h.end_time);

      allowedSlots = allSlots.filter(time => {
        const slotStart = toMinutes(time);
        return slotStart >= openStart && slotStart < openEnd;
      });
    }

    // Basic availability when no service is selected.
    // TC-016 fix: if a specific staff member is selected, do NOT return global salon slots.
    // Return slots for that staff member only, based on staff hours + staff appointments.
    if (requestedServiceIds.length === 0) {
      if (requestedStaffId) {
        const { rows: staffRows } = await pool.query(
          `SELECT id AS staff_id, name AS staff_name
           FROM staff
           WHERE salon_id = $1
             AND id = $2
             AND active = true`,
          [salonId, requestedStaffId]
        );

        if (!staffRows.length) {
          return res.json(allowedSlots.map(time => ({
            time,
            available: false,
            staffId: requestedStaffId,
            staffName: null,
            durationMinutes: 30
          })));
        }

        const staff = staffRows[0];

        const { rows: hoursRows } = await pool.query(
          `SELECT staff_id, weekday, start_time, end_time, active
           FROM staff_working_hours
           WHERE staff_id = $1
             AND weekday = $2`,
          [requestedStaffId, weekday]
        );

        const { rows: apptRows } = await pool.query(
          `SELECT staff_id, appt_time, duration_minutes
           FROM appointments
           WHERE salon_id = $1
             AND appt_date = $2
             AND status NOT IN ('cancelled','no_show')
             AND staff_id = $3`,
          [salonId, date, requestedStaffId]
        );

        const result = allowedSlots.map(time => {
          const slotStart = toMinutes(time);
          const duration = 30;
          const hours = hoursRows[0];

          let available = true;

          if (hours && hours.active === false) available = false;

          if (available && hours) {
            const workStart = toMinutes(hours.start_time);
            const workEnd = toMinutes(hours.end_time);
            const slotEnd = slotStart + duration;
            if (slotStart < workStart || slotEnd > workEnd) available = false;
          }

          if (available) {
            available = !apptRows.some(appt => overlaps(
              slotStart,
              duration,
              toMinutes(appt.appt_time),
              Number(appt.duration_minutes || 30)
            ));
          }

          return {
            time,
            available,
            staffId: Number(staff.staff_id),
            staffName: staff.staff_name,
            durationMinutes: duration
          };
        });

        return res.json(result);
      }

      const { rows: bookedRows } = await pool.query(
        `SELECT appt_time
         FROM appointments
         WHERE salon_id = $1
           AND appt_date = $2
           AND status NOT IN ('cancelled','no_show')`,
        [salonId, date]
      );

      const bookedTimes = new Set(bookedRows.map(r => String(r.appt_time).slice(0, 5)));

      return res.json(allowedSlots.map(time => ({
        time,
        available: !bookedTimes.has(time),
        staffId: null,
        staffName: null,
        durationMinutes: 30
      })));
    }

    const { rows: salonPlanRows } = await pool.query(
      `SELECT plan FROM salons WHERE id = $1`,
      [salonId]
    );

    const salonPlan = String(salonPlanRows[0]?.plan || 'starter').toLowerCase();

    // Starter plan uses simple slot availability
    if (salonPlan !== 'pro') {
      const { rows: bookedRows } = await pool.query(
        `SELECT appt_time
         FROM appointments
         WHERE salon_id = $1
           AND appt_date = $2
           AND status NOT IN ('cancelled','no_show')`,
        [salonId, date]
      );

      const bookedTimes = new Set(bookedRows.map(r => String(r.appt_time).slice(0, 5)));

      return res.json(allowedSlots.map(time => ({
        time,
        available: !bookedTimes.has(time),
        staffId: null,
        staffName: null,
        durationMinutes: 30
      })));
    }

    // Pro plan: smart staff/service availability
    const staffParams = [salonId, requestedServiceIds, requestedServiceIds.length];
    let staffFilterSql = '';

    if (requestedStaffId) {
      staffParams.push(requestedStaffId);
      staffFilterSql = `AND st.id = $${staffParams.length}`;
    }

    const { rows: staffRows } = await pool.query(
      `SELECT
         st.id AS staff_id,
         st.name AS staff_name,
         SUM(ss.duration_minutes) AS total_duration,
         COUNT(DISTINCT ss.service_id) AS matched_services
       FROM staff st
       JOIN staff_services ss ON ss.staff_id = st.id
       WHERE st.salon_id = $1
         AND st.active = true
         AND ss.service_id = ANY($2::int[])
         ${staffFilterSql}
       GROUP BY st.id, st.name
       HAVING COUNT(DISTINCT ss.service_id) = $3`,
      staffParams
    );

    if (staffRows.length === 0) {
      return res.json(allowedSlots.map(time => ({
        time,
        available: false,
        staffId: null,
        staffName: null,
        durationMinutes: 0
      })));
    }

    const { rows: apptRows } = await pool.query(
      `SELECT staff_id, appt_time, duration_minutes
       FROM appointments
       WHERE salon_id = $1
         AND appt_date = $2
         AND status NOT IN ('cancelled','no_show')
         AND staff_id IS NOT NULL`,
      [salonId, date]
    );

    const { rows: hoursRows } = await pool.query(
      `SELECT staff_id, weekday, start_time, end_time, active
       FROM staff_working_hours
       WHERE staff_id = ANY($1::int[])
         AND weekday = $2`,
      [staffRows.map(s => Number(s.staff_id)), weekday]
    );

    const result = allowedSlots.map(time => {
      const slotStart = toMinutes(time);

      const availableStaff = staffRows.find(staff => {
        const staffIdNumber = Number(staff.staff_id);
        const duration = Number(staff.total_duration || 30);

        const hours = hoursRows.find(h => Number(h.staff_id) === staffIdNumber);

        // If no staff working hours were configured yet, keep old behavior.
        if (hours && hours.active === false) return false;

        if (hours) {
          const workStart = toMinutes(hours.start_time);
          const workEnd = toMinutes(hours.end_time);
          const slotEnd = slotStart + duration;

          if (slotStart < workStart || slotEnd > workEnd) return false;
        }

        const staffAppointments = apptRows.filter(a => Number(a.staff_id) === staffIdNumber);

        return !staffAppointments.some(appt => overlaps(
          slotStart,
          duration,
          toMinutes(appt.appt_time),
          Number(appt.duration_minutes || 30)
        ));
      });

      return {
        time,
        available: Boolean(availableStaff),
        staffId: availableStaff ? Number(availableStaff.staff_id) : null,
        staffName: availableStaff ? availableStaff.staff_name : null,
        durationMinutes: availableStaff ? Number(availableStaff.total_duration || 30) : 0
      };
    });

    res.json(result);
  } catch (err) {
    console.error('GET /api/salons/:salonId/slots error:', err);
    res.status(500).json({
      error: 'Server error',
      details: err.message
    });
  }
});

// Public - single salon with services, reviews, appointment count
router.get('/:salonId', async (req, res) => {
  try {
    const { salonId } = req.params;

    const [salonRes, servicesRes, reviewsRes] = await Promise.all([
      pool.query(
        `SELECT s.*,
          COUNT(DISTINCT a.id) AS total_appointments
         FROM salons s
         LEFT JOIN appointments a ON a.salon_id = s.id
         WHERE s.id = $1
         GROUP BY s.id`,
        [salonId]
      ),
      pool.query(
        `SELECT *
         FROM services
         WHERE salon_id = $1
         ORDER BY category, name`,
        [salonId]
      ),
      pool.query(
        `SELECT *
         FROM reviews
         WHERE salon_id = $1
         ORDER BY created_at DESC`,
        [salonId]
      ),
    ]);

    if (!salonRes.rows.length) {
      return res.status(404).json({ error: 'Salon not found' });
    }

    const salon = salonRes.rows[0];
    delete salon.password;

    res.json({
      ...salon,
      services: servicesRes.rows,
      reviews: reviewsRes.rows,
    });
  } catch (err) {
    console.error('GET /api/salons/:salonId error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Gerant updates their own salon settings
router.put('/:salonId', requireSalonAccess, requireActiveSubscription, async (req, res) => {
  try {
    const { salonId } = req.params;

    const {
      name,
      address,
      status,
      icon,
      tags,
      childCut
    } = req.body;

    const hasCoverImg =
      Object.prototype.hasOwnProperty.call(req.body, 'cover_img') ||
      Object.prototype.hasOwnProperty.call(req.body, 'coverImg');

    const coverImg = Object.prototype.hasOwnProperty.call(req.body, 'cover_img')
      ? req.body.cover_img
      : req.body.coverImg;

    const mapUrl = req.body.map_url || req.body.mapUrl || null;

    const lat =
      req.body.lat !== undefined &&
      req.body.lat !== null &&
      req.body.lat !== ''
        ? Number(req.body.lat)
        : null;

    const lng =
      req.body.lng !== undefined &&
      req.body.lng !== null &&
      req.body.lng !== ''
        ? Number(req.body.lng)
        : null;

    const { rows } = await pool.query(
      `UPDATE salons SET
        name       = COALESCE($1, name),
        address    = COALESCE($2, address),
        status     = COALESCE($3, status),
        icon       = COALESCE($4, icon),
        tags       = COALESCE($5, tags),
        child_cut  = COALESCE($6, child_cut),
        cover_img  = CASE WHEN $7 THEN $8 ELSE cover_img END,
        map_url    = COALESCE($9, map_url),
        lat        = COALESCE($10, lat),
        lng        = COALESCE($11, lng)
       WHERE id = $12
       RETURNING *`,
      [
        name,
        address,
        status,
        icon,
        tags,
        childCut,
        hasCoverImg,
        coverImg,
        mapUrl,
        lat,
        lng,
        salonId
      ]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Salon not found' });
    }

    delete rows[0].password;
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/salons/:salonId error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin only - create a new salon / gerant account
router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      name,
      username,
      password,
      icon,
      type,
      address,
      dist,
      tags,
      childCut,
      color
    } = req.body;

    const mapUrl = req.body.map_url || req.body.mapUrl || null;
    const plan = req.body.plan || 'starter';

    if (!name || !username || !password) {
      return res.status(400).json({
        error: 'name, username and password are required'
      });
    }

    const id = username.toLowerCase().replace(/\s+/g, '-');
    const hash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      `INSERT INTO salons (
        id,
        name,
        username,
        password,
        icon,
        type,
        address,
        dist,
        tags,
        child_cut,
        color,
        map_url,
        plan,
        subscription_status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')
      RETURNING *`,
      [
        id,
        name,
        username.toLowerCase(),
        hash,
        icon || '',
        type || 'mixte',
        address || '',
        dist || '',
        tags || [],
        childCut || false,
        color || '#28d36b',
        mapUrl,
        plan
      ]
    );

    const defaultSvcs = getDefaultServices(type || 'mixte');

    for (const sv of defaultSvcs) {
      await pool.query(
        `INSERT INTO services (salon_id, category, name, duration, price)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, sv.cat, sv.name, sv.dur, sv.price]
      );
    }

    delete rows[0].password;
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username already exists' });
    }

    console.error('POST /api/salons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin only
router.delete('/:salonId', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM salons WHERE id = $1', [req.params.salonId]);
    res.json({ message: 'Salon deleted' });
  } catch (err) {
    console.error('DELETE /api/salons/:salonId error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

function getDefaultServices(type) {
  const all = [
    { cat: 'Coupe', name: 'Coupe femme', dur: '45 min', price: 35, types: ['salon', 'mixte'] },
    { cat: 'Coupe', name: 'Coupe homme', dur: '30 min', price: 20, types: ['barbershop', 'mixte'] },
    { cat: 'Coupe', name: 'Coupe enfant', dur: '20 min', price: 15, types: ['salon', 'barbershop', 'mixte', 'enfant'] },
    { cat: 'Couleur', name: 'Coloration complète', dur: '90 min', price: 80, types: ['salon', 'mixte'] },
    { cat: 'Couleur', name: 'Balayage / Mèches', dur: '120 min', price: 120, types: ['salon', 'mixte'] },
    { cat: 'Soin', name: 'Brushing', dur: '30 min', price: 25, types: ['salon', 'mixte', 'enfant'] },
    { cat: 'Barbe', name: 'Taille de barbe', dur: '20 min', price: 15, types: ['barbershop', 'mixte'] },
    { cat: 'Barbe', name: 'Barbe + coupe', dur: '50 min', price: 35, types: ['barbershop', 'mixte'] },
    { cat: 'Ongles', name: 'Manucure', dur: '40 min', price: 30, types: ['salon', 'mixte'] },
  ];

  return all.filter(service => service.types.includes(type));
}

module.exports = router;
