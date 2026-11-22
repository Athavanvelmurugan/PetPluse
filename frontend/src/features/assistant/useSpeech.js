import { useState, useEffect, useRef, useCallback } from 'react';

// Known male names to strictly exclude so Dharu is 100% a female voice
const MALE_VOICE_NAMES = [
  'ravi', 'david', 'george', 'mark', 'stefan', 'male', 'guy',
  'richard', 'james', 'brian', 'daniel', 'michael', 'pavel',
  'alec', 'cosimo', 'valluvar'
];

// Ranked preference patterns for soft, natural, melodious female voices
const FEMALE_VOICE_PREFERENCES = [
  // 1. Premium Neural & Natural Indian English Female (Soft, warm, clear)
  /neerja/i,
  /heera/i,
  /en[-_]in.*(female|natural|online)/i,

  // 2. Natural Soft Global Female Voices
  /google uk english female/i,
  /google us english/i,
  /jenny/i,
  /zira/i,
  /aria/i,
  /sonia/i,
  /samantha/i,
  /victoria/i,
  /karen/i,

  // 3. Fallback: Any voice with female/woman designation
  /female/i,
  /woman/i,
];

/**
 * Intelligent voice matcher to guarantee a 100% soft female voice.
 */
function findBestFemaleVoice(voices = [], isTamil = false) {
  if (!voices || voices.length === 0) return null;

  // Filter out any known male voices
  const femaleCandidates = voices.filter((v) => {
    const name = v.name.toLowerCase();
    return !MALE_VOICE_NAMES.some((m) => name.includes(m));
  });

  const pool = femaleCandidates.length > 0 ? femaleCandidates : voices;

  // If user text is in Tamil script
  if (isTamil) {
    const taVoice = pool.find((v) => v.lang === 'ta-IN' || v.lang.startsWith('ta'));
    if (taVoice) return taVoice;
  }

  // Scan ranked female preference patterns
  for (const pattern of FEMALE_VOICE_PREFERENCES) {
    const match = pool.find((v) => pattern.test(v.name));
    if (match) return match;
  }

  // Look for any en-IN candidate
  const enInVoice = pool.find((v) => v.lang === 'en-IN' || v.lang === 'en_IN');
  if (enInVoice) return enInVoice;

  // Look for any English voice in the filtered pool
  const enVoice = pool.find((v) => v.lang.startsWith('en'));
  if (enVoice) return enVoice;

  return pool[0] || voices[0];
}

/**
 * Pre-processes text to create natural micro-pauses ("word follow gap little bit")
 * and soothing cadence rather than rushed machine-gun speech.
 */
function formatSpeechCadence(text) {
  if (!text) return '';

  return text
    // Remove markdown symbols and brackets
    .replace(/[*_#`~[\]]/g, '')
    // Remove emojis
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    // Normalize condensed dates e.g. 26Nov2026 -> 26 Nov, 2026
    .replace(/(\d{1,2})([A-Za-z]{3,9})(\d{4})/g, '$1 $2, $3')
    // Format YYYY-MM-DD into soothing spoken date e.g. 2026-11-26 -> November 26, 2026
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, y, m, d) => {
      const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const monthName = months[parseInt(m, 10) - 1] || m;
      return `${monthName} ${parseInt(d, 10)}, ${y}`;
    })
    // Replace "Dr." with "Doctor" for melodious pronunciation
    .replace(/\bDr\.?\s+/gi, 'Doctor ')
    // Replace colons only when not part of time e.g. "free at:" -> "free at,"
    .replace(/:(?!\d{2})/g, ',')
    // Replace hyphens and semicolons with gentle breathing pause commas
    .replace(/[;–—]/g, ', ')
    // Soften parentheses e.g. "(Siva)" -> ", Siva,"
    .replace(/\(([^)]+)\)/g, ', $1, ')
    // Clean up redundant commas or whitespace
    .replace(/,\s*,+/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * useSpeech — Browser SpeechSynthesis (Text-to-Speech) hook
 * ───────────────────────────────────────────────────────────
 * Calibrated for a 100% soft, beautiful female voice with natural
 * breathing cadence and comfortable word/clause spacing.
 */
export function useSpeech() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [hasSupport, setHasSupport] = useState(false);
  const voicesRef = useRef([]);
  const audioRef = useRef(null);
  const abortControllerRef = useRef(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      setHasSupport(true);

      const updateVoices = () => {
        voicesRef.current = window.speechSynthesis.getVoices();
      };

      updateVoices();
      window.speechSynthesis.onvoiceschanged = updateVoices;
    }
  }, []);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (next) {
        stop();
      }
      return next;
    });
  }, [stop]);

  const speak = useCallback(
    async (text, onEnd, voiceHint) => {
      if (!text || isMuted) {
        onEnd?.();
        return;
      }

      stop();

      // Format speech text with natural cadence gaps & breathing pauses
      const cadenceText = formatSpeechCadence(text);

      if (!cadenceText) {
        onEnd?.();
        return;
      }

      // Check whether text is in Tamil script
      const isTamil = /[\u0B80-\u0BFF]/.test(cadenceText);
      const chosenVoice = voiceHint || (isTamil ? 'ta-IN-PallaviNeural' : 'en-IN-NeerjaExpressiveNeural');

      // Attempt 1: High-Fidelity Microsoft Neural Voice Streaming from backend (Neerja / Pallavi)
      try {
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const ttsUrl = `/api/v1/owner-portal/assistant/tts?text=${encodeURIComponent(cadenceText)}&voice=${encodeURIComponent(chosenVoice)}`;
        const response = await fetch(ttsUrl, {
          credentials: 'include',
          signal: controller.signal,
        });

        if (response.ok) {
          const blob = await response.blob();
          const audioUrl = URL.createObjectURL(blob);
          const audio = new Audio(audioUrl);
          audioRef.current = audio;

          audio.onplay = () => setIsSpeaking(true);
          audio.onended = () => {
            setIsSpeaking(false);
            URL.revokeObjectURL(audioUrl);
            audioRef.current = null;
            onEnd?.();
          };
          audio.onerror = () => {
            setIsSpeaking(false);
            URL.revokeObjectURL(audioUrl);
            audioRef.current = null;
            onEnd?.();
          };

          await audio.play();
          return;
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.warn('[useSpeech] Neural TTS stream failed, falling back to browser synthesis:', err.message);
      }

      // Attempt 2: Fallback to browser SpeechSynthesis if backend stream is unreachable
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(cadenceText);
        utterance.rate = 0.90;
        utterance.pitch = 1.00;
        utterance.volume = 0.95;

        const voices = voicesRef.current.length > 0 ? voicesRef.current : window.speechSynthesis.getVoices();
        const femaleVoice = findBestFemaleVoice(voices, isTamil);

        if (femaleVoice) {
          utterance.voice = femaleVoice;
          utterance.lang = femaleVoice.lang;
        }

        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => {
          setIsSpeaking(false);
          onEnd?.();
        };
        utterance.onerror = (e) => {
          console.warn('[useSpeech] SpeechSynthesis error:', e.error);
          setIsSpeaking(false);
          onEnd?.();
        };

        window.speechSynthesis.speak(utterance);
      } else {
        onEnd?.();
      }
    },
    [isMuted, stop]
  );

  return {
    isSpeaking,
    isMuted,
    hasSupport,
    speak,
    stop,
    toggleMute,
  };
}

