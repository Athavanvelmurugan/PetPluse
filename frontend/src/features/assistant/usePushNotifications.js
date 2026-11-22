import { useState, useEffect, useCallback } from 'react';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function usePushNotifications() {
  const [isSupported, setIsSupported] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [permission, setPermission] = useState('default');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window) {
      setIsSupported(true);
      setPermission(Notification.permission);

      navigator.serviceWorker.ready.then(async (registration) => {
        try {
          const subscription = await registration.pushManager.getSubscription();
          setIsSubscribed(Boolean(subscription));
        } catch (_) {}
      });
    }
  }, []);

  const subscribe = useCallback(async () => {
    if (!isSupported) {
      setError('Push notifications are not supported by this browser.');
      return false;
    }

    setLoading(true);
    setError(null);

    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);

      if (perm !== 'granted') {
        throw new Error('Notification permission was denied.');
      }

      // Fetch public VAPID key
      const keyRes = await fetch('/api/v1/owner-portal/assistant/push/vapid-key', {
        credentials: 'include',
      });
      const keyData = await keyRes.json();
      const vapidPublicKey = keyData?.data?.publicKey;

      if (!vapidPublicKey) {
        throw new Error('Push service configuration is currently unavailable.');
      }

      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const convertedKey = urlBase64ToUint8Array(vapidPublicKey);
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedKey,
      });

      const subJson = subscription.toJSON();

      const res = await fetch('/api/v1/owner-portal/assistant/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: subJson.keys,
        }),
      });

      const resData = await res.json();
      if (!res.ok || !resData.success) {
        throw new Error(resData.error || 'Failed to register push subscription on server.');
      }

      setIsSubscribed(true);
      return true;
    } catch (err) {
      console.warn('[usePushNotifications] Subscription failed:', err);
      setError(err.message || 'Failed to enable notifications.');
      return false;
    } finally {
      setLoading(false);
    }
  }, [isSupported]);

  const unsubscribe = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        const subJson = subscription.toJSON();
        await subscription.unsubscribe();

        await fetch('/api/v1/owner-portal/assistant/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            endpoint: subJson.endpoint,
          }),
        });
      }

      setIsSubscribed(false);
      return true;
    } catch (err) {
      console.warn('[usePushNotifications] Unsubscribe failed:', err);
      setError(err.message || 'Failed to disable notifications.');
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    isSupported,
    isSubscribed,
    permission,
    loading,
    error,
    subscribe,
    unsubscribe,
  };
}

