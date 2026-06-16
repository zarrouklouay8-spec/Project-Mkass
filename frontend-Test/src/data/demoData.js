import { todayStr } from '../utils.js';

export const demoSalons = [
  {
    id: 'salon-nour', username: 'salon-nour', name: 'Salon Nour', icon: '💇', type: 'salon',
    address: 'Rue de Marseille, Lafayette, Tunis', rating: 5, reviewCount: 4, status: 'open',
    tags: ['Coloration', 'Kératine', 'Mariée'], childCut: true, color: '#a78bfa', plan: 'pro',
    mapUrl: 'https://www.google.com/maps/search/?api=1&query=Rue%20de%20Marseille%2C%20Lafayette%2C%20Tunis',
    latitude: 36.8103, longitude: 10.1785,
    coverImg: 'https://images.unsplash.com/photo-1560066984-138dadb4c035?q=80&w=1200&auto=format&fit=crop',
    reviews: [
      { name: 'Sarra M.', author_name: 'Sarra M.', stars: 5, rating: 5, text: 'Service impeccable ! Ma couleur est exactement ce que je voulais.' },
      { name: 'Amira K.', author_name: 'Amira K.', stars: 5, rating: 5, text: 'Très professionnel et accueillant.' },
    ],
  },
  {
    id: 'barber-one', username: 'barber-one', name: 'Barber One', icon: '💈', type: 'barbershop',
    address: 'Avenue Habib Bourguiba, Centre-Ville', rating: 4.9, reviewCount: 5, status: 'open',
    tags: ['Barbe', 'Rasage', 'Coupe moderne'], childCut: true, color: '#34d399', plan: 'starter',
    latitude: 36.8008, longitude: 10.1800,
    coverImg: 'https://images.unsplash.com/photo-1622287162716-f311baa1a2b8?q=80&w=1200&auto=format&fit=crop',
    reviews: [
      { name: 'Khalil T.', author_name: 'Khalil T.', stars: 5, rating: 5, text: 'Le meilleur barbershop de Tunis.' },
    ],
  },
  {
    id: 'studio-bella', username: 'studio-bella', name: 'Studio Bella', icon: '🌸', type: 'mixte',
    address: 'Rue du Lac, Les Berges du Lac', rating: 4.7, reviewCount: 3, status: 'busy',
    tags: ['Soin', 'Extensions', 'Nail art'], childCut: false, color: '#f472b6', plan: 'starter',
    coverImg: 'https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f?q=80&w=1200&auto=format&fit=crop',
    reviews: [],
  },
];

export const defaultServices = [
  { id: 1, salonId: 'salon-nour', cat: 'Couleur', name: 'Balayage / Mèches', dur: '120 min', duration: 120, price: 120 },
  { id: 2, salonId: 'salon-nour', cat: 'Couleur', name: 'Coloration complète', dur: '90 min', duration: 90, price: 80 },
  { id: 3, salonId: 'salon-nour', cat: 'Couleur', name: 'Kératine', dur: '150 min', duration: 150, price: 150 },
  { id: 4, salonId: 'salon-nour', cat: 'Soin', name: 'Brushing', dur: '30 min', duration: 30, price: 25 },
  { id: 5, salonId: 'barber-one', cat: 'Coupe', name: 'Coupe homme', dur: '30 min', duration: 30, price: 20 },
  { id: 6, salonId: 'barber-one', cat: 'Barbe', name: 'Taille de barbe', dur: '20 min', duration: 20, price: 15 },
  { id: 7, salonId: 'barber-one', cat: 'Barbe', name: 'Barbe + coupe', dur: '50 min', duration: 50, price: 35 },
  { id: 8, salonId: 'studio-bella', cat: 'Ongles', name: 'Manucure', dur: '40 min', duration: 40, price: 30 },
  { id: 9, salonId: 'studio-bella', cat: 'Soin', name: 'Soin profond', dur: '45 min', duration: 45, price: 45 },
];

export function servicesBySalonFromDemo() {
  return defaultServices.reduce((acc, svc) => {
    acc[svc.salonId] = acc[svc.salonId] || [];
    acc[svc.salonId].push(svc);
    return acc;
  }, {});
}

export const demoAppointments = [
  {
    id: 'MKS-1001', salonId: 'salon-nour', client: 'Sarra Mansour', phone: '+21622345678',
    services: ['Coloration complète'], prices: [80], total: 80, date: todayStr(), time: '09:00', status: 'done', type: 'booking', payMode: 'online', staffName: 'Hanène',
  },
  {
    id: 'MKS-1002', salonId: 'salon-nour', client: 'Mariem Trabelsi', phone: '+21655789012',
    services: ['Balayage / Mèches'], prices: [120], total: 120, date: todayStr(), time: '10:30', status: 'confirmed', type: 'booking', payMode: 'online', staffName: 'Hanène',
  },
  {
    id: 'MKS-1003', salonId: 'barber-one', client: 'Khalil Trabelsi', phone: '+21627654321',
    services: ['Barbe + coupe'], prices: [35], total: 35, date: todayStr(), time: '11:00', status: 'pending', type: 'booking', payMode: 'online', staffName: 'Yassine',
  },
];
