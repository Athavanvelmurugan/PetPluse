import { Capacitor } from '@capacitor/core';

export const PROD_BACKEND_URL = 'https://petpluse.onrender.com';

/**
 * Determine whether the application is running inside a native mobile wrapper
 * (Capacitor Android/iOS APK, custom scheme, or production localhost WebView).
 */
export function isNativeApp() {
  if (typeof window === 'undefined') return false;
  try {
    if (Capacitor.isNativePlatform()) return true;
  } catch (_) {}
  const protocol = window.location.protocol;
  const hostname = window.location.hostname;
  return (
    protocol === 'capacitor:' ||
    (hostname === 'localhost' && !window.location.port) ||
    (window.location.origin.includes('localhost') && import.meta.env.PROD)
  );
}

/**
 * Returns the resolved API Base URL.
 * Inside native Capacitor builds, defaults to production Render backend.
 * On web (Vercel / Vite dev), returns empty string to allow proxy rewrites.
 */
export function getApiBaseUrl() {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, '');
  }
  if (isNativeApp()) {
    return PROD_BACKEND_URL;
  }
  return '';
}

/**
 * Returns the resolved WebSocket URL.
 */
export function getWsBaseUrl() {
  if (isNativeApp()) {
    return 'wss://petpluse.onrender.com';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

// Global fetch patch to intercept relative /api/ calls and route to production backend on native platforms
if (typeof window !== 'undefined' && !window.__apiFetchPatched) {
  window.__apiFetchPatched = true;
  const originalFetch = window.fetch;

  window.fetch = async function (input, init = {}) {
    let url = input;
    const isString = typeof input === 'string';

    if (isString && input.startsWith('/api/')) {
      const baseUrl = getApiBaseUrl();
      if (baseUrl) {
        url = `${baseUrl}${input}`;
      }

      const modifiedInit = { ...init };
      if (!modifiedInit.credentials) {
        modifiedInit.credentials = 'include';
      }

      const headers = new Headers(modifiedInit.headers || {});
      if (!headers.has('Authorization')) {
        let token = localStorage.getItem('petcare_token');
        if (!token) {
          try {
            const raw = localStorage.getItem('petcare_owner_session');
            if (raw) {
              const session = JSON.parse(raw);
              token = session.token;
            }
          } catch (_) {}
        }
        if (!token) {
          token = localStorage.getItem('petcare_owner_token');
        }
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }
      }

      if (!headers.has('x-owner-id')) {
        try {
          const raw = localStorage.getItem('petcare_owner_session');
          if (raw) {
            const session = JSON.parse(raw);
            if (session.id) headers.set('x-owner-id', String(session.id));
          }
        } catch (_) {}
      }

      modifiedInit.headers = headers;
      return originalFetch.call(this, url, modifiedInit);
    }

    return originalFetch.call(this, input, init);
  };
}

