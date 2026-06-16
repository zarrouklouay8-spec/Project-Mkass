export const API_BASE = import.meta.env.VITE_API_URL || 'https://mkass-backend-test.up.railway.app/api';

export function unwrapApi(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (!payload) return [];
  if (key && Array.isArray(payload[key])) return payload[key];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.results)) return payload.results;
  if (payload.salon || payload.appointment || payload.service) return payload.salon || payload.appointment || payload.service;
  return payload;
}

export async function apiCall(method, path, body = null, token = null) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : null,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg = data?.error || data?.message || `API error ${res.status}`;
    const error = new Error(msg);
    error.status = res.status;
    error.payload = data;
    error.method = method;
    error.path = path;
    throw error;
  }

  return data;
}
