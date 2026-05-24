// src/db/migrate.js
// Run once: npm run db:migrate
require('dotenv').config();
const pool = require('./pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── SALONS ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS salons (
        id          TEXT PRIMARY KEY,           -- slug e.g. "salon-nour"
        name        TEXT NOT NULL,
        username    TEXT UNIQUE NOT NULL,       -- login username
        password    TEXT NOT NULL,             -- bcrypt hash
        icon        TEXT DEFAULT '✂️',
        type        TEXT DEFAULT 'mixte',      -- salon | barbershop | mixte | enfant
        address     TEXT DEFAULT '',
        dist        TEXT DEFAULT '',
        status      TEXT DEFAULT 'open',       -- open | busy | closed
        rating      NUMERIC(3,1) DEFAULT 5.0,
        review_count INT DEFAULT 0,
        tags        TEXT[] DEFAULT '{}',
        child_cut   BOOLEAN DEFAULT false,
        color       TEXT DEFAULT '#C8FF00',
       cover_img   TEXT,                      -- base64 or URL
map_url     TEXT,
lat         DOUBLE PRECISION,
lng         DOUBLE PRECISION,
phone       TEXT,
plan        TEXT DEFAULT 'starter',
        subscription_status TEXT DEFAULT 'active',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS map_url TEXT;`);
await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;`);
await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;`);
await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS phone TEXT;`);
await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'starter';`);
await client.query(`UPDATE salons SET plan = 'starter' WHERE plan IS NULL OR plan = '';`);
await client.query(`ALTER TABLE salons ALTER COLUMN plan SET DEFAULT 'starter';`);
await client.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active';`);
    // ── SERVICES ─────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS services (
        id          SERIAL PRIMARY KEY,
        salon_id    TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
        category    TEXT NOT NULL DEFAULT 'Autre',
        name        TEXT NOT NULL,
        duration    TEXT NOT NULL DEFAULT '30 min',
        price       NUMERIC(8,2) NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // ── STAFF / PERSONNEL ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff (
        id          SERIAL PRIMARY KEY,
        salon_id    TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        phone       TEXT DEFAULT '',
        active      BOOLEAN DEFAULT true,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_services (
        id                SERIAL PRIMARY KEY,
        staff_id          INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        service_id        INT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
        duration_minutes  INT NOT NULL DEFAULT 30,
        UNIQUE(staff_id, service_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_working_hours (
        id          SERIAL PRIMARY KEY,
        staff_id    INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
        weekday     INT NOT NULL,
        start_time  TEXT NOT NULL DEFAULT '09:00',
        end_time    TEXT NOT NULL DEFAULT '18:00',
        active      BOOLEAN DEFAULT true,
        UNIQUE(staff_id, weekday)
      );
    `);

    // ── APPOINTMENTS ─────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id          TEXT PRIMARY KEY,           -- e.g. MKS-1001
        salon_id    TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
        client_name TEXT NOT NULL,
        client_phone TEXT DEFAULT '',
        services    TEXT[] NOT NULL DEFAULT '{}',
        prices      NUMERIC[] NOT NULL DEFAULT '{}',
        total       NUMERIC(8,2) NOT NULL DEFAULT 0,
        appt_date   DATE NOT NULL,
        appt_time   TEXT NOT NULL,
        status      TEXT DEFAULT 'pending',    -- pending | confirmed | done | cancelled
        note        TEXT DEFAULT '',
        type        TEXT DEFAULT 'booking',    -- booking | walkin
        pay_mode    TEXT DEFAULT 'online',
        staff_id    INT REFERENCES staff(id) ON DELETE SET NULL,
        duration_minutes INT DEFAULT 30,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS staff_id INT REFERENCES staff(id) ON DELETE SET NULL;
    `);

    await client.query(`
      ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS duration_minutes INT DEFAULT 30;
    `);
    // ── REVIEWS ──────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS reviews (
        id          SERIAL PRIMARY KEY,
        salon_id    TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL,
        stars       INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
        text        TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── SUBSCRIPTIONS / PAYMENTS ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        salon_id TEXT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
        plan TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        provider TEXT,
        provider_payment_id TEXT,
        amount NUMERIC(8,2),
        currency TEXT DEFAULT 'TND',
        payment_url TEXT,
        starts_at TIMESTAMPTZ,
        ends_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_events (
        id SERIAL PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_payment_id TEXT,
        event_type TEXT,
        payload JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // ── INDEXES ──────────────────────────────────────────────
    await client.query(`CREATE INDEX IF NOT EXISTS idx_appt_salon   ON appointments(salon_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_appt_date    ON appointments(appt_date);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_svc_salon    ON services(salon_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_review_salon ON reviews(salon_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sub_salon ON subscriptions(salon_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_salons_plan ON salons(plan);`);

    // Better indexes for booking / staff scheduling performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appointments_salon_date
      ON appointments (salon_id, appt_date);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appointments_staff_date
      ON appointments (staff_id, appt_date);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_appointments_salon_date_time
      ON appointments (salon_id, appt_date, appt_time);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_staff_salon
      ON staff (salon_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_staff_services_service
      ON staff_services (service_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_staff_services_staff
      ON staff_services (staff_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_staff_working_hours_staff_weekday
      ON staff_working_hours (staff_id, weekday);
    `);

    await client.query('COMMIT');
    console.log('✅ Migration complete — all tables created.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
