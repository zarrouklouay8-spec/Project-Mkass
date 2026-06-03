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

    // Admin login
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin';
    if (username === String(adminUser).toLowerCase()) {
      if (password !== adminPass) return res.status(401).json({ error: 'Identifiants incorrects' });
      const token = signToken({ role: 'admin', username: 'admin' });
      return res.json({ token, role: 'admin', salonId: null, salonName: 'Administrateur Mkass' });
    }

    // Personnel login first. Staff usernames are unique.
    const staffRes = await pool.query(
      `SELECT
         st.*,
         s.name AS salon_name,
         s.plan,
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
      const valid = await bcrypt.compare(password, staff.password_hash);
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
      `SELECT * FROM salons WHERE LOWER(username) = $1`,
      [username]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Identifiants incorrects' });

    const salon = rows[0];
    const valid = await bcrypt.compare(password, salon.password);
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
    res.status(500).json({ error: 'Server error' });
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

    if (req.user.role === 'staff') {
      const { rows } = await pool.query('SELECT * FROM staff WHERE id = $1', [req.user.staffId]);
      if (!rows.length) return res.status(404).json({ error: 'Staff account not found' });
      const valid = await bcrypt.compare(currentPassword, rows[0].password_hash || '');
      if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
      const hash = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE staff SET password_hash = $1 WHERE id = $2', [hash, req.user.staffId]);
      return res.json({ message: 'Password updated successfully' });
    }

    const { rows } = await pool.query('SELECT * FROM salons WHERE id = $1', [req.user.salonId]);
    if (!rows.length) return res.status(404).json({ error: 'Salon not found' });
    const valid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE salons SET password = $1 WHERE id = $2', [hash, req.user.salonId]);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
