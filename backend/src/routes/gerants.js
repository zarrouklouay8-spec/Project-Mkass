// src/routes/gerants.js
const router = require('express').Router();
const pool = require('../db/pool');
const bcrypt = require('bcryptjs');

function slugifyName(name) {
  return String(name || 'salon')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'salon';
}

const DEFAULT_SERVICES = [
  { cat:'Coupe', name:'Coupe femme', dur:'45 min', price:35, types:['salon','mixte'] },
  { cat:'Coupe', name:'Coupe homme', dur:'30 min', price:20, types:['barbershop','mixte'] },
  { cat:'Coupe', name:'Coupe enfant', dur:'20 min', price:15, types:['salon','barbershop','mixte','enfant'] },
  { cat:'Soin', name:'Brushing', dur:'30 min', price:25, types:['salon','mixte','enfant'] },
  { cat:'Barbe', name:'Taille de barbe', dur:'20 min', price:15, types:['barbershop','mixte'] },
  { cat:'Barbe', name:'Barbe + coupe', dur:'50 min', price:35, types:['barbershop','mixte'] },
];

router.post('/signup-draft', async (req, res) => {
  const client = await pool.connect();
  try {
    const name = req.body.name || req.body.salonName;
    const username = String(req.body.username || slugifyName(name)).toLowerCase().trim();
    const password = req.body.password;
    const phone = req.body.phone || '';
    const address = req.body.address || '';
    const type = req.body.type || 'mixte';
    if (!name || !username || !password || !address) {
      return res.status(400).json({ error: 'name, username, password and address are required' });
    }
    if (String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const id = slugifyName(username);
    const hash = await bcrypt.hash(password, 10);

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO salons (id, name, username, password, icon, type, address, phone, plan, subscription_status, status, color)
       VALUES ($1,$2,$3,$4,'✂️',$5,$6,$7,NULL,'pending_payment','closed','#C8FF00')
       RETURNING id, name, username, phone, plan, subscription_status`,
      [id, name, username, hash, type, address, phone]
    );

    const services = DEFAULT_SERVICES.filter(s => s.types.includes(type));
    for (const s of services) {
      await client.query(
        `INSERT INTO services (salon_id, category, name, duration, price) VALUES ($1,$2,$3,$4,$5)`,
        [id, s.cat, s.name, s.dur, s.price]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ signupId: id, salonId: id, salon: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error('signup draft error:', err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
