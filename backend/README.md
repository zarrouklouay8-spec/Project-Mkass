# Mkass Backend API

REST API for the Mkass salon booking platform.  
**Stack:** Node.js · Express · PostgreSQL · JWT

---

## 🗂 Project Structure

```
mkass-backend/
├── src/
│   ├── index.js              ← Express app + server start
│   ├── db/
│   │   ├── pool.js           ← PostgreSQL connection pool
│   │   ├── migrate.js        ← Creates all tables (run once)
│   │   └── seed.js           ← Inserts demo salons & services
│   ├── middleware/
│   │   └── auth.js           ← JWT verification middleware
│   └── routes/
│       ├── auth.js           ← POST /api/auth/login
│       ├── salons.js         ← CRUD for salons
│       ├── services.js       ← CRUD for salon services
│       ├── appointments.js   ← Bookings + walk-ins
│       ├── balance.js        ← Revenue analytics
│       └── admin.js          ← Admin-only platform routes
├── .env.example
├── railway.json
└── package.json
```

---

## 🚀 Deploy to Railway (step by step)

### 1. Push to GitHub

```bash
cd mkass-backend
git init
git add .
git commit -m "Initial Mkass backend"
# Create a repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/mkass-backend.git
git push -u origin main
```

### 2. Create Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Click **Deploy from GitHub repo** → select `mkass-backend`
3. Railway auto-detects Node.js and runs `npm start`

### 3. Add PostgreSQL database

1. In your Railway project, click **+ New** → **Database** → **PostgreSQL**
2. Railway automatically sets `DATABASE_URL` in your service's environment

### 4. Set environment variables

In your Railway service → **Variables** tab, add:

| Variable | Value |
|---|---|
| `JWT_SECRET` | Run `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `JWT_EXPIRES_IN` | `7d` |
| `ADMIN_USERNAME` | `admin` (or your choice) |
| `ADMIN_PASSWORD` | A strong password |
| `FRONTEND_URL` | Your frontend URL (or `*` for all origins) |
| `NODE_ENV` | `production` |

> `DATABASE_URL` and `PORT` are set automatically by Railway — do not add them manually.

### 5. Run migrations + seed

In Railway → your service → **Deploy** tab → open a shell, or use the Railway CLI:

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway link   # select your project

# Run migrations (creates tables)
railway run npm run db:migrate

# Run seed (inserts demo data)
railway run npm run db:seed
```

### 6. Get your API URL

Railway gives you a public URL like:  
`https://mkass-backend-production.up.railway.app`

Test it:
```
GET https://your-url.railway.app/health
→ { "status": "ok", "service": "mkass-api" }
```

---

## 📡 API Reference

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | — | Login gérant or admin |
| POST | `/api/auth/change-password` | Gérant | Change own password |

**Login body:**
```json
{ "username": "salon-nour", "password": "1234" }
```
**Login response:**
```json
{ "token": "eyJ...", "role": "gerant", "salonId": "salon-nour", "salonName": "Salon Nour" }
```

---

### Salons (Public)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/salons` | — | List all salons |
| GET | `/api/salons/:id` | — | Single salon + services + reviews |
| PUT | `/api/salons/:id` | Gérant (own) | Update salon settings |
| POST | `/api/salons` | Admin | Create new salon/gérant |
| DELETE | `/api/salons/:id` | Admin | Delete salon |

---

### Services

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/salons/:id/services` | — | List services |
| POST | `/api/salons/:id/services` | Gérant | Add service |
| PUT | `/api/salons/:id/services/:sid` | Gérant | Update service |
| DELETE | `/api/salons/:id/services/:sid` | Gérant | Delete service |

---

### Appointments

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/salons/:id/appointments` | Gérant | List appointments |
| GET | `/api/salons/:id/appointments/today` | Gérant | Today + stats |
| GET | `/api/salons/:id/slots?date=YYYY-MM-DD` | — | Available time slots |
| POST | `/api/salons/:id/appointments` | — | Client creates booking |
| POST | `/api/salons/:id/appointments/walkin` | Gérant | Log walk-in payment |
| PATCH | `/api/salons/:id/appointments/:apptId/status` | Gérant | Update status |
| DELETE | `/api/salons/:id/appointments/:apptId` | Gérant | Delete |

---

### Balance

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/salons/:id/balance` | Gérant | Revenue + history |

Query params: `?type=all\|booking\|walkin&period=today\|week\|month\|all`

---

### Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/salons` | Admin | All salons + stats |
| GET | `/api/admin/stats` | Admin | Platform-wide stats |
| GET | `/api/admin/appointments` | Admin | All appointments |
| PATCH | `/api/admin/salons/:id/reset-password` | Admin | Reset gérant password |

---

## 🔌 Connecting the Frontend

In your `mkass-app.html`, replace the in-memory data with API calls.  
Add this base config at the top of your `<script>`:

```js
const API = 'https://your-url.railway.app/api';
let authToken = null;

async function apiCall(method, path, body = null) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) throw await res.json();
  return res.json();
}

// Example — login
async function tryLogin() {
  const username = document.getElementById('dash-user').value.trim();
  const password = document.getElementById('dash-pw').value;
  try {
    const data = await apiCall('POST', '/auth/login', { username, password });
    authToken = data.token;
    loggedSalonId = data.salonId;
    isAdmin = data.role === 'admin';
    showDash();
  } catch (err) {
    toast(err.error || 'Identifiants incorrects');
  }
}

// Example — load salons for explore page
async function renderShops() {
  const salons = await apiCall('GET', '/salons');
  // ... render as before
}
```

---

## 🛠 Local Development

```bash
# Install dependencies
npm install

# Copy and fill env
cp .env.example .env
# Edit .env — set DATABASE_URL to your local Postgres

# Create tables
npm run db:migrate

# Insert demo data
npm run db:seed

# Start dev server with auto-reload
npm run dev
```

---

## 👤 Demo Accounts (after seed)

| Username | Password | Role |
|----------|----------|------|
| `salon-nour` | `1234` | Gérant |
| `barber-one` | `5678` | Gérant |
| `studio-bella` | `0000` | Gérant |
| `coiff-kids` | `0000` | Gérant |
| `admin` | *(set in env var `ADMIN_PASSWORD`)* | Admin |
