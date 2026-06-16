const router = require('express').Router();
const pool = require('../db/pool');

async function ensureReviewsSchema() {
  await pool.query(`
    ALTER TABLE reviews
    ADD COLUMN IF NOT EXISTS author_phone TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS appointment_id TEXT,
    ADD COLUMN IF NOT EXISTS client_name TEXT,
    ADD COLUMN IF NOT EXISTS rating INT,
    ADD COLUMN IF NOT EXISTS comment TEXT;
  `);

  await pool.query(`
    UPDATE reviews
    SET rating = COALESCE(rating, stars),
        comment = COALESCE(comment, text),
        client_name = COALESCE(client_name, author_name)
    WHERE rating IS NULL OR comment IS NULL OR client_name IS NULL;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_appointment_unique
    ON reviews(appointment_id)
    WHERE appointment_id IS NOT NULL;
  `);
}

// POST /api/reviews
router.post('/', async (req, res) => {
  try {
    await ensureReviewsSchema();

    const { appointmentId, rating, comment } = req.body;

    if (!appointmentId) {
      return res.status(400).json({ error: 'Rendez-vous obligatoire' });
    }

    const reviewRating = Number(rating);
    if (!reviewRating || reviewRating < 1 || reviewRating > 5) {
      return res.status(400).json({ error: 'Note invalide' });
    }

    const apptResult = await pool.query(
      `SELECT id, salon_id, client_name, client_phone, status
       FROM appointments
       WHERE id::text = $1::text`,
      [appointmentId]
    );

    if (!apptResult.rows.length) {
      return res.status(404).json({ error: 'Rendez-vous introuvable' });
    }

    const appt = apptResult.rows[0];

    if (appt.status !== 'done') {
      return res.status(400).json({
        error: 'Vous pouvez laisser un avis uniquement après le rendez-vous terminé'
      });
    }

    const clientName = appt.client_name || 'Client';
    const clientPhone = appt.client_phone || '';
    const reviewText = String(comment || '').trim();

    const { rows } = await pool.query(
      `INSERT INTO reviews (
        salon_id,
        author_name,
        author_phone,
        stars,
        text,
        appointment_id,
        client_name,
        rating,
        comment
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        appt.salon_id,
        clientName,
        clientPhone,
        reviewRating,
        reviewText,
        String(appt.id),
        clientName,
        reviewRating,
        reviewText
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Un avis existe déjà pour ce rendez-vous' });
    }

    console.error('POST review error:', err);
    res.status(500).json({ error: 'Erreur serveur avis', details: err.message, code: err.code });
  }
});

// GET /api/reviews/salon/:salonId
router.get('/salon/:salonId', async (req, res) => {
  try {
    await ensureReviewsSchema();

    const { rows } = await pool.query(
      `SELECT *
       FROM reviews
       WHERE salon_id = $1
       ORDER BY created_at DESC`,
      [req.params.salonId]
    );

    res.json(rows);
  } catch (err) {
    console.error('GET salon reviews error:', err);
    res.status(500).json({ error: 'Erreur serveur avis', details: err.message, code: err.code });
  }
});

module.exports = router;
