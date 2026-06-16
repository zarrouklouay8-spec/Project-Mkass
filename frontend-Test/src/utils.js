export const STATUS = {
  pending: 'En attente',
  confirmed: 'Confirmé',
  done: 'Terminé',
  cancelled: 'Annulé',
  no_show: 'No-show',
};

export const TYPE_LABELS = {
  salon: 'Salon femme',
  barbershop: 'Barbershop',
  mixte: 'Salon mixte',
  enfant: 'Salon enfants',
};

export const AVATAR_COLORS = ['#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#60a5fa', '#fb923c', '#e879f9'];

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function tomorrowStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function formatDate(date) {
  if (!date) return '--';
  const d = String(date).slice(0, 10);
  const parts = d.split('-');
  if (parts.length !== 3) return '--';
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

export function formatLongDate(date) {
  if (!date) return '--';
  return new Date(String(date).slice(0, 10) + 'T12:00:00').toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export function slugifyName(name) {
  return String(name || 'salon')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'salon';
}

export function cleanPhone(phone) {
  return String(phone || '').replace(/\s+/g, '').trim();
}

export function parseDurationMinutes(duration) {
  if (typeof duration === 'number') return duration;
  const m = String(duration || '').match(/\d+/);
  return m ? Number(m[0]) : 30;
}

export function mkassExtractCoordsFromMapUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const decoded = decodeURIComponent(raw);

  const patterns = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /[?&]query=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  ];

  for (const re of patterns) {
    const m = decoded.match(re);
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  }

  const dms = decoded.match(/(\d+(?:\.\d+)?)°\s*(\d+(?:\.\d+)?)['’]\s*(\d+(?:\.\d+)?)?"?\s*([NS])\s+(-?\d+(?:\.\d+)?)°\s*(\d+(?:\.\d+)?)['’]\s*(\d+(?:\.\d+)?)?"?\s*([EW])/i);
  if (dms) {
    const lat = dmsToDecimal(Number(dms[1]), Number(dms[2]), Number(dms[3] || 0), dms[4]);
    const lng = dmsToDecimal(Number(dms[5]), Number(dms[6]), Number(dms[7] || 0), dms[8]);
    return { lat, lng };
  }

  return null;
}

export function dmsToDecimal(deg, min, sec, dir) {
  let val = Number(deg) + Number(min || 0) / 60 + Number(sec || 0) / 3600;
  if (/S|W/i.test(dir)) val *= -1;
  return Number(val.toFixed(6));
}

export function getSalonCoords(salon) {
  const lat = Number(salon?.latitude ?? salon?.lat);
  const lng = Number(salon?.longitude ?? salon?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  return mkassExtractCoordsFromMapUrl(salon?.mapUrl || salon?.map_url || salon?.google_maps_url || '');
}

export function getDirectionsUrl(salon) {
  if (!salon) return '';
  const coords = getSalonCoords(salon);
  if (coords) {
    return `https://www.google.com/maps/dir/?api=1&destination=${coords.lat},${coords.lng}`;
  }
  const rawLink = String(salon.mapUrl || salon.map_url || salon.google_maps_url || '').trim();
  if (/^https?:\/\//i.test(rawLink)) return rawLink;
  const q = String(salon.address || salon.name || '').trim();
  return q ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}` : '';
}

export function haversineKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const dLat = deg2rad(b.lat - a.lat);
  const dLng = deg2rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(deg2rad(a.lat)) * Math.cos(deg2rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function deg2rad(d) {
  return d * Math.PI / 180;
}

export function normalizeApiSalon(row) {
  const reviews = Array.isArray(row.reviews)
    ? row.reviews.filter((r) => r && (r.id !== null || r.text || r.comment || r.stars || r.rating || r.author_name || r.client_name))
    : [];
  const count = Number(row.reviewCount ?? row.review_count ?? row.reviews_count);
  const reviewCount = Number.isFinite(count) && count > 0 ? count : reviews.length;
  const avg = reviews.length ? reviews.reduce((sum, r) => sum + Number(r.rating || r.stars || 5), 0) / reviews.length : 5;
  const mapUrl = row.mapUrl || row.map_url || row.google_maps_url || '';
  const coords = mkassExtractCoordsFromMapUrl(mapUrl);
  return {
    id: row.id || row.salonId || row.username || slugifyName(row.name),
    username: row.username || row.id || slugifyName(row.name),
    name: row.name || row.salonName || 'Salon',
    icon: row.icon || '✂️',
    type: row.type || 'salon',
    address: row.address || '',
    dist: row.dist || row.distance || '',
    rating: Number(row.rating ?? avg ?? 5),
    reviewCount,
    reservationCount: Number(row.reservationCount ?? row.reservation_count ?? row.totalAppointments ?? row.total_appointments ?? 0),
    status: row.status || 'open',
    tags: Array.isArray(row.tags) ? row.tags : [],
    childCut: Boolean(row.childCut ?? row.child_cut ?? false),
    color: row.color || '#1ba640',
    coverImg: row.coverImg || row.cover_img || row.cover_url || null,
    mapUrl,
    latitude: row.latitude ?? row.lat ?? coords?.lat ?? null,
    longitude: row.longitude ?? row.lng ?? coords?.lng ?? null,
    plan: String(row.plan || row.subscription_plan || row.package || row.pack || 'starter').toLowerCase(),
    reviews,
  };
}

export function normalizeApiService(row, salonId) {
  const duration = row.duration ?? row.duration_minutes ?? row.dur ?? 30;
  return {
    id: row.id || row.serviceId || `${salonId}-${slugifyName(row.name)}`,
    cat: row.cat || row.category || 'Service',
    name: row.name || 'Service',
    dur: typeof duration === 'string' ? duration : `${duration} min`,
    duration: parseDurationMinutes(duration),
    price: Number(row.price || 0),
    salonId: row.salonId || row.salon_id || salonId,
  };
}

export function normalizeApiAppointment(row) {
  return {
    id: row.id || row.appointmentId || row.ref || `MKS-${Date.now()}`,
    salonId: row.salonId || row.salon_id,
    salonName: row.salonName || row.salon_name || '',
    client: row.client || row.client_name || row.customer_name || row.customerName || row.name || 'Client',
    phone: row.phone || row.client_phone || row.customer_phone || '',
    services: row.services || row.service_names || row.serviceNames || [],
    prices: Array.isArray(row.prices) ? row.prices : [],
    total: Number(row.total || 0),
    date: row.date || row.appt_date || row.appointment_date,
    time: String(row.time || row.appt_time || row.appointment_time || '').slice(0, 5),
    status: row.status || 'confirmed',
    note: row.note || '',
    type: row.type || 'booking',
    payMode: row.payMode || row.pay_mode || row.payment || row.payment_mode || 'online',
    staffId: row.staffId || row.staff_id || null,
    staffName: row.staffName || row.staff_name || null,
  };
}

export function statusBadgeClass(status) {
  if (status === 'confirmed') return 'badge-confirmed';
  if (status === 'pending') return 'badge-pending';
  if (status === 'done') return 'badge-done';
  if (status === 'cancelled') return 'badge-cancelled';
  if (status === 'no_show') return 'badge-cancelled';
  return 'badge-pending';
}
