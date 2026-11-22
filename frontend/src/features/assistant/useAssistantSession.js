import { useState, useCallback, useRef, useEffect } from 'react';

export function useAssistantSession() {
  const [sessionId, setSessionId] = useState(null);
  const [state, setState] = useState('GREETING');
  const [messages, setMessages] = useState([]);
  const [chips, setChips] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [appointment, setAppointment] = useState(null);

  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  /**
   * Dispatches a conversational turn to the assistant backend.
   */
  const sendTurn = useCallback(async ({ text = null, audioBlob = null, action = null, channel = 'chat' }) => {
    setLoading(true);
    setError(null);

    // If user typed text, optimistically append to message bubble history
    if (text && !audioBlob) {
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: 'user',
          text,
          timestamp: new Date().toISOString(),
        },
      ]);
    }

    try {
      let response;

      if (audioBlob) {
        // Multipart/form-data for in-memory voice audio processing
        const formData = new FormData();
        const mime = audioBlob.type || '';
        const ext = mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
        formData.append('audio', audioBlob, `speech.${ext}`);
        if (sessionIdRef.current) formData.append('sessionId', sessionIdRef.current);
        formData.append('channel', 'voice');

        response = await fetch('/api/v1/owner-portal/assistant/turn', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        });
      } else {
        // Standard JSON payload
        response = await fetch('/api/v1/owner-portal/assistant/turn', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            channel: channel || 'chat',
            text: text || null,
            action: action || null,
          }),
        });
      }

      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Failed to communicate with Dharu assistant.');
      }

      const data = json.data;

      // Update active session metadata immediately and synchronously
      if (data.sessionId) {
        sessionIdRef.current = data.sessionId;
        setSessionId(data.sessionId);
      }
      if (data.state) setState(data.state);
      setChips(data.chips || []);

      if (data.appointment) {
        setAppointment(data.appointment);
      }

      // If voice was used, append the transcribed "I heard:" text for the user
      if (data.transcript && audioBlob) {
        setMessages((prev) => [
          ...prev,
          {
            id: `user-${Date.now()}`,
            role: 'user',
            text: data.transcript,
            isVoiceTranscript: true,
            timestamp: new Date().toISOString(),
          },
        ]);
      }

      // Append Dharu's reply to the message history
      if (data.reply) {
        setMessages((prev) => [
          ...prev,
          {
            id: `bot-${Date.now()}`,
            role: 'assistant',
            text: data.reply,
            chips: data.chips || [],
            appointment: data.appointment || null,
            timestamp: new Date().toISOString(),
          },
        ]);
      }

      return data;
    } catch (err) {
      console.error('[useAssistantSession] Error:', err);
      setError(err.message);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          isError: true,
          text: `⚠️ ${err.message || 'Something went wrong. Please try again.'}`,
          timestamp: new Date().toISOString(),
        },
      ]);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Initializes or resets the assistant session.
   */
  const restartSession = useCallback(async () => {
    if (sessionIdRef.current) {
      fetch(`/api/v1/owner-portal/assistant/session/${sessionIdRef.current}/cancel`, {
        method: 'POST',
        credentials: 'include',
      }).catch(() => {});
    }
    setSessionId(null);
    setMessages([]);
    setChips([]);
    setError(null);
    setAppointment(null);
    setState('GREETING');

    // Fetch fresh greeting from assistant
    return sendTurn({ channel: 'chat' });
  }, [sendTurn]);

  return {
    sessionId,
    state,
    messages,
    chips,
    loading,
    error,
    appointment,
    sendTurn,
    restartSession,
    resetSession: restartSession,
  };
}

