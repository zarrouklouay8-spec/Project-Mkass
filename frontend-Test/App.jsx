import React, { useEffect, useMemo, useState } from 'react';
import { apiCall, unwrapApi, API_BASE } from './api.js';
import { demoAppointments, demoSalons, servicesBySalonFromDemo } from './data/demoData.js';
import {
  AVATAR_COLORS,
  STATUS,
  TYPE_LABELS,
  cleanPhone,
  formatDate,
  formatLongDate,
  getDirectionsUrl,
  getSalonCoords,
  haversineKm,
  mkassExtractCoordsFromMapUrl,
  normalizeApiAppointment,
  normalizeApiSalon,
  normalizeApiService,
  parseDurationMinutes,
  slugifyName,
  statusBadgeClass,
  todayStr,
  tomorrowStr,
} from './utils.js';

const ALL_SLOTS = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30',
  '12:00', '14:00', '14:30', '15:00', '15:30', '16:00',
  '16:30', '17:00', '17:30',
];

const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

const EXPENSE_SUBTYPES = {
  Factures: ['STEG', 'SONEDE', 'Internet', 'Téléphone', 'Assurance', 'Autre facture'],
  Stock: ['Shampoing', 'Coloration', 'Produits barbe', 'Produits ongles', 'Serviettes / consommables', 'Autre stock'],
  Équipement: ['Tondeuse / Trimmer', 'Plaque', 'Sèche-cheveux', 'Fauteuil', 'Miroir', 'Matériel ongles', 'Autre équipement'],
  Loyer: ['Loyer mensuel', 'Avance loyer', 'Autre loyer'],
  Salaires: ['Salaire fixe', 'Prime', 'Commission', 'Avance employé'],
  Marketing: ['Facebook Ads', 'Instagram Ads', 'Flyers', 'Shooting photo', 'Création contenu'],
  Entretien: ['Nettoyage', 'Réparation', 'Maintenance', 'Autre entretien'],
  Autre: ['Autre'],
};

const blankRules = {
  noShowEnabled: false,
  banAfter: 1,
  windowDays: 30,
  banDays: 30,
  noShowMessage: 'Votre numéro est temporairement bloqué suite à plusieurs rendez-vous non honorés.',
  loyaltyEnabled: false,
  visitsRequired: 10,
  rewardType: 'free_service',
  rewardValidityDays: 30,
};

const defaultHours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, active: true, start_time: '09:00', end_time: '23:59' }));

function initials(name) {
  return String(name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

function money(v) {
  return `${Math.round(Number(v || 0)).toLocaleString('fr-FR')} TND`;
}

function makeServiceMap(salons, rows) {
  const bySalon = {};
  rows.forEach((row) => {
    const sId = row.salonId || row.salon_id;
    if (!sId) return;
    bySalon[sId] = bySalon[sId] || [];
    bySalon[sId].push(row);
  });
  salons.forEach((salon) => {
    bySalon[salon.id] = bySalon[salon.id] || [];
  });
  return bySalon;
}

export default function App() {
  const [theme, setTheme] = useState(localStorage.getItem('mkass_theme') || 'light');
  const [view, setView] = useState('explore');
  const [dashTab, setDashTab] = useState('today');
  const [salons, setSalons] = useState(demoSalons);
  const [servicesBySalon, setServicesBySalon] = useState(servicesBySalonFromDemo());
  const [appointments, setAppointments] = useState(demoAppointments);
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(false);
  const [chip, setChip] = useState('all');
  const [search, setSearch] = useState('Tous les soins');
  const [locationText, setLocationText] = useState('Position actuelle');
  const [userCoords, setUserCoords] = useState(null);
  const [selectedSalonId, setSelectedSalonId] = useState(null);
  const [selectedModalSalonId, setSelectedModalSalonId] = useState(null);
  const [modalPicked, setModalPicked] = useState([]);
  const [pickedServices, setPickedServices] = useState([]);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const [bookingDate, setBookingDate] = useState('');
  const [bookingTime, setBookingTime] = useState('');
  const [bookingStep, setBookingStep] = useState(1);
  const [bookingRef, setBookingRef] = useState(null);
  const [slotsTaken, setSlotsTaken] = useState([]);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [auth, setAuth] = useState(() => ({
    token: localStorage.getItem('mkass_auth_token') || '',
    role: localStorage.getItem('mkass_auth_role') || '',
    salonId: localStorage.getItem('mkass_salon_id') || '',
    salonName: localStorage.getItem('mkass_salon_name') || '',
  }));
  const [myPhone, setMyPhone] = useState(localStorage.getItem('mkass_customer_phone') || '');
  const [myBookings, setMyBookings] = useState(null);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewComment, setReviewComment] = useState('');
  const [staffBySalon, setStaffBySalon] = useState(() => readLocalJson('mkass_staff_by_salon', {}));
  const [rulesBySalon, setRulesBySalon] = useState(() => readLocalJson('mkass_rules_by_salon', {}));
  const [expensesBySalon, setExpensesBySalon] = useState(() => readLocalJson('mkass_expenses_by_salon', {}));
  const [financePeriod, setFinancePeriodState] = useState('month');
  const [bookingForm, setBookingForm] = useState({ name: '', phone: '', note: '' });
  const [signupPlan, setSignupPlan] = useState('starter');
  const [signupPayment, setSignupPayment] = useState('flouci');

  const isAdmin = auth.role === 'admin';
  const loggedSalonId = isAdmin ? '__admin__' : auth.salonId;
  const currentSalon = salons.find((s) => s.id === auth.salonId) || null;
  const hasPro = isAdmin || String(currentSalon?.plan || 'starter').toLowerCase() === 'pro';

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('mkass_theme', theme);
  }, [theme]);

  useEffect(() => {
    document.body.classList.toggle('admin-logged', Boolean(auth.token));
    document.body.classList.toggle('show-explore-footer', view === 'explore');
  }, [auth.token, view]);

  useEffect(() => {
    loadPublicData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!auth.token) return;
    if (isAdmin) loadAdminData();
    else if (auth.salonId) {
      loadOwnerAppointments(auth.salonId);
      loadStaff(auth.salonId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.token, auth.role, auth.salonId]);

  useEffect(() => writeLocalJson('mkass_staff_by_salon', staffBySalon), [staffBySalon]);
  useEffect(() => writeLocalJson('mkass_rules_by_salon', rulesBySalon), [rulesBySalon]);
  useEffect(() => writeLocalJson('mkass_expenses_by_salon', expensesBySalon), [expensesBySalon]);

  function showToast(message) {
    setToast(message);
    window.clearTimeout(showToast._timer);
    showToast._timer = window.setTimeout(() => setToast(''), 3000);
  }

  async function loadPublicData() {
    setLoading(true);
    try {
      const salonRows = unwrapApi(await apiCall('GET', '/salons'), 'salons');
      if (!Array.isArray(salonRows)) throw new Error('Format salons invalide');
      const nextSalons = salonRows.map(normalizeApiSalon).map(applyLocalSalonOverlay);
      const entries = await Promise.all(nextSalons.map(async (salon) => {
        try {
          const rows = unwrapApi(await apiCall('GET', `/salons/${salon.id}/services`), 'services');
          return [salon.id, Array.isArray(rows) ? rows.map((r) => normalizeApiService(r, salon.id)) : []];
        } catch {
          return [salon.id, servicesBySalon[salon.id] || []];
        }
      }));
      setSalons(nextSalons);
      setServicesBySalon(Object.fromEntries(entries));
    } catch (err) {
      console.warn('API non disponible, démo conservée:', err.message);
      showToast('API non disponible: mode démo conservé');
    } finally {
      setLoading(false);
    }
  }

  function applyLocalSalonOverlay(salon) {
    const overlay = readLocalJson(`mkass_salon_overlay_${salon.id}`, {});
    return { ...salon, ...overlay };
  }

  async function loadAdminData() {
    try {
      const adminSalons = unwrapApi(await apiCall('GET', '/admin/salons', null, auth.token), 'salons');
      if (Array.isArray(adminSalons) && adminSalons.length) {
        const next = adminSalons.map(normalizeApiSalon).map(applyLocalSalonOverlay);
        setSalons(next);
        const entries = await Promise.all(next.map(async (salon) => {
          try {
            const rows = unwrapApi(await apiCall('GET', `/salons/${salon.id}/services`, null, auth.token), 'services');
            return [salon.id, Array.isArray(rows) ? rows.map((r) => normalizeApiService(r, salon.id)) : []];
          } catch {
            return [salon.id, servicesBySalon[salon.id] || []];
          }
        }));
        setServicesBySalon(Object.fromEntries(entries));
      }
    } catch (err) {
      console.warn(err.message);
    }
    try {
      const rows = unwrapApi(await apiCall('GET', '/admin/appointments', null, auth.token), 'appointments');
      if (Array.isArray(rows)) setAppointments(rows.map(normalizeApiAppointment));
    } catch (err) {
      console.warn(err.message);
    }
  }

  async function loadOwnerAppointments(salonId) {
    try {
      const rows = unwrapApi(await apiCall('GET', `/salons/${salonId}/appointments`, null, auth.token), 'appointments');
      if (!Array.isArray(rows)) return;
      const mine = rows.map(normalizeApiAppointment);
      setAppointments((prev) => prev.filter((a) => a.salonId !== salonId).concat(mine));
    } catch (err) {
      console.warn('Appointments:', err.message);
    }
  }

  async function loadStaff(salonId) {
    if (!salonId) return;
    try {
      const path = auth.token ? `/salons/${salonId}/staff` : `/salons/${salonId}/public-staff`;
      const rows = unwrapApi(await apiCall('GET', path, null, auth.token || null), 'staff');
      if (Array.isArray(rows)) {
        setStaffBySalon((prev) => ({ ...prev, [salonId]: rows.map(normalizeStaff) }));
      }
    } catch (err) {
      console.warn('Staff fallback:', err.message);
    }
  }

  async function tryLogin(username, password) {
    if (!username || !password) return showToast('Entrez vos identifiants');
    try {
      const data = await apiCall('POST', '/auth/login', { username: username.trim().toLowerCase(), password });
      const nextAuth = {
        token: data.token || '',
        role: data.role || '',
        salonId: data.salonId || data.salon_id || '',
        salonName: data.salonName || data.salon_name || username,
      };
      setAuth(nextAuth);
      localStorage.setItem('mkass_auth_token', nextAuth.token);
      localStorage.setItem('mkass_auth_role', nextAuth.role);
      localStorage.setItem('mkass_salon_id', nextAuth.salonId || '');
      localStorage.setItem('mkass_salon_name', nextAuth.salonName || '');
      setView('dashboard');
      setDashTab('today');
      showToast('Connexion réussie');
    } catch (err) {
      showToast(err.message || 'Identifiants incorrects');
    }
  }

  function logout() {
    setAuth({ token: '', role: '', salonId: '', salonName: '' });
    localStorage.removeItem('mkass_auth_token');
    localStorage.removeItem('mkass_auth_role');
    localStorage.removeItem('mkass_salon_id');
    localStorage.removeItem('mkass_salon_name');
    setView('dashboard');
    setDashTab('today');
    showToast('Déconnecté');
  }

  function guardPro(tab) {
    if (!hasPro && ['finance', 'staff', 'rules'].includes(tab)) {
      showToast('Cette fonction est disponible avec le pack Pro.');
      setDashTab('salonMenu');
      setView('dashboard');
      return;
    }
    setDashTab(tab);
    setView('dashboard');
  }

  const filteredSalons = useMemo(() => {
    const q = String(search || '').toLowerCase().replace('tous les soins', '').trim();
    const rows = salons.filter((salon) => {
      const services = servicesBySalon[salon.id] || [];
      const text = [salon.name, salon.address, salon.type, ...(salon.tags || []), ...services.map((s) => s.name)].join(' ').toLowerCase();
      const matchesQ = !q || text.includes(q);
      const matchesChip = chip === 'all'
        || (chip === 'near' && getSalonCoords(salon))
        || (chip === 'open' && salon.status === 'open')
        || (chip === 'top' && Number(salon.rating || 0) >= 4.7)
        || salon.type === chip;
      return matchesQ && matchesChip;
    });
    if (chip === 'near' && userCoords) {
      return rows.slice().sort((a, b) => (haversineKm(userCoords, getSalonCoords(a)) ?? 9999) - (haversineKm(userCoords, getSalonCoords(b)) ?? 9999));
    }
    if (chip === 'top') return rows.slice().sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0));
    return rows;
  }, [salons, servicesBySalon, chip, search, userCoords]);

  function openModal(salonId) {
    setSelectedModalSalonId(salonId);
    setModalPicked([]);
    loadStaff(salonId);
    loadReviews(salonId);
  }

  async function loadReviews(salonId) {
    try {
      const rows = unwrapApi(await apiCall('GET', `/reviews/salon/${salonId}`), 'reviews');
      if (Array.isArray(rows)) {
        setSalons((prev) => prev.map((s) => s.id === salonId ? { ...s, reviews: rows, reviewCount: rows.length } : s));
      }
    } catch (err) {
      console.warn(err.message);
    }
  }

  function bookSalon(salonId, presetServices = []) {
    setSelectedSalonId(salonId);
    setPickedServices(presetServices);
    setSelectedStaff(null);
    setBookingDate('');
    setBookingTime('');
    setBookingStep(1);
    setBookingRef(null);
    setBookingForm({ name: '', phone: myPhone || '', note: '' });
    setSelectedModalSalonId(null);
    setView('booking');
    loadStaff(salonId);
  }

  async function loadSlotsForDate(salonId, date) {
    setSlotsTaken([]);
    if (!salonId || !date) return;
    try {
      const rows = unwrapApi(await apiCall('GET', `/salons/${salonId}/slots?date=${date}`), 'slots');
      if (Array.isArray(rows)) setSlotsTaken(rows.filter((s) => !s.available).map((s) => String(s.time).slice(0, 5)));
    } catch {
      setSlotsTaken(appointments.filter((a) => a.salonId === salonId && a.date === date && a.status !== 'cancelled').map((a) => a.time));
    }
  }

  async function confirmBooking() {
    const salonId = selectedSalonId || salons[0]?.id;
    if (!salonId || !bookingForm.name || !bookingForm.phone || !bookingDate || !bookingTime || pickedServices.length === 0) {
      return showToast('Complétez la réservation');
    }
    const phone = cleanPhone(bookingForm.phone);
    localStorage.setItem('mkass_customer_phone', phone);
    setMyPhone(phone);
    const total = pickedServices.reduce((sum, s) => sum + Number(s.price || 0), 0);
    try {
      const payload = await apiCall('POST', `/salons/${salonId}/appointments`, {
        customer_name: bookingForm.name,
        customerName: bookingForm.name,
        clientName: bookingForm.name,
        phone,
        clientPhone: phone,
        services: pickedServices.map((s) => s.name),
        service_names: pickedServices.map((s) => s.name),
        prices: pickedServices.map((s) => Number(s.price || 0)),
        total,
        date: bookingDate,
        appointment_date: bookingDate,
        time: bookingTime,
        appointment_time: bookingTime,
        note: bookingForm.note,
        staffId: selectedStaff?.id || null,
        staff_id: selectedStaff?.id || null,
        duration_minutes: pickedServices.reduce((sum, s) => sum + parseDurationMinutes(s.dur || s.duration), 0),
      });
      const saved = normalizeApiAppointment(unwrapApi(payload, 'appointment') || payload || {});
      const appt = {
        ...saved,
        salonId,
        client: saved.client || bookingForm.name,
        phone,
        services: saved.services?.length ? saved.services : pickedServices.map((s) => s.name),
        prices: saved.prices?.length ? saved.prices : pickedServices.map((s) => s.price),
        total: saved.total || total,
        date: saved.date || bookingDate,
        time: saved.time || bookingTime,
        status: saved.status || 'pending',
        staffId: selectedStaff?.id || saved.staffId || null,
        staffName: selectedStaff?.name || saved.staffName || null,
      };
      setAppointments((prev) => prev.concat(appt));
      setBookingRef(appt);
      setBookingStep(4);
      showToast(`✓ Réservation confirmée — ${appt.id}`);
    } catch (err) {
      showToast(err.message || 'Erreur réservation');
    }
  }

  async function updateStatus(appt, status) {
    try {
      await apiCall('PATCH', `/salons/${appt.salonId}/appointments/${appt.id}/status`, { status }, auth.token);
      setAppointments((prev) => prev.map((a) => a.id === appt.id ? { ...a, status } : a));
      showToast(`Statut → ${STATUS[status] || status}`);
    } catch (err) {
      showToast(err.message || 'Erreur statut');
    }
  }

  async function addWalkin({ name, picked, payMode }) {
    if (!picked.length) return showToast('Choisissez au moins un service');
    const salonId = auth.salonId;
    const total = picked.reduce((sum, s) => sum + Number(s.price || 0), 0);
    try {
      const payload = await apiCall('POST', `/salons/${salonId}/appointments/walkin`, {
        customer_name: name || 'Anonyme',
        customerName: name || 'Anonyme',
        services: picked.map((s) => s.name),
        prices: picked.map((s) => s.price),
        total,
        payment: payMode,
        paymentMode: payMode,
      }, auth.token);
      const saved = normalizeApiAppointment(unwrapApi(payload, 'appointment') || payload || {});
      const now = new Date();
      const appt = {
        ...saved,
        id: saved.id || `MKS-WI-${Date.now()}`,
        salonId,
        client: saved.client || name || 'Anonyme',
        services: saved.services?.length ? saved.services : picked.map((s) => s.name),
        total: saved.total || total,
        date: saved.date || todayStr(),
        time: saved.time || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        status: 'done',
        type: 'walkin',
        payMode,
      };
      setAppointments((prev) => prev.concat(appt));
      showToast(`💵 Paiement enregistré — ${money(total)}`);
    } catch (err) {
      showToast(err.message || 'Erreur walk-in');
    }
  }

  async function addService(form) {
    if (!form.name || !form.dur || !Number(form.price)) return showToast('Remplissez tous les champs');
    try {
      const duration = parseDurationMinutes(form.dur);
      const payload = await apiCall('POST', `/salons/${auth.salonId}/services`, {
        category: form.cat,
        cat: form.cat,
        name: form.name,
        duration,
        dur: form.dur,
        price: Number(form.price),
      }, auth.token);
      const saved = normalizeApiService(unwrapApi(payload, 'service') || payload || form, auth.salonId);
      setServicesBySalon((prev) => ({ ...prev, [auth.salonId]: [...(prev[auth.salonId] || []), saved] }));
      showToast(`✓ Service ajouté: ${form.name}`);
      return true;
    } catch (err) {
      showToast(err.message || 'Erreur ajout service');
      return false;
    }
  }

  async function deleteService(serviceId) {
    if (!window.confirm('Supprimer ce service ?')) return;
    try {
      await apiCall('DELETE', `/salons/${auth.salonId}/services/${serviceId}`, null, auth.token);
      setServicesBySalon((prev) => ({ ...prev, [auth.salonId]: (prev[auth.salonId] || []).filter((s) => String(s.id) !== String(serviceId)) }));
      showToast('Service supprimé');
    } catch (err) {
      showToast(err.message || 'Erreur suppression service');
    }
  }

  async function saveSettings(form, setButtonState) {
    const salonId = auth.salonId;
    const salon = salons.find((s) => s.id === salonId);
    if (!salon) return;
    const linkCoords = mkassExtractCoordsFromMapUrl(form.mapUrl);
    const lat = Number(form.latitude || linkCoords?.lat);
    const lng = Number(form.longitude || linkCoords?.lng);
    const coordsValid = Number.isFinite(lat) && Number.isFinite(lng);
    if ((form.latitude || form.longitude) && !coordsValid) {
      showToast('Latitude ou longitude invalide');
      return;
    }
    const patch = {
      name: form.name,
      address: form.address,
      status: form.status,
      map_url: form.mapUrl || '',
      mapUrl: form.mapUrl || '',
      ...(coordsValid ? { lat, lng, latitude: lat, longitude: lng } : {}),
    };
    if (form.coverImg) patch.coverImg = form.coverImg;
    setButtonState?.('saving');
    try {
      const payload = await apiCall('PUT', `/salons/${salonId}`, patch, auth.token);
      const updated = normalizeApiSalon(unwrapApi(payload, 'salon') || { ...salon, ...patch });
      const merged = { ...salon, ...updated, ...patch };
      setSalons((prev) => prev.map((s) => s.id === salonId ? merged : s));
      writeLocalJson(`mkass_salon_overlay_${salonId}`, {
        mapUrl: patch.mapUrl,
        latitude: coordsValid ? lat : salon.latitude,
        longitude: coordsValid ? lng : salon.longitude,
      });
      setButtonState?.('saved');
      showToast('✓ Paramètres sauvegardés');
      window.setTimeout(() => setButtonState?.('idle'), 1800);
    } catch (err) {
      setButtonState?.('error');
      showToast(err.message || 'Erreur paramètres');
      window.setTimeout(() => setButtonState?.('idle'), 2200);
    }
  }

  async function loadMyBookings() {
    const phone = cleanPhone(myPhone);
    if (!phone) return showToast('Entrez votre numéro de téléphone');
    localStorage.setItem('mkass_customer_phone', phone);
    setMyBookings('loading');
    try {
      const rows = unwrapApi(await apiCall('GET', `/salons/appointments/by-phone?phone=${encodeURIComponent(phone)}`), 'appointments');
      setMyBookings(Array.isArray(rows) ? rows.map(normalizeApiAppointment) : []);
    } catch (err) {
      setMyBookings([]);
      showToast(err.message || 'Erreur chargement réservations');
    }
  }

  async function submitReview() {
    if (!reviewTarget) return;
    try {
      await apiCall('POST', '/reviews', {
        appointmentId: reviewTarget.id,
        rating: Number(reviewRating),
        comment: reviewComment,
      });
      setReviewTarget(null);
      setReviewComment('');
      setReviewRating(5);
      showToast('Merci pour votre avis');
      if (myPhone) loadMyBookings();
    } catch (err) {
      showToast(err.message || 'Erreur avis');
    }
  }

  async function saveStaff(staffForm) {
    const salonId = auth.salonId;
    try {
      const payload = await apiCall('POST', `/salons/${salonId}/staff/full-save`, staffForm, auth.token);
      const saved = normalizeStaff(unwrapApi(payload, 'staff') || payload || staffForm);
      setStaffBySalon((prev) => {
        const current = prev[salonId] || [];
        const exists = current.some((s) => String(s.id) === String(saved.id));
        return { ...prev, [salonId]: exists ? current.map((s) => String(s.id) === String(saved.id) ? saved : s) : current.concat(saved) };
      });
      showToast('✓ Personnel sauvegardé');
      return true;
    } catch (err) {
      // Local fallback keeps the UI usable if backend schema/plan is not ready.
      const saved = normalizeStaff({ ...staffForm, id: staffForm.id || `local-${Date.now()}`, salon_id: salonId });
      setStaffBySalon((prev) => {
        const current = prev[salonId] || [];
        const exists = current.some((s) => String(s.id) === String(saved.id));
        return { ...prev, [salonId]: exists ? current.map((s) => String(s.id) === String(saved.id) ? saved : s) : current.concat(saved) };
      });
      showToast('Personnel sauvegardé localement');
      return true;
    }
  }

  function saveRules(nextRules) {
    const salonId = auth.salonId;
    setRulesBySalon((prev) => ({ ...prev, [salonId]: nextRules }));
    showToast('✓ Règles sauvegardées');
  }

  function addExpense(expense) {
    const salonId = auth.salonId;
    const row = { ...expense, id: `EXP-${Date.now()}`, amount: Number(expense.amount || 0), date: expense.date || todayStr() };
    if (!row.amount) return showToast('Montant invalide');
    setExpensesBySalon((prev) => ({ ...prev, [salonId]: [row, ...(prev[salonId] || [])] }));
    showToast('✓ Dépense ajoutée');
  }

  async function createAdminSalon(form) {
    if (!form.name || !form.address || !form.password) return showToast('Remplissez tous les champs');
    try {
      const payload = await apiCall('POST', '/salons', {
        username: form.username || slugifyName(form.name),
        name: form.name,
        address: form.address,
        map_url: form.mapUrl || '',
        mapUrl: form.mapUrl || '',
        icon: form.icon || '✂️',
        type: form.type,
        password: form.password,
        status: 'open',
      }, auth.token);
      const salon = normalizeApiSalon(unwrapApi(payload, 'salon') || payload || {});
      setSalons((prev) => prev.concat(salon));
      setServicesBySalon((prev) => ({ ...prev, [salon.id]: [] }));
      showToast(`✓ Salon créé: ${form.name}`);
      return true;
    } catch (err) {
      showToast(err.message || 'Erreur création salon');
      return false;
    }
  }

  async function deleteAdminSalon(salonId) {
    if (!window.confirm('Supprimer ce salon ?')) return;
    try {
      await apiCall('DELETE', `/salons/${salonId}`, null, auth.token);
      setSalons((prev) => prev.filter((s) => s.id !== salonId));
      showToast('Salon supprimé');
    } catch (err) {
      showToast(err.message || 'Erreur suppression salon');
    }
  }

  const selectedModalSalon = salons.find((s) => s.id === selectedModalSalonId) || null;
  const bookingSalon = salons.find((s) => s.id === selectedSalonId) || salons[0] || null;

  return (
    <>
      <Nav
        theme={theme}
        setTheme={setTheme}
        setView={setView}
        loggedIn={Boolean(auth.token)}
      />

      {view === 'explore' && (
        <ExplorePage
          salons={filteredSalons}
          allSalons={salons}
          servicesBySalon={servicesBySalon}
          chip={chip}
          setChip={setChip}
          search={search}
          setSearch={setSearch}
          locationText={locationText}
          setLocationText={setLocationText}
          userCoords={userCoords}
          setUserCoords={setUserCoords}
          openModal={openModal}
          bookSalon={bookSalon}
          showToast={showToast}
          loading={loading}
        />
      )}

      {view === 'booking' && (
        <BookingPage
          salon={bookingSalon}
          services={servicesBySalon[bookingSalon?.id] || []}
          staff={(staffBySalon[bookingSalon?.id] || []).filter((s) => s.active !== false)}
          pickedServices={pickedServices}
          setPickedServices={setPickedServices}
          selectedStaff={selectedStaff}
          setSelectedStaff={setSelectedStaff}
          bookingStep={bookingStep}
          setBookingStep={setBookingStep}
          bookingDate={bookingDate}
          setBookingDate={(d) => { setBookingDate(d); setBookingTime(''); loadSlotsForDate(bookingSalon?.id, d); }}
          bookingTime={bookingTime}
          setBookingTime={setBookingTime}
          bookingForm={bookingForm}
          setBookingForm={setBookingForm}
          bookingRef={bookingRef}
          confirmBooking={confirmBooking}
          slotsTaken={slotsTaken}
          calendarMonth={calendarMonth}
          setCalendarMonth={setCalendarMonth}
          setView={setView}
        />
      )}

      {view === 'my-bookings' && (
        <MyBookingsPage
          phone={myPhone}
          setPhone={setMyPhone}
          bookings={myBookings}
          loadMyBookings={loadMyBookings}
          salons={salons}
          openReview={(appt) => { setReviewTarget(appt); setReviewRating(5); setReviewComment(''); }}
        />
      )}

      {view === 'signup' && (
        <SignupPage
          plan={signupPlan}
          setPlan={setSignupPlan}
          payment={signupPayment}
          setPayment={setSignupPayment}
          showToast={showToast}
          setView={setView}
        />
      )}

      {view === 'dashboard' && (
        <DashboardPage
          auth={auth}
          salons={salons}
          servicesBySalon={servicesBySalon}
          appointments={appointments}
          currentSalon={currentSalon}
          isAdmin={isAdmin}
          hasPro={hasPro}
          dashTab={dashTab}
          setDashTab={guardPro}
          rawSetDashTab={setDashTab}
          tryLogin={tryLogin}
          logout={logout}
          updateStatus={updateStatus}
          addWalkin={addWalkin}
          addService={addService}
          deleteService={deleteService}
          saveSettings={saveSettings}
          staff={staffBySalon[auth.salonId] || []}
          saveStaff={saveStaff}
          rules={rulesBySalon[auth.salonId] || blankRules}
          saveRules={saveRules}
          expenses={expensesBySalon[auth.salonId] || []}
          addExpense={addExpense}
          financePeriod={financePeriod}
          setFinancePeriod={setFinancePeriodState}
          createAdminSalon={createAdminSalon}
          deleteAdminSalon={deleteAdminSalon}
          setView={setView}
          showToast={showToast}
        />
      )}

      <Footer />

      <BottomNav
        loggedIn={Boolean(auth.token)}
        activeView={view}
        activeDash={dashTab}
        setView={setView}
        setDashTab={guardPro}
        showToast={showToast}
        hasPro={hasPro}
      />

      {selectedModalSalon && (
        <SalonModal
          salon={selectedModalSalon}
          services={servicesBySalon[selectedModalSalon.id] || []}
          picked={modalPicked}
          setPicked={setModalPicked}
          close={() => setSelectedModalSalonId(null)}
          bookSalon={bookSalon}
        />
      )}

      {reviewTarget && (
        <ReviewModal
          appt={reviewTarget}
          rating={reviewRating}
          setRating={setReviewRating}
          comment={reviewComment}
          setComment={setReviewComment}
          close={() => setReviewTarget(null)}
          submit={submitReview}
        />
      )}

      <div className={`toast ${toast ? 'show' : ''}`}>{toast}</div>
      <div className="api-badge" title="API utilisée">Test API</div>
    </>
  );
}

function readLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* noop */ }
}

function normalizeStaff(row) {
  return {
    id: row.id || row.staffId || `local-${Date.now()}`,
    salonId: row.salonId || row.salon_id,
    name: row.name || 'Employé',
    phone: row.phone || '',
    role: row.role || '',
    active: row.active !== false,
    commissionRate: Number(row.commissionRate ?? row.commission_rate ?? 0),
    username: row.username || '',
    accountActive: Boolean(row.accountActive ?? row.account_active ?? false),
    serviceIds: row.serviceIds || row.service_ids || [],
    hours: row.hours || defaultHours,
  };
}

function Nav({ theme, setTheme, setView, loggedIn }) {
  return (
    <nav className="nav">
      <button className="logo clean-button" onClick={() => setView('explore')}>
        <LogoMark />
        <span className="logo-text mkass-word">Mkass</span>
      </button>
      <div className="nav-r">
        <button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Changer le mode sombre" />
        {!loggedIn && <button className="nav-pill signup-nav" onClick={() => setView('signup')}>S'inscrire</button>}
        {!loggedIn && <button className="nav-pill" onClick={() => setView('dashboard')}>Se connecter</button>}
      </div>
    </nav>
  );
}

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="6" cy="6" r="3" stroke="#FFFFFF" strokeWidth="2" />
        <circle cx="6" cy="18" r="3" stroke="#FFFFFF" strokeWidth="2" />
        <path d="M8.5 8.5L20 20" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
        <path d="M8.5 15.5L20 4" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function BottomNav({ loggedIn, activeView, activeDash, setView, setDashTab, hasPro }) {
  if (loggedIn) {
    return (
      <div className="nav-tabs" aria-label="Navigation gérant">
        <button className={`ntab ${activeView === 'dashboard' && activeDash === 'today' ? 'active' : ''}`} onClick={() => setDashTab('today')}>Aujourd'hui</button>
        <button className={`ntab ${activeView === 'dashboard' && activeDash === 'finance' ? 'active' : ''}`} onClick={() => setDashTab('finance')}>Finance</button>
        <button className={`ntab ${activeView === 'dashboard' && activeDash === 'salonMenu' ? 'active' : ''}`} onClick={() => setDashTab('salonMenu')}>Salon</button>
      </div>
    );
  }
  return (
    <div className="nav-tabs" aria-label="Navigation principale">
      <button className={`ntab ${activeView === 'explore' ? 'active' : ''}`} onClick={() => setView('explore')}>Explorer</button>
      <button className={`ntab ${activeView === 'my-bookings' ? 'active' : ''}`} onClick={() => setView('my-bookings')}>Mes réservations</button>
      <button className={`ntab ${activeView === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')}>Se connecter</button>
    </div>
  );
}

function ExplorePage({ salons, allSalons, servicesBySalon, chip, setChip, search, setSearch, locationText, setLocationText, userCoords, setUserCoords, openModal, bookSalon, showToast, loading }) {
  const featured = allSalons.find((s) => s.status === 'open') || allSalons[0];
  const serviceSuggestions = useMemo(() => {
    const names = new Set(['Tous les soins']);
    Object.values(servicesBySalon).flat().forEach((s) => names.add(s.name));
    return Array.from(names).slice(0, 18);
  }, [servicesBySalon]);

  function useCurrentLocation() {
    if (!navigator.geolocation) return showToast('Localisation non disponible');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocationText('Position actuelle');
        setChip('near');
        showToast('Position détectée');
      },
      () => showToast('Autorisez la localisation pour voir les salons proches'),
      { enableHighAccuracy: true, timeout: 9000 },
    );
  }

  return (
    <main id="view-explore" className="view active">
      <section className="mk-hero-wrap">
        <div className="mk-hero">
          <div className="mk-hero-copy">
            <div className="mk-label"><span />Tunis & environs</div>
            <h1>Trouvez votre <em>coiffeur idéal</em></h1>
            <p>Réservez en ligne dans les meilleurs salons et barbershops près de chez vous.</p>
            <div className="mk-search mk-search-video-style">
              <div className="mk-field mk-field-service">
                <div className="mk-icon mk-search-ico" />
                <div className="mk-field-body">
                  <small>Service</small>
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Tous les soins" list="service-suggestions" />
                  <datalist id="service-suggestions">
                    {serviceSuggestions.map((name) => <option key={name} value={name} />)}
                  </datalist>
                </div>
              </div>
              <div className="mk-field mk-field-location">
                <div className="mk-icon mk-pin" />
                <div className="mk-field-body">
                  <small>Position</small>
                  <input value={locationText} onChange={(e) => setLocationText(e.target.value)} placeholder="Tunis" />
                </div>
                <button className="mk-current-location-btn" type="button" onClick={useCurrentLocation}>Ma position</button>
              </div>
              <button className="mk-search-btn" onClick={() => showToast('Recherche mise à jour')}>Rechercher</button>
            </div>
          </div>
          <div className="mk-hero-visual">
            <img src={featured?.coverImg || 'https://images.unsplash.com/photo-1622287162716-f311baa1a2b8?q=80&w=1200&auto=format&fit=crop'} alt="Salon populaire" />
            <div className="mk-floating-card">
              <div>
                <h3>{featured?.name || 'Mkass'}</h3>
                <p>Le plus réservé · Disponible demain</p>
              </div>
              <div className="mk-rating">★ {Number(featured?.rating || 5).toFixed(1)}</div>
              {featured && <button onClick={() => bookSalon(featured.id)}>Réserver</button>}
            </div>
          </div>
        </div>
        <div className="mk-trust-row" aria-label="Avantages Mkass">
          <div className="mk-trust-item"><span />Réservation instantanée</div>
          <div className="mk-trust-item"><span />Annulation gratuite</div>
          <div className="mk-trust-item"><span />Paiement au salon</div>
          <div className="mk-trust-item"><span />Avis vérifiés</div>
        </div>
      </section>

      <div className="chips mk-filters">
        {[
          ['all', 'Tous'], ['near', 'Près de moi'], ['open', 'Ouvert maintenant'], ['top', 'Les mieux notés'], ['barbershop', 'Barbershops'], ['salon', 'Salons femme'],
        ].map(([key, label]) => <button key={key} className={`chip ${chip === key ? 'active' : ''}`} onClick={() => key === 'near' && !userCoords ? useCurrentLocation() : setChip(key)}>{label}</button>)}
      </div>

      <section className="shops-wrap">
        <div className="shops-meta">
          <div>
            <h2>Salons à proximité</h2>
            <p className="mk-section-sub">Les meilleurs établissements disponibles autour de vous</p>
          </div>
          <span>{loading ? 'Chargement...' : `${salons.length} salon${salons.length > 1 ? 's' : ''} trouvé${salons.length > 1 ? 's' : ''}`}</span>
        </div>
        <div className="shops-grid">
          {salons.map((salon) => (
            <SalonCard
              key={salon.id}
              salon={salon}
              services={servicesBySalon[salon.id] || []}
              userCoords={userCoords}
              openModal={openModal}
              bookSalon={bookSalon}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function SalonCard({ salon, services, userCoords, openModal, bookSalon }) {
  const minPrice = services.length ? Math.min(...services.map((s) => Number(s.price || 0))) : 0;
  const coords = getSalonCoords(salon);
  const distance = userCoords && coords ? haversineKm(userCoords, coords) : null;
  const statusClass = salon.status === 'open' ? 'badge-open' : salon.status === 'busy' ? 'badge-busy' : 'badge-closed';
  const statusText = salon.status === 'open' ? '● Ouvert' : salon.status === 'busy' ? '◐ Très demandé' : '● Fermé';
  return (
    <article className="shop-card" onClick={() => openModal(salon.id)}>
      <div className="shop-cover">
        {salon.coverImg ? <img src={salon.coverImg} alt="" /> : <div className="shop-cover-placeholder">{salon.icon}</div>}
        <div className="cover-badge"><span className={`badge ${statusClass}`}>{statusText}</span></div>
        {distance !== null && <div className="cover-dist">📍 {distance.toFixed(1)} km</div>}
      </div>
      <div className="shop-body">
        <div className="shop-row1">
          <div className="shop-name">{salon.name}</div>
          <div className="shop-rating"><span className="star">★</span>{Number(salon.rating || 5).toFixed(1)} <span className="review-count">({salon.reviewCount || 0})</span></div>
        </div>
        <div className="shop-type-lbl">{TYPE_LABELS[salon.type] || salon.type}</div>
        <div className="shop-tags">
          {(salon.tags || []).slice(0, 3).map((tag) => <span key={tag} className="shop-tag">{tag}</span>)}
          {salon.childCut && <span className="shop-tag lime">✂ Enfants</span>}
        </div>
        <div className="shop-foot">
          <div className="shop-from">À partir de <strong>{minPrice} TND</strong></div>
          <button className="book-btn" onClick={(e) => { e.stopPropagation(); bookSalon(salon.id); }}>Réserver →</button>
        </div>
      </div>
    </article>
  );
}

function SalonModal({ salon, services, picked, setPicked, close, bookSalon }) {
  const total = picked.reduce((sum, s) => sum + Number(s.price || 0), 0);
  const mapUrl = getDirectionsUrl(salon);
  function toggle(service) {
    setPicked((prev) => prev.some((s) => String(s.id) === String(service.id)) ? prev.filter((s) => String(s.id) !== String(service.id)) : prev.concat(service));
  }
  return (
    <div className="overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-handle clean-button" onClick={close} aria-label="Fermer" />
        <div className="modal-cover">{salon.coverImg ? <img src={salon.coverImg} alt="" /> : <div className="modal-cover-ph">{salon.icon}</div>}</div>
        <div className="modal-hdr">
          <div className="modal-icon" style={{ background: `${salon.color}25` }}>{salon.icon}</div>
          <div>
            <div className="modal-title">{salon.name}</div>
            <button className="modal-addr map-link clean-button" onClick={() => mapUrl ? window.open(mapUrl, '_blank') : null}>📍 {salon.address || 'Adresse non disponible'}</button>
          </div>
        </div>
        <div className="modal-stats">
          <div className="mstat"><div className="mstat-val lime">{Number(salon.rating || 5).toFixed(1)}</div><div className="mstat-lbl">Note</div></div>
          <div className="mstat"><div className="mstat-val">{salon.reviewCount || 0}</div><div className="mstat-lbl">Avis</div></div>
          <div className="mstat"><div className="mstat-val">{getSalonCoords(salon) ? 'GPS' : '—'}</div><div className="mstat-lbl">Distance</div></div>
        </div>
        <div className="modal-svcs-title">Choisissez vos services</div>
        <div className="modal-svc-list">
          {services.map((svc) => {
            const isPicked = picked.some((s) => String(s.id) === String(svc.id));
            return (
              <button key={svc.id} className={`modal-svc-item clean-button ${isPicked ? 'picked' : ''}`} onClick={() => toggle(svc)}>
                <div className="modal-svc-left">
                  <span className="modal-svc-check">✓</span>
                  <span><span className="modal-svc-name">{svc.name}</span><span className="modal-svc-dur">⏱ {svc.dur}</span></span>
                </div>
                <span className="modal-svc-price">{svc.price} TND</span>
              </button>
            );
          })}
        </div>
        <div className="modal-total-bar"><span>Total sélectionné</span><strong>{total} TND</strong></div>
        <button className="modal-book-btn" disabled={!picked.length} onClick={() => bookSalon(salon.id, picked)}>{picked.length ? `Réserver — ${total} TND →` : 'Sélectionnez au moins un service'}</button>
        <div className="reviews-section">
          <div className="reviews-lbl">Avis clients</div>
          {(salon.reviews || []).length ? (salon.reviews || []).map((r, idx) => (
            <div className="review" key={r.id || idx}>
              <div className="rev-top">
                <div className="rev-person"><div className="rev-av" style={{ background: salon.color }}>{initials(r.author_name || r.client_name || r.name || 'Client')}</div><div><div className="rev-name">{r.author_name || r.client_name || r.name || 'Client'}</div><div className="rev-date">{r.created_at ? formatDate(r.created_at) : ''}</div></div></div>
                <div className="rev-stars">{'★'.repeat(Number(r.rating || r.stars || 5))}</div>
              </div>
              <div className="rev-text">“{r.comment || r.text || ''}”</div>
            </div>
          )) : <div className="review"><div className="rev-text">Aucun avis pour le moment.</div></div>}
        </div>
      </div>
    </div>
  );
}

function BookingPage({ salon, services, staff, pickedServices, setPickedServices, selectedStaff, setSelectedStaff, bookingStep, setBookingStep, bookingDate, setBookingDate, bookingTime, setBookingTime, bookingForm, setBookingForm, bookingRef, confirmBooking, slotsTaken, calendarMonth, setCalendarMonth, setView }) {
  const total = pickedServices.reduce((sum, s) => sum + Number(s.price || 0), 0);
  const canGo2 = pickedServices.length > 0;
  const canGo3 = Boolean(bookingDate && bookingTime);
  const canConfirm = Boolean(bookingForm.name && bookingForm.phone && canGo3 && pickedServices.length);
  const eligibleStaff = staff.filter((member) => {
    if (!pickedServices.length || !Array.isArray(member.serviceIds) || !member.serviceIds.length) return true;
    return pickedServices.every((svc) => member.serviceIds.map(String).includes(String(svc.id)));
  });
  return (
    <main className="view active" id="view-booking">
      <div className="bk-wrap">
        <div className="bk-salon-bar">
          <div className="bk-salon-icon">{salon?.icon || '✂️'}</div>
          <div>
            <div className="bk-salon-name">{salon?.name || 'Mkass — Réservation'}</div>
            <div className="bk-salon-addr">{salon?.address || 'Choisissez un salon depuis Explorer'}</div>
          </div>
        </div>
        <Steps step={bookingStep} />
        {bookingStep === 1 && (
          <div className="sp active">
            <div className="sp-title">Choisissez vos services</div>
            <ServiceGrid services={services} picked={pickedServices} setPicked={setPickedServices} />
            <Summary picked={pickedServices} />
            {pickedServices.length > 0 && (
              <StaffSelector staff={eligibleStaff} selectedStaff={selectedStaff} setSelectedStaff={setSelectedStaff} />
            )}
            <div className="step-acts"><button className="btn btn-lime" disabled={!canGo2} onClick={() => setBookingStep(2)}>Continuer →</button></div>
          </div>
        )}
        {bookingStep === 2 && (
          <div className="sp active">
            <div className="sp-title">Date & heure</div>
            <Summary picked={pickedServices} date={bookingDate} time={bookingTime} />
            <div className="cal-layout">
              <CalendarBox month={calendarMonth} setMonth={setCalendarMonth} selected={bookingDate} setSelected={setBookingDate} />
              <div className="slots-box">
                <div className="slots-lbl">Créneaux disponibles</div>
                <div className="slots-grid">
                  {bookingDate ? ALL_SLOTS.map((slot) => {
                    const taken = slotsTaken.includes(slot);
                    return <button key={slot} className={`slot ${bookingTime === slot ? 'sel' : ''} ${taken ? 'taken' : ''}`} disabled={taken} onClick={() => setBookingTime(slot)}>{slot}</button>;
                  }) : <div className="no-msg" style={{ gridColumn: '1/-1' }}>Sélectionnez une date</div>}
                </div>
              </div>
            </div>
            <div className="step-acts"><button className="btn btn-ghost" onClick={() => setBookingStep(1)}>← Retour</button><button className="btn btn-lime" disabled={!canGo3} onClick={() => setBookingStep(3)}>Continuer →</button></div>
          </div>
        )}
        {bookingStep === 3 && (
          <div className="sp active">
            <div className="sp-title">Vos coordonnées</div>
            <Summary picked={pickedServices} date={bookingDate} time={bookingTime} />
            <div className="card form-card">
              <div className="f-row"><label className="f-label">Nom complet</label><input className="f-input" value={bookingForm.name} onChange={(e) => setBookingForm({ ...bookingForm, name: e.target.value })} placeholder="Fatima Ben Ali" /></div>
              <div className="f-row"><label className="f-label">Téléphone</label><input className="f-input" value={bookingForm.phone} onChange={(e) => setBookingForm({ ...bookingForm, phone: e.target.value })} placeholder="+216 XX XXX XXX" /></div>
              <div className="f-row"><label className="f-label">Notes (optionnel)</label><input className="f-input" value={bookingForm.note} onChange={(e) => setBookingForm({ ...bookingForm, note: e.target.value })} placeholder="Préférence coiffeur, allergie..." /></div>
            </div>
            <div className="step-acts"><button className="btn btn-ghost" onClick={() => setBookingStep(2)}>← Retour</button><button className="btn btn-lime" disabled={!canConfirm} onClick={confirmBooking}>Confirmer ✓</button></div>
          </div>
        )}
        {bookingStep === 4 && (
          <div className="sp active">
            <div className="succ">
              <div className="succ-icon">✓</div>
              <h2>Réservation confirmée !</h2>
              <p>Votre réservation a bien été enregistrée.</p>
              <div className="ref-pill">{bookingRef?.id || 'MKS-0000'}</div>
              <div className="succ-detail">
                <div className="sd-row"><span>Salon</span><strong>{salon?.name}</strong></div>
                {pickedServices.map((s) => <div className="sd-row" key={s.id}><span>{s.name}</span><strong>{s.price} TND</strong></div>)}
                {selectedStaff && <div className="sd-row"><span>Personnel</span><strong>{selectedStaff.name}</strong></div>}
                <div className="sd-row"><span>Total</span><strong>{total} TND</strong></div>
                <div className="sd-row"><span>Date</span><strong>{formatLongDate(bookingDate)}</strong></div>
                <div className="sd-row"><span>Heure</span><strong>{bookingTime}</strong></div>
                <div className="sd-row"><span>Client</span><strong>{bookingForm.name}</strong></div>
              </div>
              <button className="btn btn-ghost" onClick={() => { setBookingStep(1); setView('explore'); }}>Retour Explorer</button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function Steps({ step }) {
  return (
    <div className="steps-bar">
      {[1, 2, 3, 4].map((n) => <React.Fragment key={n}><div className={`stp ${step === n ? 'active' : ''} ${step > n ? 'done' : ''}`}><div className="stp-n">{n}</div><span className="stp-lbl">{['Services', 'Date & heure', 'Vos infos', 'Confirmation'][n - 1]}</span></div>{n < 4 && <div className="stp-line" />}</React.Fragment>)}
    </div>
  );
}

function ServiceGrid({ services, picked, setPicked }) {
  function toggle(service) {
    setPicked((prev) => prev.some((s) => String(s.id) === String(service.id)) ? prev.filter((s) => String(s.id) !== String(service.id)) : prev.concat(service));
  }
  return (
    <div className="msvc-grid">
      {services.map((service) => {
        const isPicked = picked.some((s) => String(s.id) === String(service.id));
        return (
          <button key={service.id} className={`msvc-card clean-button ${isPicked ? 'picked' : ''}`} onClick={() => toggle(service)}>
            <span className="msvc-chk">✓</span>
            <span className="msvc-cat">{service.cat}</span>
            <span className="msvc-name">{service.name}</span>
            <span className="msvc-dur">⏱ {service.dur}</span>
            <span className="msvc-price">{service.price} <small>TND</small></span>
          </button>
        );
      })}
    </div>
  );
}

function Summary({ picked, date, time }) {
  if (!picked.length) return null;
  const total = picked.reduce((sum, s) => sum + Number(s.price || 0), 0);
  return (
    <div className="sel-summary">
      {picked.map((s) => <div className="sel-summary-row" key={s.id}><span>{s.name}</span><span>{s.price} TND</span></div>)}
      <div className="sel-summary-row total"><span>Total{date ? ` · ${formatDate(date)}${time ? ` ${time}` : ''}` : ''}</span><span>{total} TND</span></div>
    </div>
  );
}

function StaffSelector({ staff, selectedStaff, setSelectedStaff }) {
  return (
    <div className="staff-selector">
      <div className="staff-selector-title">Choisissez le personnel</div>
      <div className="staff-selector-sub">“Peu importe” laisse Mkass choisir un membre disponible.</div>
      <div className="staff-choice-list">
        <button className={`staff-choice ${!selectedStaff ? 'active' : ''}`} onClick={() => setSelectedStaff(null)}>Peu importe<small>Premier disponible</small></button>
        {staff.map((member) => <button key={member.id} className={`staff-choice ${String(selectedStaff?.id) === String(member.id) ? 'active' : ''}`} onClick={() => setSelectedStaff(member)}>{member.name}<small>{member.role || 'Personnel'}</small></button>)}
      </div>
    </div>
  );
}

function CalendarBox({ month, setMonth, selected, setSelected }) {
  const first = new Date(month.y, month.m, 1).getDay();
  const offset = first === 0 ? 6 : first - 1;
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const minDate = new Date(tomorrowStr() + 'T00:00:00');
  function ch(delta) {
    const d = new Date(month.y, month.m + delta, 1);
    setMonth({ y: d.getFullYear(), m: d.getMonth() });
  }
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push(<div key={`e-${i}`} className="cday emp" />);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dt = new Date(month.y, month.m, day);
    const ds = `${month.y}-${String(month.m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const off = dt < minDate || dt.getDay() === 0;
    cells.push(<button key={ds} disabled={off} className={`cday ${off ? 'off' : ''} ${selected === ds ? 'sel' : ''}`} onClick={() => setSelected(ds)}>{day}</button>);
  }
  return (
    <div className="cal-box">
      <div className="cal-hdr"><button className="cal-arr" onClick={() => ch(-1)}>‹</button><span className="cal-month">{MONTHS[month.m]} {month.y}</span><button className="cal-arr" onClick={() => ch(1)}>›</button></div>
      <div className="cal-wds">{['Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa', 'Di'].map((d) => <div className="cal-wd" key={d}>{d}</div>)}</div>
      <div className="cal-days">{cells}</div>
    </div>
  );
}

function MyBookingsPage({ phone, setPhone, bookings, loadMyBookings, salons, openReview }) {
  const normalized = Array.isArray(bookings) ? bookings : [];
  const upcoming = normalized.filter((b) => !['done', 'cancelled', 'no_show'].includes(b.status));
  const history = normalized.filter((b) => ['done', 'cancelled', 'no_show'].includes(b.status));
  return (
    <main className="view active" id="view-my-bookings">
      <div className="my-bookings-wrap">
        <div className="my-bookings-hero">
          <div className="my-bookings-title">Mes réservations</div>
          <div className="my-bookings-sub">Entrez votre numéro de téléphone pour retrouver vos rendez-vous.</div>
          <div className="my-bookings-form">
            <input className="f-input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+216 XX XXX XXX" />
            <button className="btn btn-lime" onClick={loadMyBookings}>Voir mes réservations</button>
          </div>
        </div>
        <div>
          {bookings === 'loading' && <div className="booking-empty">Chargement de vos réservations...</div>}
          {bookings === null && <div className="booking-empty">Aucune recherche pour le moment.</div>}
          {Array.isArray(bookings) && !bookings.length && <div className="booking-empty">Aucune réservation trouvée pour ce numéro.</div>}
          {!!upcoming.length && <BookingSection title="À venir" items={upcoming} salons={salons} openReview={openReview} />}
          {!!history.length && <BookingSection title="Historique" items={history} salons={salons} openReview={openReview} />}
        </div>
      </div>
    </main>
  );
}

function BookingSection({ title, items, salons, openReview }) {
  return (
    <section>
      <div className="section-label">{title}</div>
      {items.map((b) => {
        const salon = salons.find((s) => s.id === b.salonId);
        return (
          <div className="booking-card" key={b.id}>
            <div className="booking-card-top"><div><div className="booking-card-title">{b.salonName || salon?.name || 'Salon'}</div><div className="booking-card-meta">{formatDate(b.date)} · {b.time || '--'}</div></div><span className={`badge ${statusBadgeClass(b.status)}`}>{STATUS[b.status] || b.status}</span></div>
            <div className="booking-card-row"><span>Client</span><strong>{b.client}</strong></div>
            <div className="booking-card-row"><span>Services</span><strong>{Array.isArray(b.services) ? b.services.join(', ') : b.services}</strong></div>
            <div className="booking-card-row"><span>Total</span><strong>{money(b.total)}</strong></div>
            {b.status === 'done' && <div className="booking-card-row"><span>Avis</span><button className="btn btn-lime btn-sm" onClick={() => openReview(b)}>Laisser un avis</button></div>}
          </div>
        );
      })}
    </section>
  );
}

function ReviewModal({ appt, rating, setRating, comment, setComment, close, submit }) {
  return (
    <div className="overlay" onClick={close}>
      <div className="modal review-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-handle clean-button" onClick={close} />
        <div className="sp-title">Laisser un avis</div>
        <p className="muted">Partagez votre expérience avec ce salon.</p>
        <div className="f-row"><label className="f-label">Note</label><select className="f-input" value={rating} onChange={(e) => setRating(Number(e.target.value))}><option value="5">★★★★★ — Excellent</option><option value="4">★★★★ — Très bien</option><option value="3">★★★ — Correct</option><option value="2">★★ — Moyen</option><option value="1">★ — Mauvais</option></select></div>
        <div className="f-row"><label className="f-label">Commentaire</label><textarea className="f-input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Votre avis..." rows="5" /></div>
        <button className="btn btn-lime full" onClick={submit}>Envoyer l’avis</button>
      </div>
    </div>
  );
}

function SignupPage({ plan, setPlan, payment, setPayment, showToast, setView }) {
  const [form, setForm] = useState({ name: '', username: '', address: '', type: 'salon', phone: '', password: '', mapUrl: '' });
  const plans = {
    starter: { label: 'Starter', price: '29 TND / mois', desc: 'Page salon, services, réservations en ligne, caisse simple et avis clients.' },
    pro: { label: 'Pro', price: '59 TND / mois', desc: 'Tout Starter + personnel, planning intelligent, règles, no-show, finance et commissions.' },
    premium: { label: 'Premium', price: 'Soon', desc: 'Fonctions avancées pour équipes et salons multi-employés.' },
  };
  function submit() {
    if (!form.name || !form.address || !form.password) return showToast('Remplissez les informations du salon');
    showToast('Paiement réel à connecter côté backend. Votre demande est prête.');
  }
  return (
    <main className="view active" id="view-signup">
      <section className="signup-screen">
        <div className="signup-shell">
          <div className="signup-head"><div><div className="signup-kicker">◎ Espace partenaires</div><h1 className="signup-title">Inscrivez votre salon sur Mkass</h1><p className="signup-sub">Choisissez votre formule, ajoutez les informations du salon, puis payez avec Flouci, D17 ou Click to Pay.</p></div><button className="btn btn-ghost" onClick={() => setView('dashboard')}>Déjà inscrit ? Se connecter</button></div>
          <div className="pricing-grid">
            {Object.entries(plans).map(([key, p]) => <button key={key} className={`price-card clean-button ${plan === key ? 'active' : ''} ${key === 'premium' ? 'disabled' : ''}`} onClick={() => key === 'premium' ? showToast('Premium sera bientôt disponible') : setPlan(key)}><span className="plan-badge">{key === 'starter' ? 'Pour commencer' : key === 'pro' ? 'Le plus choisi' : 'Bientôt'}</span><span className="plan-name">{p.label}</span><span className="plan-price">{p.price.split(' ')[0]} <small>{p.price.split(' ').slice(1).join(' ')}</small></span><span className="plan-desc">{p.desc}</span><ul className="plan-list"><li>Réservations en ligne</li><li>Interface mobile gérant</li><li>{key === 'pro' ? 'Finance, personnel et règles' : 'Services et rendez-vous'}</li></ul></button>)}
          </div>
          <div className="signup-panel">
            <div className="signup-card"><h3>Informations du salon</h3><div className="form-row-2"><Input label="Nom du salon" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Ex: Barber One" /><Input label="Nom d'utilisateur" value={form.username} onChange={(v) => setForm({ ...form, username: v })} placeholder="ex: barber-one" /></div><Input label="Adresse" value={form.address} onChange={(v) => setForm({ ...form, address: v })} placeholder="Rue, quartier, ville" /><div className="form-row-2"><div className="f-row"><label className="f-label">Type</label><select className="f-input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="salon">Salon femme</option><option value="barbershop">Barbershop</option><option value="mixte">Mixte</option><option value="enfant">Enfants</option></select></div><Input label="Téléphone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="+216 XX XXX XXX" /></div><div className="form-row-2"><Input label="Mot de passe" type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} placeholder="Minimum 4 caractères" /><Input label="Lien Google Maps" value={form.mapUrl} onChange={(v) => setForm({ ...form, mapUrl: v })} placeholder="https://maps.app.goo.gl/..." /></div></div>
            <div className="pay-card"><h3>Paiement</h3><div className="total-display"><span>Formule choisie</span><strong>{plans[plan].label} — {plans[plan].price}</strong></div><div className="pay-methods">{['flouci', 'd17', 'clicktopay'].map((p) => <button key={p} className={`pay-method clean-button ${payment === p ? 'active' : ''}`} onClick={() => setPayment(p)}><span>{p === 'flouci' ? 'Flouci' : p === 'd17' ? 'D17' : 'Click to Pay'}<small>Paiement sécurisé</small></span><span className="pay-dot" /></button>)}</div><button className="btn btn-lime full" onClick={submit}>Continuer vers le paiement →</button><p className="signup-note">Les APIs de paiement doivent être connectées côté backend avant publication.</p></div>
          </div>
        </div>
      </section>
    </main>
  );
}

function DashboardPage(props) {
  const { auth, currentSalon, isAdmin, hasPro, dashTab, setDashTab, rawSetDashTab, tryLogin, logout, setView } = props;
  const [login, setLogin] = useState({ username: '', password: '' });
  if (!auth.token) {
    return (
      <main className="view active" id="view-dashboard">
        <div className="login-screen">
          <div className="login-card">
            <div className="login-logo"><LogoMark /><span className="logo-text mkass-word">Mkass</span></div>
            <h2>Espace Gérant</h2><p>Connectez-vous avec vos identifiants</p>
            <Input label="Nom d'utilisateur" value={login.username} onChange={(v) => setLogin({ ...login, username: v })} placeholder="ex: salon-nour" onEnter={() => tryLogin(login.username, login.password)} />
            <Input label="Mot de passe" type="password" value={login.password} onChange={(v) => setLogin({ ...login, password: v })} placeholder="••••••••" onEnter={() => tryLogin(login.username, login.password)} />
            <button className="btn btn-lime full" onClick={() => tryLogin(login.username, login.password)}>Se connecter →</button>
            <div className="signup-login-link">Nouveau gérant ? <button onClick={() => setView('signup')}>S'inscrire et choisir un tarif</button></div>
            <div className="demo-box"><strong>Comptes démo :</strong><br />salon-nour / <b>1234</b><br />barber-one / <b>5678</b></div>
          </div>
        </div>
      </main>
    );
  }
  const navItems = [
    ['today', "Aujourd'hui"], ['all', 'Tous les RDV'], ['walkin', 'Caisse / Walk-in'], ['balance', 'Balance totale'], ['finance', 'Finance Pro', true], ['services', 'Mes services'], ['staff', 'Personnel', true], ['rules', 'Règles', true], ['settings', 'Paramètres'], ...(isAdmin ? [['admin', 'Admin']] : []),
  ];
  return (
    <main className="view active" id="view-dashboard">
      <div className="dash-grid">
        <aside className="sidebar"><div className="sb-lbl">Mon salon</div>{navItems.map(([key, label, pro]) => <button key={key} className={`sb-btn ${dashTab === key ? 'active' : ''} ${pro && !hasPro ? 'locked' : ''}`} onClick={() => setDashTab(key)}>{label}{key === 'today' && <span className="sb-badge">{props.appointments.filter((a) => a.salonId === auth.salonId && a.date === todayStr()).length}</span>}{pro && !hasPro && <span className="lock-pill">Pro</span>}</button>)}<div className="sidebar-bottom"><div id="sb-salon-lbl">{isAdmin ? '🔑 Admin' : `${currentSalon?.icon || '✂️'} ${currentSalon?.name || auth.salonName}`}</div><button className="sb-btn" onClick={logout}>Déconnexion</button></div></aside>
        <section className="dash-main">
          {dashTab === 'salonMenu' && <SalonHub setDashTab={setDashTab} hasPro={hasPro} logout={logout} />}
          {dashTab === 'today' && <TodayTab {...props} />}
          {dashTab === 'all' && <AllAppointmentsTab {...props} />}
          {dashTab === 'walkin' && <WalkinTab {...props} />}
          {dashTab === 'balance' && <BalanceTab {...props} />}
          {dashTab === 'finance' && <ProGate hasPro={hasPro}><FinanceTab {...props} /></ProGate>}
          {dashTab === 'services' && <ServicesTab {...props} />}
          {dashTab === 'staff' && <ProGate hasPro={hasPro}><StaffTab {...props} /></ProGate>}
          {dashTab === 'rules' && <ProGate hasPro={hasPro}><RulesTab {...props} /></ProGate>}
          {dashTab === 'settings' && <SettingsTab {...props} />}
          {dashTab === 'admin' && isAdmin && <AdminTab {...props} />}
        </section>
      </div>
    </main>
  );
}

function SalonHub({ setDashTab, hasPro, logout }) {
  const cards = [
    ['today', "Aujourd'hui", 'Planning du jour, confirmations et actions rapides.'], ['all', 'Tous les RDV', 'Consultez et gérez toutes les réservations.'], ['walkin', 'Caisse / Walk-in', 'Ajoutez un client venu sans réservation et encaissez.'], ['balance', 'Balance totale', "Suivez les recettes et l’historique des paiements."], ['finance', 'Finance Pro', 'Dépenses, bénéfice net et commissions staff.', true], ['services', 'Mes services', 'Ajoutez, modifiez ou supprimez les prestations visibles.'], ['staff', 'Personnel', 'Employés, services, commissions et horaires.', true], ['rules', 'Règles', 'No-show, clients bloqués et fidélité.', true], ['settings', 'Paramètres', 'Nom, adresse, Google Maps, coordonnées et horaires.'],
  ];
  return <div className="mobile-salon-menu"><div className="section-label">Espace gérant</div><div className="dash-title">Mon salon</div><div className="dash-sub">Choisissez une rubrique. Le bouton Salon revient toujours à ce menu.</div><div className="hub-grid">{cards.map(([key, title, desc, pro]) => <button className={`hub-card clean-button ${pro && !hasPro ? 'locked' : ''}`} key={key} onClick={() => setDashTab(key)}>{pro && <span className="pro-badge">Pro</span>}<strong>{title}</strong><span>{desc}</span><em>›</em></button>)}<button className="hub-card danger clean-button" onClick={logout}><strong>Déconnexion</strong><span>Quitter l’espace gérant.</span><em>↩</em></button></div></div>;
}

function ProGate({ hasPro, children }) {
  if (hasPro) return children;
  return <div className="pro-lock-screen"><div className="pro-badge">Pro</div><h2>Fonction disponible avec le pack Pro</h2><p>Cette rubrique est visible pour montrer la valeur, mais elle est bloquée pour les salons Starter.</p></div>;
}

function TodayTab({ auth, currentSalon, appointments, updateStatus, setView, rawSetDashTab, logout }) {
  const today = todayStr();
  const rows = appointments.filter((a) => a.salonId === auth.salonId && a.date === today);
  const revenue = rows.filter((a) => a.status === 'done').reduce((sum, a) => sum + Number(a.total || 0), 0);
  return <><div className="dash-hdr"><div><div className="dash-title">Bonjour, {currentSalon?.name || 'Gérant'} 👋</div><div className="dash-sub">{new Date().toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div></div><div className="dash-actions"><button className="btn btn-ghost btn-sm mkass-mobile-logout" onClick={logout}>Déconnexion</button><button className="btn btn-ghost btn-sm" onClick={() => rawSetDashTab('walkin')}>+ Walk-in</button><button className="btn btn-lime btn-sm" onClick={() => setView('booking')}>+ RDV en ligne</button></div></div><div className="stats-row"><Stat label="RDV aujourd'hui" value={rows.length} sub={`${rows.filter((a) => a.status === 'confirmed').length} confirmés`} lime /><Stat label="En attente" value={rows.filter((a) => a.status === 'pending').length} sub="à confirmer" warn /><Stat label="Recettes du jour" value={revenue} sub="TND encaissés" /><Stat label="Walk-ins" value={rows.filter((a) => a.type === 'walkin').length} sub="clients sans RDV" info /></div><AppointmentTable rows={rows} showDate={false} updateStatus={updateStatus} empty="Aucun RDV aujourd'hui" /></>;
}

function AllAppointmentsTab({ auth, appointments, updateStatus }) {
  const [filter, setFilter] = useState('all');
  const rows = appointments.filter((a) => a.salonId === auth.salonId && (filter === 'all' || a.status === filter));
  return <><div className="dash-hdr"><div className="dash-title">Tous les rendez-vous</div><div className="ftabs">{[['all', 'Tous'], ['confirmed', 'Confirmés'], ['pending', 'En attente'], ['done', 'Terminés']].map(([key, label]) => <button key={key} className={`ftab ${filter === key ? 'active' : ''}`} onClick={() => setFilter(key)}>{label}</button>)}</div></div><AppointmentTable rows={rows} showDate updateStatus={updateStatus} empty="Aucun résultat" /></>;
}

function AppointmentTable({ rows, showDate, updateStatus, empty }) {
  return <div className="t-card"><table><thead><tr><th>Client</th><th>Services</th>{showDate && <th>Date</th>}<th>Heure</th><th>Total</th><th>Statut</th><th>Actions</th></tr></thead><tbody>{rows.length ? rows.map((a, idx) => <tr key={a.id}><td><div className="av-cell"><div className="av" style={{ background: AVATAR_COLORS[idx % AVATAR_COLORS.length] }}>{initials(a.client)}</div><div><div className="cl-name">{a.client}{a.type === 'walkin' && <span className="badge badge-done mini">Walk-in</span>}</div><div className="cl-ph">{a.phone}</div></div></div></td><td>{Array.isArray(a.services) ? a.services.join(', ') : a.services}</td>{showDate && <td>{formatDate(a.date)}</td>}<td>{a.time || '—'}</td><td><strong>{money(a.total)}</strong></td><td><span className={`badge ${statusBadgeClass(a.status)}`}>{STATUS[a.status] || a.status}</span></td><td className="row-actions">{a.status === 'pending' && <button className="ab ok" onClick={() => updateStatus(a, 'confirmed')}>✓</button>}{!['done', 'cancelled', 'no_show'].includes(a.status) && <button className="ab ok" onClick={() => updateStatus(a, 'done')}>Terminé</button>}{!['cancelled', 'done', 'no_show'].includes(a.status) && <button className="ab bad" onClick={() => updateStatus(a, 'no_show')}>No-show</button>}{!['cancelled', 'done'].includes(a.status) && <button className="ab bad" onClick={() => updateStatus(a, 'cancelled')}>✗</button>}</td></tr>) : <tr className="empty-row"><td colSpan={showDate ? 7 : 6}>{empty}</td></tr>}</tbody></table></div>;
}

function Stat({ label, value, sub, lime, warn, info }) {
  return <div className="stat-c"><div className="stat-lbl">{label}</div><div className={`stat-val ${lime ? 'lime' : ''} ${warn ? 'warn' : ''} ${info ? 'info' : ''}`}>{value}</div><div className="stat-sub">{sub}</div></div>;
}

function WalkinTab({ auth, servicesBySalon, appointments, addWalkin }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState([]);
  const [payMode, setPayMode] = useState('cash');
  const services = servicesBySalon[auth.salonId] || [];
  const total = picked.reduce((sum, s) => sum + Number(s.price || 0), 0);
  const todayRows = appointments.filter((a) => a.salonId === auth.salonId && a.date === todayStr());
  async function submit() { await addWalkin({ name, picked, payMode }); setName(''); setPicked([]); }
  return <><div className="dash-hdr"><div><div className="dash-title">Caisse / Walk-in</div><div className="dash-sub">Enregistrez un client venu sans réservation</div></div></div><div className="walkin-panel"><h3>Nouveau client walk-in</h3><Input label="Nom client (optionnel)" value={name} onChange={setName} placeholder="Nom ou anonyme" /><div className="f-row"><label className="f-label">Services effectués</label><div className="walkin-svc-check">{services.map((s) => <button key={s.id} className={`wsc clean-button ${picked.some((p) => String(p.id) === String(s.id)) ? 'picked' : ''}`} onClick={() => setPicked((prev) => prev.some((p) => String(p.id) === String(s.id)) ? prev.filter((p) => String(p.id) !== String(s.id)) : prev.concat(s))}>{s.name} — {s.price} TND</button>)}</div></div><div className="total-display"><span>Total</span><strong>{money(total)}</strong></div><div className="pay-types">{[['cash', '💵 Espèces'], ['card', '💳 Carte'], ['transfer', '📱 Virement']].map(([key, label]) => <button key={key} className={`pt ${payMode === key ? 'active' : ''}`} onClick={() => setPayMode(key)}>{label}</button>)}</div><button className="btn btn-lime full" onClick={submit}>Enregistrer le paiement ✓</button></div><AppointmentTable rows={todayRows} showDate={false} updateStatus={() => {}} empty="Aucun paiement aujourd'hui" /></>;
}

function BalanceTab({ auth, appointments }) {
  const done = appointments.filter((a) => a.salonId === auth.salonId && a.status === 'done');
  const total = done.reduce((sum, a) => sum + Number(a.total || 0), 0);
  const today = done.filter((a) => a.date === todayStr()).reduce((sum, a) => sum + Number(a.total || 0), 0);
  return <><div className="dash-hdr"><div className="dash-title">Balance totale</div></div><div className="balance-header"><div><div className="balance-title">Balance totale (encaissée)</div><div className="balance-amount">{money(total)}</div><div className="balance-sub">Dont {money(today)} aujourd'hui</div></div><div className="balance-side"><div className="balance-title">Transactions</div><div className="balance-amount small">{done.length}</div></div></div><div className="t-card"><div className="t-hdr"><h3>Historique des recettes</h3></div><div>{done.length ? done.slice().reverse().map((a) => <div className="hist-item" key={a.id}><div className="hist-left"><span className="hist-dot" /><div><div className="hist-label">{a.client}</div><div className="hist-meta">{formatDate(a.date)} · {a.time} · {a.type === 'walkin' ? 'Walk-in' : 'Réservation'}</div></div></div><div className="hist-amount positive">+{money(a.total)}</div></div>) : <div className="empty-block">Aucune transaction</div>}</div></div></>;
}

function FinanceTab({ auth, appointments, staff, expenses, addExpense, financePeriod, setFinancePeriod }) {
  const [expenseForm, setExpenseForm] = useState({ type: 'Factures', subcategory: 'STEG', amount: '', date: todayStr(), description: '' });
  const rows = appointments.filter((a) => a.salonId === auth.salonId && a.status === 'done' && inPeriod(a.date, financePeriod));
  const periodExpenses = expenses.filter((e) => inPeriod(e.date, financePeriod));
  const revenue = rows.reduce((sum, a) => sum + Number(a.total || 0), 0);
  const expenseTotal = periodExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  const staffStats = staff.map((member) => {
    const mine = rows.filter((a) => String(a.staffId) === String(member.id) || a.staffName === member.name);
    const ca = mine.reduce((sum, a) => sum + Number(a.total || 0), 0);
    const commission = ca * Number(member.commissionRate || 0);
    return { member, count: mine.length, ca, commission, net: ca - commission };
  }).filter((r) => r.count || r.ca);
  const commissions = staffStats.reduce((sum, r) => sum + r.commission, 0);
  const profit = revenue - expenseTotal - commissions;
  const categories = Object.keys(EXPENSE_SUBTYPES).map((cat) => ({ cat, amount: periodExpenses.filter((e) => e.type === cat).reduce((s, e) => s + Number(e.amount || 0), 0) })).filter((x) => x.amount > 0);
  function submit() {
    addExpense(expenseForm);
    setExpenseForm({ type: 'Factures', subcategory: 'STEG', amount: '', date: todayStr(), description: '' });
  }
  return <div className="finance-pro"><div className="finance-top"><div><div className="finance-title">Finance Pro</div><div className="finance-sub">Chiffre d'affaires, dépenses, bénéfice net et performance par employé.</div></div><div className="finance-period">{[['month', 'Ce mois'], ['week', 'Semaine'], ['today', "Aujourd'hui"], ['all', 'Tout']].map(([key, label]) => <button key={key} className={financePeriod === key ? 'active' : ''} onClick={() => setFinancePeriod(key)}>{label}</button>)}</div></div><div className="finance-kpis"><FinanceCard label="Chiffre d'affaires" value={money(revenue)} note="RDV terminés + walk-ins" green /><FinanceCard label="Dépenses" value={money(expenseTotal)} note="Factures, stock, équipement" /><FinanceCard label="Bénéfice net" value={money(profit)} note={`Marge ${revenue ? Math.round((profit / revenue) * 100) : 0}%`} green /><FinanceCard label="Commissions staff" value={money(commissions)} note="Selon taux par employé" /></div><div className="finance-grid-2"><div className="finance-card"><div className="finance-section-title">Chiffre d'affaires par employé</div><div className="finance-section-sub">Classement selon les rendez-vous terminés.</div><div className="finance-table-wrap"><table className="finance-table"><thead><tr><th>Employé</th><th>RDV</th><th>CA généré</th><th>Commission</th><th>Net salon</th></tr></thead><tbody>{staffStats.length ? staffStats.map((r) => <tr key={r.member.id}><td>{r.member.name}</td><td>{r.count}</td><td className="finance-money">{money(r.ca)}</td><td className="finance-money">{money(r.commission)}</td><td className="finance-money finance-positive">{money(r.net)}</td></tr>) : <tr><td colSpan="5" className="finance-muted">Aucune donnée staff.</td></tr>}</tbody></table></div></div><div className="finance-card"><div className="finance-section-title">Répartition des dépenses</div><div className="finance-section-sub">Factures, stock, équipement, loyer, salaires, marketing...</div><div className="finance-bars">{categories.length ? categories.map((c) => <div className="finance-bar-row" key={c.cat}><span>{c.cat}</span><div className="finance-bar"><span style={{ width: `${Math.max(8, (c.amount / Math.max(expenseTotal, 1)) * 100)}%` }} /></div><strong>{money(c.amount)}</strong></div>) : <div className="finance-muted">Aucune dépense.</div>}</div></div></div><div className="finance-grid-2"><div className="finance-card"><div className="finance-section-title">Ajouter une dépense</div><div className="finance-section-sub">Ex: STEG, SONEDE, internet, shampoing, tondeuse...</div><div className="finance-form"><div className="finance-form-row"><div className="f-row"><label className="f-label">Type</label><select className="f-input" value={expenseForm.type} onChange={(e) => setExpenseForm({ ...expenseForm, type: e.target.value, subcategory: EXPENSE_SUBTYPES[e.target.value][0] })}>{Object.keys(EXPENSE_SUBTYPES).map((k) => <option key={k}>{k}</option>)}</select></div><div className="f-row"><label className="f-label">Sous-catégorie</label><select className="f-input" value={expenseForm.subcategory} onChange={(e) => setExpenseForm({ ...expenseForm, subcategory: e.target.value })}>{EXPENSE_SUBTYPES[expenseForm.type].map((s) => <option key={s}>{s}</option>)}</select></div></div><div className="finance-form-row"><Input label="Montant (TND)" type="number" value={expenseForm.amount} onChange={(v) => setExpenseForm({ ...expenseForm, amount: v })} placeholder="Ex: 85" /><Input label="Date" type="date" value={expenseForm.date} onChange={(v) => setExpenseForm({ ...expenseForm, date: v })} /></div><Input label="Description" value={expenseForm.description} onChange={(v) => setExpenseForm({ ...expenseForm, description: v })} placeholder="Ex: Facture STEG Avril" /><button className="btn btn-lime full" onClick={submit}>Ajouter la dépense</button></div></div><div className="finance-card"><div className="finance-section-title">Dernières dépenses</div><div className="finance-expenses-list">{expenses.length ? expenses.slice(0, 8).map((e) => <div className="finance-expense-item" key={e.id}><div><strong>{e.description || e.subcategory}</strong><small>{formatDate(e.date)} · {e.type} · {e.subcategory}</small></div><span className="finance-money">-{money(e.amount)}</span></div>) : <div className="finance-muted">Aucune dépense ajoutée.</div>}</div></div></div></div>;
}

function FinanceCard({ label, value, note, green }) {
  return <div className="finance-card"><div className="finance-kpi-label">{label}</div><div className={`finance-kpi-value ${green ? 'green' : ''}`}>{value}</div><div className="finance-kpi-note">{note}</div></div>;
}

function inPeriod(date, period) {
  if (period === 'all') return true;
  if (!date) return false;
  const d = new Date(String(date).slice(0, 10) + 'T12:00:00');
  const now = new Date();
  if (period === 'today') return d.toDateString() === now.toDateString();
  if (period === 'week') return (now - d) <= 7 * 86400000;
  if (period === 'month') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  return true;
}

function ServicesTab({ auth, servicesBySalon, addService, deleteService }) {
  const [form, setForm] = useState({ cat: 'Coupe', name: '', dur: '', price: '' });
  const services = servicesBySalon[auth.salonId] || [];
  async function submit() {
    const ok = await addService(form);
    if (ok) setForm({ cat: 'Coupe', name: '', dur: '', price: '' });
  }
  return <><div className="dash-hdr"><div><div className="dash-title">Mes services & tarifs</div><div className="dash-sub">Gérez les services proposés dans votre salon</div></div></div><div className="svc-manage-grid">{services.map((s) => <div className="svc-manage-card" key={s.id}><div className="smc-cat">{s.cat}</div><div className="smc-name">{s.name}</div><div className="smc-dur">⏱ {s.dur}</div><div className="smc-price">{s.price} TND</div><div className="smc-actions"><button className="btn btn-danger btn-sm" onClick={() => deleteService(s.id)}>Supprimer</button></div></div>)}</div><div className="add-svc-form"><h3>+ Ajouter un service</h3><div className="f-row"><label className="f-label">Catégorie</label><select className="f-input" value={form.cat} onChange={(e) => setForm({ ...form, cat: e.target.value })}>{['Coupe', 'Couleur', 'Soin', 'Barbe', 'Ongles', 'Épilation', 'Formule', 'Autre'].map((x) => <option key={x}>{x}</option>)}</select></div><div className="form-row-2"><Input label="Nom du service" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Ex: Coupe dégradée" /><Input label="Durée" value={form.dur} onChange={(v) => setForm({ ...form, dur: v })} placeholder="Ex: 30 min" /></div><Input label="Prix (TND)" type="number" value={form.price} onChange={(v) => setForm({ ...form, price: v })} placeholder="Ex: 25" /><button className="btn btn-lime" onClick={submit}>Ajouter ce service</button></div></>;
}

function StaffTab({ auth, servicesBySalon, staff, saveStaff }) {
  const services = servicesBySalon[auth.salonId] || [];
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(blankStaffForm());
  function edit(member) { setSelected(member.id); setForm({ ...blankStaffForm(), ...member, commissionRate: Math.round(Number(member.commissionRate || 0) * 100), serviceIds: member.serviceIds || [], hours: member.hours || defaultHours }); }
  async function submit() { const ok = await saveStaff({ ...form, id: selected, commissionRate: Number(form.commissionRate || 0) / 100, commission_rate: Number(form.commissionRate || 0) / 100 }); if (ok) { setSelected(null); setForm(blankStaffForm()); } }
  return <div className="staff-pro"><div className="staff-head"><div><div className="staff-title">Personnel</div><div className="staff-sub">Ajoutez les employés, leurs services, commissions et horaires.</div></div><button className="btn btn-ghost" onClick={() => { setSelected(null); setForm(blankStaffForm()); }}>Nouveau</button></div><div className="staff-grid"><div className="staff-card"><h3>Équipe</h3><div className="staff-list">{staff.length ? staff.map((m) => <button key={m.id} className={`staff-item clean-button ${String(selected) === String(m.id) ? 'active' : ''}`} onClick={() => edit(m)}><span className="staff-avatar">{initials(m.name)}</span><span className="staff-info"><strong>{m.name}</strong><small>{m.role || 'Personnel'} · {m.phone || 'Sans téléphone'}</small></span><span className={`staff-status ${m.active ? '' : 'off'}`}>{m.active ? 'Actif' : 'Inactif'}</span></button>) : <div className="empty-block">Aucun personnel.</div>}</div></div><div className="staff-card"><h3>{selected ? 'Modifier personnel' : 'Ajouter personnel'}</h3><div className="staff-form"><div className="staff-form-row"><Input label="Nom" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Ex: Hanène" /><Input label="Téléphone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="+216" /></div><div className="staff-form-row"><Input label="Rôle" value={form.role} onChange={(v) => setForm({ ...form, role: v })} placeholder="Coiffeur, coloriste..." /><Input label="Commission %" type="number" value={form.commissionRate} onChange={(v) => setForm({ ...form, commissionRate: v })} placeholder="Ex: 20" /></div><label className="staff-service-toggle"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Personnel actif</label><div className="f-row"><label className="f-label">Services réalisables</label><div className="staff-services-list">{services.map((svc) => <label className="staff-service-toggle" key={svc.id}><input type="checkbox" checked={form.serviceIds.map(String).includes(String(svc.id))} onChange={(e) => setForm({ ...form, serviceIds: e.target.checked ? form.serviceIds.concat(svc.id) : form.serviceIds.filter((id) => String(id) !== String(svc.id)) })} /> {svc.name}</label>)}</div></div><div className="f-row"><label className="f-label">Horaires</label><div className="staff-hours-grid">{form.hours.map((h, idx) => <div className="staff-hours-row" key={h.weekday}><label><input type="checkbox" checked={h.active} onChange={(e) => updateFormHours(form, setForm, idx, 'active', e.target.checked)} /> {weekdayLabel(h.weekday)}</label><input className="f-input" type="time" value={h.start_time} onChange={(e) => updateFormHours(form, setForm, idx, 'start_time', e.target.value)} /><input className="f-input" type="time" value={h.end_time} onChange={(e) => updateFormHours(form, setForm, idx, 'end_time', e.target.value)} /></div>)}</div></div><button className="btn btn-lime full" onClick={submit}>Sauvegarder le personnel</button></div></div></div></div>;
}

function blankStaffForm() { return { name: '', phone: '', role: '', active: true, commissionRate: '', username: '', serviceIds: [], hours: defaultHours }; }
function updateFormHours(form, setForm, idx, key, value) { const hours = form.hours.map((h, i) => i === idx ? { ...h, [key]: value } : h); setForm({ ...form, hours }); }
function weekdayLabel(d) { return ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'][Number(d)] || d; }

function RulesTab({ rules, saveRules }) {
  const [form, setForm] = useState(rules || blankRules);
  useEffect(() => setForm(rules || blankRules), [rules]);
  return <div className="rules-pro"><div className="rules-head"><div><div className="rules-title">Règles du salon</div><div className="rules-sub">Configurez anti no-show et fidélité.</div></div></div><div className="rules-grid"><div className="rules-card"><div className="rule-switch"><div><strong>Anti no-show</strong><small>Bloquer temporairement les clients qui ne viennent pas.</small></div><label className="mk-switch"><input type="checkbox" checked={form.noShowEnabled} onChange={(e) => setForm({ ...form, noShowEnabled: e.target.checked })} /><span /></label></div><div className="rules-form-row"><Input label="Bloquer après X no-shows" type="number" value={form.banAfter} onChange={(v) => setForm({ ...form, banAfter: Number(v) })} /><Input label="Fenêtre d'observation (jours)" type="number" value={form.windowDays} onChange={(v) => setForm({ ...form, windowDays: Number(v) })} /></div><Input label="Durée du blocage (jours)" type="number" value={form.banDays} onChange={(v) => setForm({ ...form, banDays: Number(v) })} /><div className="f-row"><label className="f-label">Message client</label><textarea className="f-input" rows="4" value={form.noShowMessage} onChange={(e) => setForm({ ...form, noShowMessage: e.target.value })} /></div></div><div className="rules-card"><div className="rule-switch"><div><strong>Fidélité</strong><small>Récompenser les clients après plusieurs visites terminées.</small></div><label className="mk-switch"><input type="checkbox" checked={form.loyaltyEnabled} onChange={(e) => setForm({ ...form, loyaltyEnabled: e.target.checked })} /><span /></label></div><div className="rules-form-row"><Input label="Récompense après X visites" type="number" value={form.visitsRequired} onChange={(v) => setForm({ ...form, visitsRequired: Number(v) })} /><Input label="Validité récompense (jours)" type="number" value={form.rewardValidityDays} onChange={(v) => setForm({ ...form, rewardValidityDays: Number(v) })} /></div><div className="f-row"><label className="f-label">Type de récompense</label><select className="f-input" value={form.rewardType} onChange={(e) => setForm({ ...form, rewardType: e.target.value })}><option value="free_service">Service gratuit</option><option value="discount_percent">Remise %</option><option value="discount_fixed">Remise fixe</option><option value="cheapest_service_free">Service le moins cher gratuit</option></select></div></div></div><button className="btn btn-lime" onClick={() => saveRules(form)}>Sauvegarder les règles</button></div>;
}

function SettingsTab({ currentSalon, saveSettings }) {
  const [form, setForm] = useState(() => salonToSettings(currentSalon));
  const [buttonState, setButtonState] = useState('idle');
  useEffect(() => setForm(salonToSettings(currentSalon)), [currentSalon?.id]);
  if (!currentSalon) return <div className="empty-block">Salon introuvable.</div>;
  function fillCoordsFromMapUrl(value) {
    const coords = mkassExtractCoordsFromMapUrl(value);
    if (coords) setForm((prev) => ({ ...prev, mapUrl: value, latitude: coords.lat, longitude: coords.lng }));
    else setForm((prev) => ({ ...prev, mapUrl: value }));
  }
  function upload(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => setForm((prev) => ({ ...prev, coverImg: e.target.result }));
    reader.readAsDataURL(file);
  }
  const btnText = buttonState === 'saving' ? 'Sauvegarde...' : buttonState === 'saved' ? '✓ Sauvegardé' : buttonState === 'error' ? 'Erreur - réessayer' : 'Sauvegarder les paramètres';
  return <><div className="dash-hdr"><div className="dash-title">Paramètres du salon</div></div><div className="settings-form"><div className="f-row"><label className="f-label">Photo de couverture</label><label className="cover-upload">{form.coverImg ? <img src={form.coverImg} alt="" /> : <span className="cover-upload-txt"><span>🖼️</span><p>Cliquez pour importer<br />une photo de votre salon</p></span>}<input type="file" accept="image/*" onChange={(e) => upload(e.target.files?.[0])} /></label></div><Input label="Nom du salon" value={form.name} onChange={(v) => setForm({ ...form, name: v })} /><Input label="Adresse" value={form.address} onChange={(v) => setForm({ ...form, address: v })} /><Input label="Lien Google Maps / Itinéraire" value={form.mapUrl} onChange={fillCoordsFromMapUrl} placeholder="Collez le lien Google Maps du salon" help="Ce lien sera utilisé pour ouvrir l’itinéraire. Si le lien ne contient pas les coordonnées, remplissez Latitude et Longitude." /><div className="form-row-2"><Input label="Latitude" value={form.latitude} onChange={(v) => setForm({ ...form, latitude: v })} placeholder="Ex: 36.849722" /><Input label="Longitude" value={form.longitude} onChange={(v) => setForm({ ...form, longitude: v })} placeholder="Ex: 10.259639" /></div><div className="help-text">Exemple accepté : 36°50'59.0&quot;N 10°15'34.7&quot;E → Latitude 36.849722, Longitude 10.259639.</div><div className="f-row"><label className="f-label">Statut</label><select className="f-input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}><option value="open">Ouvert</option><option value="busy">Très demandé</option><option value="closed">Fermé</option></select></div><Input label="Nouveau mot de passe" type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} placeholder="Laisser vide = pas de changement" /><button className="btn btn-lime" disabled={buttonState === 'saving'} onClick={() => saveSettings(form, setButtonState)}>{btnText}</button></div></>;
}

function salonToSettings(salon) {
  return { name: salon?.name || '', address: salon?.address || '', mapUrl: salon?.mapUrl || '', latitude: salon?.latitude || '', longitude: salon?.longitude || '', status: salon?.status || 'open', coverImg: salon?.coverImg || '', password: '' };
}

function AdminTab({ salons, appointments, createAdminSalon, deleteAdminSalon }) {
  const [form, setForm] = useState({ name: '', username: '', address: '', mapUrl: '', icon: '✂️', type: 'salon', password: '' });
  async function submit() { const ok = await createAdminSalon(form); if (ok) setForm({ name: '', username: '', address: '', mapUrl: '', icon: '✂️', type: 'salon', password: '' }); }
  return <><div className="dash-hdr"><div className="dash-title">Gestion des gérants</div></div><div className="admin-notice">🔑 Vous êtes connecté en tant qu'administrateur Mkass.</div><div className="new-salon-form"><h3>Ajouter un nouveau salon</h3><Input label="Nom du salon" value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="Ex: Studio Zina" /><Input label="Nom d'utilisateur" value={form.username} onChange={(v) => setForm({ ...form, username: v })} placeholder="studio-zina" /><Input label="Adresse" value={form.address} onChange={(v) => setForm({ ...form, address: v })} placeholder="Rue, quartier, ville" /><Input label="Lien Google Maps" value={form.mapUrl} onChange={(v) => setForm({ ...form, mapUrl: v })} placeholder="https://maps.app.goo.gl/..." /><div className="form-row-2"><Input label="Emoji / icône" value={form.icon} onChange={(v) => setForm({ ...form, icon: v })} /><div className="f-row"><label className="f-label">Type</label><select className="f-input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="salon">Salon femme</option><option value="barbershop">Barbershop</option><option value="mixte">Mixte</option><option value="enfant">Enfants</option></select></div></div><Input label="Mot de passe" value={form.password} onChange={(v) => setForm({ ...form, password: v })} /><button className="btn btn-lime" onClick={submit}>Créer ce salon →</button></div><div className="t-card mt"><table><thead><tr><th>Salon</th><th>Type</th><th>Adresse</th><th>Statut</th><th>RDV total</th><th>Actions</th></tr></thead><tbody>{salons.map((s) => <tr key={s.id}><td><div className="av-cell"><span>{s.icon}</span><span className="cl-name">{s.name}</span></div></td><td>{TYPE_LABELS[s.type] || s.type}</td><td>{s.address}</td><td><span className={`badge ${s.status === 'open' ? 'badge-confirmed' : 'badge-pending'}`}>{s.status}</span></td><td>{appointments.filter((a) => a.salonId === s.id).length}</td><td><button className="ab bad" onClick={() => deleteAdminSalon(s.id)}>Supprimer</button></td></tr>)}</tbody></table></div></>;
}

function Input({ label, value, onChange, placeholder, type = 'text', help, onEnter }) {
  return <div className="f-row"><label className="f-label">{label}</label><input className="f-input" type={type} value={value ?? ''} placeholder={placeholder || ''} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }} />{help && <div className="help-text">{help}</div>}</div>;
}

function Footer() {
  return <footer className="mk-footer"><div className="mk-footer-inner"><div className="mk-footer-brand"><div className="footer-logo"><LogoMark /><span className="logo-text mkass-word">Mkass</span></div><p>La plateforme de réservation en ligne pour trouver les meilleurs salons et barbiers près de chez vous.<br /><small>Contact : <a href="mailto:mkass@gmail.com">mkass@gmail.com</a> · <a href="tel:+21692888695">+216 92 888 695</a></small></p></div><div className="mk-footer-grid"><div><h4>À propos de Mkass</h4><a>Aide et assistance</a><a>Blog</a><a>Plan du site</a></div><div><h4>Pour les professionnels</h4><a>Pour les partenaires</a><a>Tarifs</a><a>Aide</a></div><div><h4>Mentions légales</h4><a>Mentions légales</a><a>CGV</a><a>Politique de remboursement</a><a>Confidentialité</a><a>Cookies</a></div><div><h4>Réseaux sociaux</h4><a href="https://www.facebook.com/profile.php?id=61590437757914" target="_blank" rel="noreferrer">↗ Facebook</a><a href="https://www.instagram.com/mkassapp/" target="_blank" rel="noreferrer">↗ Instagram</a></div></div></div><div className="mk-footer-bottom"><span>◎ français (FR)</span><span>© 2026 Mkass. Tous droits réservés.</span></div></footer>;
}
