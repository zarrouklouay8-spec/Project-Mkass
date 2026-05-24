// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

function requireSalonAccess(req, res, next) {
  requireAuth(req, res, () => {
    const salonId = req.params.salonId || req.body.salonId;
    if (req.user.role === 'admin' || req.user.salonId === salonId) {
      return next();
    }
    return res.status(403).json({ error: 'Access denied to this salon' });
  });
}

async function getSalonPlan(salonId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(plan, 'starter') AS plan,
            COALESCE(subscription_status, 'active') AS subscription_status
     FROM salons
     WHERE id = $1`,
    [salonId]
  );
  return rows[0] || null;
}

// Use after requireSalonAccess. Admins bypass this check.
async function requireProPlan(req, res, next) {
  try {
    if (req.user?.role === 'admin') return next();

    const salonId = req.params.salonId || req.body.salonId || req.user?.salonId;
    if (!salonId) {
      return res.status(400).json({ error: 'salonId is required' });
    }

    const salon = await getSalonPlan(salonId);
    if (!salon) {
      return res.status(404).json({ error: 'Salon not found' });
    }

    const plan = String(salon.plan || 'starter').toLowerCase();
    const status = String(salon.subscription_status || 'active').toLowerCase();

    if (plan !== 'pro') {
      return res.status(403).json({
        error: 'Cette fonction est disponible avec le pack Pro.',
        code: 'PRO_REQUIRED',
        plan,
        subscriptionStatus: status,
      });
    }

    req.salonPlan = plan;
    req.subscriptionStatus = status;
    return next();
  } catch (err) {
    console.error('requireProPlan error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { requireAuth, requireAdmin, requireSalonAccess, requireProPlan, getSalonPlan };
