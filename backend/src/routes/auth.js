// src/routes/auth.js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

async function ensureLoginSchema() {
  // Login must not crash if Railway was deployed before the last migration ran.
  // These ALTER/CREATE statements are safe and idempotent.
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'starter';`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'active';`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS subscription_due_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE salons ADD COLUMN IF NOT EXISTS subscription_blocked_reason TEXT;`);
  await pool.query(`UPDATE salons SET plan = 'starter' WHERE plan IS NULL OR plan = '';`);
  await pool.query(`UPDATE salons SET subscription_status = 'active' WHERE subscription_status IS NULL OR subscription_status = '';`);

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
  `);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS phone TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS role TEXT DEFAULT '';`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,4);`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS account_active BOOLEAN DEFAULT false;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_staff_username ON staff(username);`);
}

function subscriptionBlockedPayload(salon) {
  const status = String(salon.subscription_status || 'active').toLowerCase();
  return {
    plan: salon.plan || 'starter',
    subscriptionStatus: status,
    subscription_status: status,
    subscriptionDueAt: salon.subscription_due_at || null,
    subscription_due_at: salon.subscription_due_at || null,
    subscriptionBlocked: status !== 'active',
    subscription_blocked: status !== 'active',
    subscriptionBlockedReason: salon.subscription_blocked_reason || null,
  };
}

// POST /api/auth/login
// Supports admin, gérant and limited personnel accounts.
router.post('/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').toLowerCase().trim();
    const { password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Admin login. Admin must keep working even if DB has a temporary issue.
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin';
    if (username === String(adminUser).toLowerCase()) {
      if (password !== adminPass) return res.status(401).json({ error: 'Identifiants incorrects' });
      const token = signToken({ role: 'admin', username: 'admin' });
      return res.json({ token, role: 'admin', salonId: null, salonName: 'Administrateur Mkass' });
    }

    await ensureLoginSchema();

    // Personnel login first. Staff usernames are unique.
    const staffRes = await pool.query(
      `SELECT
         st.id,
         st.salon_id,
         st.name,
         st.phone,
         st.role,
         st.active,
         st.commission_rate,
         st.username,
         st.password_hash,
         st.account_active,
         s.name AS salon_name,
         COALESCE(s.plan, 'starter') AS plan,
         COALESCE(s.subscription_status, 'active') AS subscription_status,
         s.subscription_due_at,
         s.subscription_blocked_reason
       FROM staff st
       JOIN salons s ON s.id = st.salon_id
       WHERE LOWER(st.username) = $1
       LIMIT 1`,
      [username]
    );

    if (staffRes.rows.length) {
      const staff = staffRes.rows[0];
      if (!staff.account_active || !staff.password_hash) {
        return res.status(403).json({
          error: 'Compte personnel désactivé ou mot de passe manquant. Le gérant doit activer l’accès personnel et définir un mot de passe.',
          code: 'STAFF_ACCOUNT_INACTIVE'
        });
      }

      const valid = await bcrypt.compare(String(password), staff.password_hash);
      if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

      const token = signToken({
        role: 'staff',
        salonId: staff.salon_id,
        staffId: staff.id,
        username: staff.username,
      });

      return res.json({
        token,
        role: 'staff',
        salonId: staff.salon_id,
        salonName: staff.salon_name,
        staffId: staff.id,
        staffName: staff.name,
        staffRole: staff.role || '',
        ...subscriptionBlockedPayload(staff),
      });
    }

    // Gérant login
    const { rows } = await pool.query(
      `SELECT
         *,
         COALESCE(plan, 'starter') AS plan,
         COALESCE(subscription_status, 'active') AS subscription_status
       FROM salons
       WHERE LOWER(username) = $1`,
      [username]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Identifiants incorrects' });

    const salon = rows[0];
    const valid = await bcrypt.compare(String(password), salon.password);
    if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

    const token = signToken({ role: 'gerant', salonId: salon.id, username: salon.username });
    return res.json({
      token,
      role: 'gerant',
      salonId: salon.id,
      salonName: salon.name,
      icon: salon.icon,
      ...subscriptionBlockedPayload(salon),
    });
  } catch (err) {
    console.error('Login error:', err);
    // Return the PostgreSQL code in development/Railway logs only; frontend still gets a safe message.
    res.status(500).json({ error: 'Server error', code: err.code || 'LOGIN_FAILED' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters' });
    }
    if (req.user.role === 'admin') {
      return res.status(400).json({ error: 'Admin password is set via environment variable' });
    }

    await ensureLoginSchema();

    if (req.user.role === 'staff') {
      const { rows } = await pool.query('SELECT * FROM staff WHERE id = $1', [req.user.staffId]);
      if (!rows.length) return res.status(404).json({ error: 'Staff account not found' });
      const valid = await bcrypt.compare(String(currentPassword), rows[0].password_hash || '');
      if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
      const hash = await bcrypt.hash(String(newPassword), 10);
      await pool.query('UPDATE staff SET password_hash = $1 WHERE id = $2', [hash, req.user.staffId]);
      return res.json({ message: 'Password updated successfully' });
    }

    const { rows } = await pool.query('SELECT * FROM salons WHERE id = $1', [req.user.salonId]);
    if (!rows.length) return res.status(404).json({ error: 'Salon not found' });
    const valid = await bcrypt.compare(String(currentPassword), rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query('UPDATE salons SET password = $1 WHERE id = $2', [hash, req.user.salonId]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', code: err.code || 'PASSWORD_CHANGE_FAILED' });
  }
});

module.exports = router;
