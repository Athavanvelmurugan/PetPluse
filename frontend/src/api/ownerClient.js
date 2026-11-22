/**
 * Robust Client for Pet Guardian / Owner Portal API calls.
 * Automatically injects credentials, Authorization Bearer token,
 * and dev fallback headers to prevent 401 disconnections.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export async function ownerFetch(url, options = {}) {
  const resolvedUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
  let session = null;
  try {
    const raw = localStorage.getItem('petcare_owner_session');
    if (raw) session = JSON.parse(raw);
  } catch (_) {}

  const headers = {
    'Content-Type': 'application/json',
    ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
    ...(session?.id ? { 'x-owner-id': String(session.id) } : {}),
    ...options.headers,
  };

  // If payload is FormData, do not set Content-Type header
  if (options.body instanceof FormData) {
    delete headers['Content-Type'];
  }

  return fetch(resolvedUrl, {
    ...options,
    credentials: 'include',
    headers,
  });
}

