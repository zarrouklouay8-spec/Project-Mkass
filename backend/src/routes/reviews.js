const router = require('express').Router();
const pool = require('../db/pool');

// POST /api/reviews
router.post('/', async (req, res) => {
  try {
    const { appointmentId, rating, comment } = req.body;

    if (!appointmentId) {
      return res.status(400).json({ error: 'Rendez-vous obligatoire' });
    }

    if (!rating || Number(rating) < 1 || Number(rating) > 5) {
      return res.status(400).json({ error: 'Note invalide' });
    }

    const apptResult = await pool.query(
      `SELECT
         id,
         salon_id,
         client_name,
         client_phone,
         status
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
    const reviewText = comment || '';
    const reviewRating = Number(rating);

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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      return res.status(400).json({
        error: 'Un avis existe déjà pour ce rendez-vous'
      });
    }

    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/reviews/salon/:salonId
router.get('/salon/:salonId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT *
       FROM reviews
       WHERE salon_id = $1
       ORDER BY created_at DESC`,
      [req.params.salonId]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
