// src/db/seed.js
// Run after migrate: npm run db:seed
require('dotenv').config();
const pool = require('./pool');
const bcrypt = require('bcryptjs');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── SALONS ───────────────────────────────────────────────
    const salons = [
      { id:'salon-nour',   username:'salon-nour',  password:'1234', name:'Salon Nour',   icon:'💇', type:'salon',       address:'Rue de Marseille, Lafayette, Tunis',    dist:'0.3 km', tags:['Coloration','Kératine','Mariée'], childCut:true,  color:'#a78bfa', plan:'pro' },
      { id:'barber-one',   username:'barber-one',  password:'5678', name:'Barber One',   icon:'💈', type:'barbershop',  address:'Avenue Habib Bourguiba, Centre-Ville',  dist:'0.7 km', tags:['Barbe','Rasage','Coupe moderne'], childCut:true,  color:'#34d399', plan:'starter' },
      { id:'studio-bella', username:'studio-bella',password:'0000', name:'Studio Bella', icon:'🌸', type:'mixte',       address:'Rue du Lac, Les Berges du Lac',         dist:'2.1 km', tags:['Soin','Extensions','Nail art'],   childCut:false, color:'#f472b6', plan:'starter' },
      { id:'coiff-kids',   username:'coiff-kids',  password:'0000', name:"Coiff & Kids", icon:'🧒', type:'enfant',      address:'Centre Commercial, La Marsa',           dist:'5.4 km', tags:['Enfants','Bébés','Fun'],          childCut:true,  color:'#fbbf24', plan:'starter' },
    ];

    for (const s of salons) {
      const hash = await bcrypt.hash(s.password, 10);
      await client.query(`
        INSERT INTO salons (id, name, username, password, icon, type, address, dist, tags, child_cut, color, plan, subscription_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
        ON CONFLICT (id) DO NOTHING
      `, [s.id, s.name, s.username, hash, s.icon, s.type, s.address, s.dist, s.tags, s.childCut, s.color, s.plan || 'starter']);
    }

    // ── DEFAULT SERVICES PER SALON ────────────────────────────
    const allServices = [
      { cat:'Coupe',    name:'Coupe femme',         dur:'45 min', price:35,  types:['salon','mixte'] },
      { cat:'Coupe',    name:'Coupe homme',          dur:'30 min', price:20,  types:['barbershop','mixte'] },
      { cat:'Coupe',    name:'Coupe enfant',         dur:'20 min', price:15,  types:['salon','barbershop','mixte','enfant'] },
      { cat:'Coupe',    name:'Coupe bébé',           dur:'15 min', price:12,  types:['enfant','mixte'] },
      { cat:'Couleur',  name:'Coloration complète',  dur:'90 min', price:80,  types:['salon','mixte'] },
      { cat:'Couleur',  name:'Balayage / Mèches',    dur:'120 min',price:120, types:['salon','mixte'] },
      { cat:'Couleur',  name:'Kératine',             dur:'150 min',price:150, types:['salon','mixte'] },
      { cat:'Soin',     name:'Brushing',             dur:'30 min', price:25,  types:['salon','mixte','enfant'] },
      { cat:'Soin',     name:'Soin profond',         dur:'45 min', price:45,  types:['salon','mixte'] },
      { cat:'Soin',     name:'Soin visage',          dur:'60 min', price:55,  types:['salon','mixte'] },
      { cat:'Barbe',    name:'Taille de barbe',      dur:'20 min', price:15,  types:['barbershop','mixte'] },
      { cat:'Barbe',    name:'Rasage rasoir droit',  dur:'30 min', price:20,  types:['barbershop'] },
      { cat:'Barbe',    name:'Barbe + coupe',        dur:'50 min', price:35,  types:['barbershop','mixte'] },
      { cat:'Ongles',   name:'Manucure',             dur:'40 min', price:30,  types:['salon','mixte'] },
      { cat:'Ongles',   name:'Nail art',             dur:'60 min', price:50,  types:['salon','mixte'] },
      { cat:'Épilation',name:'Épilation visage',     dur:'20 min', price:18,  types:['salon','mixte'] },
      { cat:'Épilation',name:'Épilation corps',      dur:'45 min', price:40,  types:['salon','mixte'] },
      { cat:'Formule',  name:'Forfait Mariée',       dur:'180 min',price:250, types:['salon'] },
    ];

    for (const salon of salons) {
      const relevantSvcs = allServices.filter(sv => sv.types.includes(salon.type));
      for (const sv of relevantSvcs) {
        await client.query(`
          INSERT INTO services (salon_id, category, name, duration, price)
          VALUES ($1,$2,$3,$4,$5)
        `, [salon.id, sv.cat, sv.name, sv.dur, sv.price]);
      }
    }

    // ── DEMO REVIEWS ─────────────────────────────────────────
    const reviews = [
      { salon_id:'salon-nour',  name:'Sarra M.',        stars:5, text:'Service impeccable ! Ma couleur est exactement ce que je voulais.' },
      { salon_id:'salon-nour',  name:'Amira K.',        stars:5, text:'Très professionnel et accueillant. Je recommande vivement !' },
      { salon_id:'salon-nour',  name:'Leila B.',        stars:4, text:'Brushing parfait, réservation en ligne super pratique.' },
      { salon_id:'barber-one',  name:'Khalil T.',       stars:5, text:'Le meilleur barbershop de Tunis. Coupe parfaite.' },
      { salon_id:'barber-one',  name:'Mohamed A.',      stars:5, text:'Yassine est un vrai pro. Rapport qualité/prix excellent.' },
      { salon_id:'studio-bella',name:'Ines H.',         stars:5, text:'Extensions superbes, résultat naturel !' },
      { salon_id:'coiff-kids',  name:'Mama de Yassin',  stars:5, text:'Mon fils adorait pleurer — ici il rigole ! Équipe magique.' },
    ];
    for (const r of reviews) {
      await client.query(
        `INSERT INTO reviews (salon_id, author_name, stars, text) VALUES ($1,$2,$3,$4)`,
        [r.salon_id, r.name, r.stars, r.text]
      );
    }

    await client.query('COMMIT');
    console.log('✅ Seed complete — demo data inserted.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
