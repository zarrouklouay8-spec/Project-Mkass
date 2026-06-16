require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { exec } = require('child_process'); // ✅ ADDED
const reviewRoutes = require('./routes/reviews');
const gerantRoutes = require('./routes/gerants');
const subscriptionRoutes = require('./routes/subscriptions');
const pushRoutes = require('./routes/push');
const app = express();

// ── AUTO DB SETUP (NO CLI NEEDED) ───────────────────────────
function runDatabaseSetup() {
  if (process.env.RUN_DB_SETUP !== 'true') return;

  console.log('Running database setup...');

  exec('node src/db/migrate.js && node src/db/seed.js', (error, stdout, stderr) => {
    if (error) {
      console.error('Database setup failed:', error);
      return;
    }

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  });
}

// ── MIDDLEWARE ───────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mkass-api', ts: new Date().toISOString() });
});
// ── ROUTES ───────────────────────────────────────────────────
const authRoutes         = require('./routes/auth');
const salonRoutes        = require('./routes/salons');
const serviceRoutes      = require('./routes/services');
const appointmentRoutes  = require('./routes/appointments');
const balanceRoutes      = require('./routes/balance');
const staffRoutes        = require('./routes/staff');
const financeRoutes      = require('./routes/finance');
const rulesRoutes        = require('./routes/rules');
const adminRoutes        = require('./routes/admin');

app.use('/api/auth',    authRoutes);
app.use('/api/salons',  salonRoutes);
app.use('/api/salons',  serviceRoutes);
app.use('/api/salons',  appointmentRoutes);
app.use('/api/salons',  balanceRoutes);
app.use('/api/salons',  staffRoutes);
app.use('/api/salons',  financeRoutes);
app.use('/api/salons',  rulesRoutes);
app.use('/api/admin',   adminRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/gerants', gerantRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/push',    pushRoutes);
// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── ERROR HANDLER ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ✅ RUN MIGRATIONS AUTOMATICALLY
runDatabaseSetup();

app.listen(PORT, () => {
  console.log(`\n🚀 Mkass API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});
