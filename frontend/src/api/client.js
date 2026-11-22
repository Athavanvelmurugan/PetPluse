/**
 * Reusable HTTP API Client with Credentials & Automatic Token Refresh.
 * Intercepts 401s, attempts silent token refresh, and replays requests.
 */

import { getApiBaseUrl } from './setupApi';

let isRefreshing = false;
let refreshSubscribers = [];

function onRefreshed() {
  refreshSubscribers.forEach((callback) => callback());
  refreshSubscribers = [];
}

export async function apiClient(url, options = {}) {
  const base = getApiBaseUrl();
  const resolvedUrl = url.startsWith('http') ? url : `${base}${url}`;
  const token = localStorage.getItem('petcare_token');

  const defaultHeaders = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  // If payload is FormData, do not set Content-Type header (browser sets boundary)
  if (options.body instanceof FormData) {
    delete defaultHeaders['Content-Type'];
  }

  const fetchOptions = {
    ...options,
    credentials: 'include', // Transmit and receive httpOnly cookies
    headers: defaultHeaders,
  };

  let response;
  try {
    response = await fetch(resolvedUrl, fetchOptions);
  } catch (networkErr) {
    throw new Error(`Network request failed: ${networkErr.message}`);
  }

  // Intercept 401 for silent token refresh (except for auth flow endpoints)
  if (
    response.status === 401 &&
    !url.includes('/api/v1/auth/login') &&
    !url.includes('/api/v1/auth/refresh') &&
    !url.includes('/api/v1/auth/register-clinic') &&
    !url.includes('/api/v1/auth/register/') &&
    !url.includes('/api/v1/auth/verify-') &&
    !url.includes('/api/v1/auth/resend-verification') &&
    !url.includes('/api/v1/auth/forgot-password') &&
    !url.includes('/api/v1/auth/reset-password')
  ) {
    if (!isRefreshing) {
      isRefreshing = true;
      try {
        const refreshResponse = await fetch(`${base}/api/v1/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });

        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json().catch(() => null);
          if (refreshData?.data?.token) {
            localStorage.setItem('petcare_token', refreshData.data.token);
          }
          isRefreshing = false;
          onRefreshed();
          return fetch(resolvedUrl, fetchOptions);
        } else {
          isRefreshing = false;
          // Refresh failed - session expired
          return response;
        }
      } catch (refreshErr) {
        isRefreshing = false;
        return response;
      }
    }

    // Queue request until refresh completes
    return new Promise((resolve) => {
      refreshSubscribers.push(async () => {
        resolve(await fetch(resolvedUrl, fetchOptions));
      });
    });
  }

  return response;
}

