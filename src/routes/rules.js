const router = require('express').Router();
const pool = require('../db/pool');
const { requireSalonAccess, requireProPlan } = require('../middleware/auth');

const DEFAULT_RULES = {
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

async function ensureRules(salonId) {
  const { rows } = await pool.query(
    `INSERT INTO salon_rules (
      salon_id,
      no_show_enabled,
      no_show_limit,
      no_show_window_days,
      ban_duration_days,
      ban_message,
      loyalty_enabled,
      loyalty_required_visits,
      loyalty_reward_type,
      loyalty_reward_value,
      loyalty_valid_days
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (salon_id) DO NOTHING
    RETURNING *`,
    [
      salonId,
      DEFAULT_RULES.no_show_enabled,
      DEFAULT_RULES.no_show_limit,
      DEFAULT_RULES.no_show_window_days,
      DEFAULT_RULES.ban_duration_days,
      DEFAULT_RULES.ban_message,
      DEFAULT_RULES.loyalty_enabled,
      DEFAULT_RULES.loyalty_required_visits,
      DEFAULT_RULES.loyalty_reward_type,
      DEFAULT_RULES.loyalty_reward_value,
      DEFAULT_RULES.loyalty_valid_days
    ]
  );

  if (rows.length) return rows[0];

  const existing = await pool.query(`SELECT * FROM salon_rules WHERE salon_id = $1`, [salonId]);
  return existing.rows[0] || { salon_id: salonId, ...DEFAULT_RULES };
}

// GET /api/salons/:salonId/rules
router.get('/:salonId/rules', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    const rules = await ensureRules(req.params.salonId);
    res.json(rules);
  } catch (err) {
    console.error('GET rules error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/salons/:salonId/rules
router.put('/:salonId/rules', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    const { salonId } = req.params;
    await ensureRules(salonId);

    const {
      no_show_enabled,
      no_show_limit,
      no_show_window_days,
      ban_duration_days,
      ban_message,
      loyalty_enabled,
      loyalty_required_visits,
      loyalty_reward_type,
      loyalty_reward_value,
      loyalty_valid_days
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE salon_rules SET
         no_show_enabled = COALESCE($1, no_show_enabled),
         no_show_limit = COALESCE($2, no_show_limit),
         no_show_window_days = COALESCE($3, no_show_window_days),
         ban_duration_days = COALESCE($4, ban_duration_days),
         ban_message = COALESCE($5, ban_message),
         loyalty_enabled = COALESCE($6, loyalty_enabled),
         loyalty_required_visits = COALESCE($7, loyalty_required_visits),
         loyalty_reward_type = COALESCE($8, loyalty_reward_type),
         loyalty_reward_value = COALESCE($9, loyalty_reward_value),
         loyalty_valid_days = COALESCE($10, loyalty_valid_days),
         updated_at = NOW()
       WHERE salon_id = $11
       RETURNING *`,
      [
        typeof no_show_enabled === 'boolean' ? no_show_enabled : null,
        no_show_limit ? Number(no_show_limit) : null,
        no_show_window_days ? Number(no_show_window_days) : null,
        ban_duration_days ? Number(ban_duration_days) : null,
        ban_message || null,
        typeof loyalty_enabled === 'boolean' ? loyalty_enabled : null,
        loyalty_required_visits ? Number(loyalty_required_visits) : null,
        loyalty_reward_type || null,
        loyalty_reward_value !== undefined ? Number(loyalty_reward_value) : null,
        loyalty_valid_days ? Number(loyalty_valid_days) : null,
        salonId
      ]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('PUT rules error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/salons/:salonId/banned-clients
router.get('/:salonId/banned-clients', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, salon_id, phone, client_name, reason, no_show_count, banned_until, active, created_at
       FROM banned_clients
       WHERE salon_id = $1
         AND active = true
         AND (banned_until IS NULL OR banned_until >= CURRENT_DATE)
       ORDER BY created_at DESC`,
      [req.params.salonId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET banned clients error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/salons/:salonId/banned-clients/:banId
router.delete('/:salonId/banned-clients/:banId', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    const { salonId, banId } = req.params;
    const { rowCount } = await pool.query(
      `UPDATE banned_clients SET active = false WHERE salon_id = $1 AND id = $2`,
      [salonId, banId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Client bloqué introuvable' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE banned client error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/salons/:salonId/loyalty
router.get('/:salonId/loyalty', requireSalonAccess, requireProPlan, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT phone, client_name, visits_count, reward_status, reward_type, reward_value, earned_at, expires_at, used_at, updated_at
       FROM loyalty_progress
       WHERE salon_id = $1
       ORDER BY visits_count DESC, updated_at DESC
       LIMIT 100`,
      [req.params.salonId]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET loyalty error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: GET /api/salons/:salonId/loyalty/check?phone=...
router.get('/:salonId/loyalty/check', async (req, res) => {
  try {
    const { salonId } = req.params;
    const phone = String(req.query.phone || '').replace(/\s+/g, '').trim();
    if (!phone) return res.status(400).json({ error: 'Numéro obligatoire' });

    const rules = await ensureRules(salonId);
    const { rows } = await pool.query(
      `SELECT * FROM loyalty_progress WHERE salon_id = $1 AND phone = $2`,
      [salonId, phone]
    );

    const progress = rows[0] || { visits_count: 0, reward_status: 'progress' };
    res.json({
      enabled: rules.loyalty_enabled,
      requiredVisits: rules.loyalty_required_visits,
      visitsCount: Number(progress.visits_count || 0),
      remaining: Math.max(0, Number(rules.loyalty_required_visits || 10) - Number(progress.visits_count || 0)),
      rewardStatus: progress.reward_status || 'progress',
      rewardType: progress.reward_type || rules.loyalty_reward_type,
      rewardValue: progress.reward_value ?? rules.loyalty_reward_value,
      expiresAt: progress.expires_at || null
    });
  } catch (err) {
    console.error('GET loyalty check error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
