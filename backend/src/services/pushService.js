// src/services/pushService.js
const webpush = require('web-push');
const pool = require('../db/pool');

let configured = false;

function configureWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:contact@mkass.app';

  if (!publicKey || !privateKey) {
    configured = false;
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

function isPushConfigured() {
  if (configured) return true;
  return configureWebPush();
}

async function ensurePushTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      salon_id TEXT NOT NULL,
      user_role TEXT,
      staff_id TEXT,
      endpoint TEXT NOT NULL UNIQUE,
      subscription JSONB NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_notification_logs (
      id SERIAL PRIMARY KEY,
      salon_id TEXT NOT NULL,
      appointment_id TEXT,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function saveSubscription({ salonId, role, staffId, subscription }) {
  if (!salonId) throw new Error('salonId is required');
  if (!subscription || !subscription.endpoint) throw new Error('Invalid push subscription');

  await ensurePushTables();

  const { rows } = await pool.query(
    `INSERT INTO push_subscriptions (
       salon_id, user_role, staff_id, endpoint, subscription, active, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,true,NOW())
     ON CONFLICT (endpoint)
     DO UPDATE SET
       salon_id = EXCLUDED.salon_id,
       user_role = EXCLUDED.user_role,
       staff_id = EXCLUDED.staff_id,
       subscription = EXCLUDED.subscription,
       active = true,
       updated_at = NOW()
     RETURNING id`,
    [salonId, role || null, staffId || null, subscription.endpoint, subscription]
  );

  return rows[0];
}

function formatMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  return ` - ${n.toFixed(3)} TND`;
}

function buildAppointmentPayload(eventType, appointment) {
  const client = appointment.client_name || appointment.client || 'Client';
  const time = String(appointment.appt_time || appointment.time || '').slice(0, 5);
  const date = String(appointment.appt_date || appointment.date || '').slice(0, 10);
  const services = Array.isArray(appointment.services) ? appointment.services.join(', ') : String(appointment.services || 'RDV');
  const total = formatMoney(appointment.total);
  const staffName = appointment.staff_name || appointment.staffName || '';
  const staffPart = staffName ? ` - ${staffName}` : '';

  if (eventType === 'new_appointment') {
    return {
      title: 'Mkass - Nouvelle reservation',
      body: `${client} - ${services} - ${date} ${time}${staffPart}`,
    };
  }

  if (eventType === 'walkin_created' || eventType === 'staff_walkin_created') {
    return {
      title: 'Mkass - Client sans rendez-vous',
      body: `${client} - ${services}${total}${staffPart}`,
    };
  }

  if (eventType === 'appointment_confirmed') {
    return {
      title: 'Mkass - RDV confirme',
      body: `${client} - ${services} - ${date} ${time}${staffPart}`,
    };
  }

  if (eventType === 'appointment_claimed') {
    return {
      title: 'Mkass - RDV pris par un personnel',
      body: `${client} - ${services} - ${date} ${time}${staffPart}`,
    };
  }

  if (eventType === 'appointment_done') {
    return {
      title: 'Mkass - RDV termine',
      body: `${client} - ${services}${total}${staffPart}`,
    };
  }

  if (eventType === 'appointment_no_show') {
    return {
      title: 'Mkass - Client absent',
      body: `${client} - ${date} ${time}${staffPart}`,
    };
  }

  if (eventType === 'appointment_cancelled') {
    return {
      title: 'Mkass - RDV annule',
      body: `${client} - ${date} ${time}${staffPart}`,
    };
  }

  return {
    title: 'Mkass - Activite salon',
    body: `${client} - ${services} - ${date} ${time}${staffPart}`,
  };
}

async function notifySalon(salonId, eventType, appointment, customPayload = null) {
  try {
    if (!isPushConfigured()) {
      console.warn('Web Push disabled: VAPID keys are missing');
      return { sent: 0, failed: 0, disabled: true };
    }

    await ensurePushTables();

    const base = customPayload || buildAppointmentPayload(eventType, appointment || {});
    const payload = JSON.stringify({
      title: base.title,
      body: base.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: {
        url: '/',
        salonId,
        eventType,
        appointmentId: appointment?.id || null,
      },
    });

    const logResult = await pool.query(
      `INSERT INTO push_notification_logs (
         salon_id, appointment_id, event_type, title, body, status
       )
       VALUES ($1,$2,$3,$4,$5,'pending')
       RETURNING id`,
      [salonId, appointment?.id || null, eventType, base.title, base.body]
    );
    const logId = logResult.rows[0].id;

    const { rows } = await pool.query(
      `SELECT id, endpoint, subscription
       FROM push_subscriptions
       WHERE salon_id = $1 AND active = true`,
      [salonId]
    );

    let sent = 0;
    let failed = 0;

    await Promise.all(rows.map(async (row) => {
      try {
        await webpush.sendNotification(row.subscription, payload);
        sent += 1;
      } catch (err) {
        failed += 1;
        const statusCode = err?.statusCode || err?.status;
        if (statusCode === 404 || statusCode === 410) {
          await pool.query('UPDATE push_subscriptions SET active = false, updated_at = NOW() WHERE id = $1', [row.id]);
        }
        console.warn('Push send failed:', statusCode || '', err.message || err);
      }
    }));

    await pool.query(
      `UPDATE push_notification_logs
       SET status = $1, sent_count = $2, failed_count = $3, error = $4
       WHERE id = $5`,
      [sent > 0 ? 'sent' : (failed > 0 ? 'failed' : 'no_subscribers'), sent, failed, failed ? `${failed} failed` : null, logId]
    );

    return { sent, failed };
  } catch (err) {
    console.error('notifySalon error:', err);
    return { sent: 0, failed: 1, error: err.message };
  }
}

module.exports = {
  configureWebPush,
  isPushConfigured,
  ensurePushTables,
  saveSubscription,
  notifySalon,
};
