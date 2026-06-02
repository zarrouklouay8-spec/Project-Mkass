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
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    return next();
  });
}

// Gérant/admin access only. Staff members must use staff-specific routes.
function requireSalonAccess(req, res, next) {
  requireAuth(req, res, () => {
    const salonId = String(req.params.salonId || req.body.salonId || '');
    if (req.user.role === 'admin') return next();
    if (req.user.role === 'gerant' && String(req.user.salonId) === salonId) return next();
    return res.status(403).json({ error: 'Access denied to this salon' });
  });
}

// Staff can access only limited routes for their own salon.
function requireStaffOrSalonAccess(req, res, next) {
  requireAuth(req, res, () => {
    const salonId = String(req.params.salonId || req.body.salonId || '');
    if (req.user.role === 'admin') return next();
    if ((req.user.role === 'gerant' || req.user.role === 'staff') && String(req.user.salonId) === salonId) return next();
    return res.status(403).json({ error: 'Access denied to this salon' });
  });
}

function requireStaffAccount(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'staff' || !req.user.staffId) {
      return res.status(403).json({ error: 'Staff account required' });
    }
    return next();
  });
}

async function getSalonPlan(salonId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(plan, 'starter') AS plan,
       COALESCE(subscription_status, 'active') AS subscription_status,
       subscription_due_at,
       subscription_blocked_reason
     FROM salons
     WHERE id = $1`,
    [salonId]
  );
  return rows[0] || null;
}

function isSubscriptionActive(status) {
  return String(status || 'active').toLowerCase() === 'active';
}

// Blocks paid navigation/API access when the subscription is not active.
// Admin bypasses. Use on gérant/staff protected routes that should stop when unpaid.
async function requireActiveSubscription(req, res, next) {
  try {
    if (req.user?.role === 'admin') return next();

    const salonId = req.params.salonId || req.body.salonId || req.user?.salonId;
    if (!salonId) return res.status(400).json({ error: 'salonId is required' });

    const salon = await getSalonPlan(salonId);
    if (!salon) return res.status(404).json({ error: 'Salon not found' });

    const status = String(salon.subscription_status || 'active').toLowerCase();
    if (!isSubscriptionActive(status)) {
      return res.status(402).json({
        error: 'Votre abonnement doit être activé pour continuer.',
        code: 'SUBSCRIPTION_REQUIRED',
        plan: salon.plan || 'starter',
        subscriptionStatus: status,
        subscriptionDueAt: salon.subscription_due_at || null,
        reason: salon.subscription_blocked_reason || null,
      });
    }

    req.salonPlan = String(salon.plan || 'starter').toLowerCase();
    req.subscriptionStatus = status;
    return next();
  } catch (err) {
    console.error('requireActiveSubscription error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Use after requireSalonAccess / requireStaffOrSalonAccess.
// Admins bypass. Pro also requires active subscription.
async function requireProPlan(req, res, next) {
  try {
    if (req.user?.role === 'admin') return next();

    const salonId = req.params.salonId || req.body.salonId || req.user?.salonId;
    if (!salonId) return res.status(400).json({ error: 'salonId is required' });

    const salon = await getSalonPlan(salonId);
    if (!salon) return res.status(404).json({ error: 'Salon not found' });

    const plan = String(salon.plan || 'starter').toLowerCase();
    const status = String(salon.subscription_status || 'active').toLowerCase();

    if (!isSubscriptionActive(status)) {
      return res.status(402).json({
        error: 'Votre abonnement doit être activé pour continuer.',
        code: 'SUBSCRIPTION_REQUIRED',
        plan,
        subscriptionStatus: status,
        subscriptionDueAt: salon.subscription_due_at || null,
        reason: salon.subscription_blocked_reason || null,
      });
    }

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

module.exports = {
  requireAuth,
  requireAdmin,
  requireSalonAccess,
  requireStaffOrSalonAccess,
  requireStaffAccount,
  requireActiveSubscription,
  requireProPlan,
  getSalonPlan,
};
