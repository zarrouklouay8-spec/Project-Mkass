// src/routes/subscriptions.js
const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const PLANS = {
  starter: { amount: 29, label: 'Starter' },
  pro: { amount: 59, label: 'Pro' },
};

function frontendBase(req) {
  return process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
}

async function createFlouciCheckout({ subscriptionId, salonId, plan, amount, req }) {
  const publicKey = process.env.FLOUCI_PUBLIC_KEY || process.env.FLOUCI_APP_TOKEN;
  const privateKey = process.env.FLOUCI_PRIVATE_KEY || process.env.FLOUCI_APP_SECRET;
  const baseUrl = process.env.FLOUCI_BASE_URL || 'https://developers.flouci.com/api/v2';
  const webBase = frontendBase(req);
  const apiBase = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
  const trackingId = `mkass-sub-${subscriptionId}`;

  if (!publicKey || !privateKey) {
    return {
      providerPaymentId: `mock-flouci-${subscriptionId}`,
      paymentUrl: `${webBase}?mkass_payment=mock&provider=flouci&subscription=${subscriptionId}`,
      mode: 'mock',
    };
  }

  const res = await fetch(`${baseUrl}/generate_payment`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${publicKey}:${privateKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: String(Math.round(amount * 1000)),
      developer_tracking_id: trackingId,
      accept_card: true,
      success_link: `${webBase}?mkass_payment=success&provider=flouci&subscription=${subscriptionId}`,
      fail_link: `${webBase}?mkass_payment=fail&provider=flouci&subscription=${subscriptionId}`,
      webhook: `${apiBase}/api/subscriptions/webhook/flouci`,
      client_id: `${salonId}-${plan}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.result?.link) {
    throw new Error(data?.message || data?.error || 'Flouci checkout failed');
  }
  return {
    providerPaymentId: data.result.payment_id,
    paymentUrl: data.result.link,
    mode: 'live',
  };
}

async function createClickpayCheckout({ subscriptionId, salonId, amount, req }) {
  const username = process.env.CLICKPAY_USERNAME;
  const password = process.env.CLICKPAY_PASSWORD;
  const baseUrl = process.env.CLICKPAY_BASE_URL || 'https://test.clictopay.com/payment/rest';
  const webBase = frontendBase(req);
  const orderNumber = `MKASS-SUB-${subscriptionId}`;

  if (!username || !password) {
    return {
      providerPaymentId: `mock-clickpay-${subscriptionId}`,
      paymentUrl: `${webBase}?mkass_payment=mock&provider=clickpay&subscription=${subscriptionId}`,
      mode: 'mock',
    };
  }

  const params = new URLSearchParams({
    userName: username,
    password,
    orderNumber,
    amount: String(Math.round(amount * 1000)),
    currency: process.env.CLICKPAY_CURRENCY || '788',
    returnUrl: `${webBase}?mkass_payment=return&provider=clickpay&subscription=${subscriptionId}`,
    description: `Mkass subscription ${salonId}`,
  });
  const res = await fetch(`${baseUrl}/register.do?${params.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.formUrl) {
    throw new Error(data?.errorMessage || data?.message || 'ClicToPay checkout failed');
  }
  return {
    providerPaymentId: data.orderId || orderNumber,
    paymentUrl: data.formUrl,
    mode: 'live',
  };
}

async function createD17Checkout({ subscriptionId, req }) {
  const webBase = frontendBase(req);
  // D17 merchant APIs are not public in a stable way. Keep this adapter mock until you receive official credentials/docs.
  return {
    providerPaymentId: `manual-d17-${subscriptionId}`,
    paymentUrl: `${webBase}?mkass_payment=manual&provider=d17&subscription=${subscriptionId}`,
    mode: 'manual',
  };
}

router.post('/create-checkout', async (req, res) => {
  try {
    const salonId = req.body.salonId || req.body.signupId;
    const plan = String(req.body.plan || '').toLowerCase();
    const provider = String(req.body.provider || 'flouci').toLowerCase();
    if (!salonId) return res.status(400).json({ error: 'salonId or signupId is required' });
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan. Use starter or pro. Premium is coming soon.' });
    if (!['flouci', 'd17', 'clickpay'].includes(provider)) return res.status(400).json({ error: 'Invalid payment provider' });

    const amount = PLANS[plan].amount;
    const { rows } = await pool.query(
      `INSERT INTO subscriptions (salon_id, plan, status, provider, amount, currency)
       VALUES ($1,$2,'pending',$3,$4,'TND') RETURNING *`,
      [salonId, plan, provider, amount]
    );
    const sub = rows[0];

    let checkout;
    if (provider === 'flouci') checkout = await createFlouciCheckout({ subscriptionId: sub.id, salonId, plan, amount, req });
    else if (provider === 'clickpay') checkout = await createClickpayCheckout({ subscriptionId: sub.id, salonId, amount, req });
    else checkout = await createD17Checkout({ subscriptionId: sub.id, req });

    await pool.query(
      `UPDATE subscriptions SET provider_payment_id=$1, payment_url=$2 WHERE id=$3`,
      [checkout.providerPaymentId, checkout.paymentUrl, sub.id]
    );

    await pool.query(`UPDATE salons SET plan=$1, subscription_status='pending_payment' WHERE id=$2`, [plan, salonId]);

    res.json({
      subscriptionId: sub.id,
      plan,
      amount,
      provider,
      providerPaymentId: checkout.providerPaymentId,
      paymentUrl: checkout.paymentUrl,
      mode: checkout.mode,
    });
  } catch (err) {
    console.error('create-checkout error:', err);
    res.status(500).json({ error: err.message || 'Payment checkout failed' });
  }
});

router.post('/webhook/:provider', async (req, res) => {
  try {
    const provider = req.params.provider;
    const payload = req.body || {};
    const providerPaymentId = payload.payment_id || payload.orderId || payload.order_id || payload.provider_payment_id || payload.id || null;

    await pool.query(
      `INSERT INTO payment_events (provider, provider_payment_id, event_type, payload)
       VALUES ($1,$2,$3,$4)`,
      [provider, providerPaymentId, payload.status || payload.event || 'webhook', payload]
    );

    // Real production should verify provider signature/status before activating.
    const isPaid = ['paid', 'success', 'confirmed', 'completed'].includes(String(payload.status || payload.result || '').toLowerCase()) || payload.success === true;
    if (isPaid && providerPaymentId) {
      const { rows } = await pool.query(
        `UPDATE subscriptions
         SET status='active', starts_at=NOW(), ends_at=NOW() + INTERVAL '1 month'
         WHERE provider_payment_id=$1 RETURNING *`,
        [providerPaymentId]
      );
      if (rows[0]) {
        await pool.query(
          `UPDATE salons SET plan=$1, subscription_status='active' WHERE id=$2`,
          [rows[0].plan, rows[0].salon_id]
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('payment webhook error:', err);
    res.status(500).json({ error: 'Webhook error' });
  }
});

router.get('/status/:salonId', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM subscriptions WHERE salon_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [req.params.salonId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
