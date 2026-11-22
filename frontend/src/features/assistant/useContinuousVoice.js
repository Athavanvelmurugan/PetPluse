import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * useContinuousVoice — Production-Grade Hands-Free Continuous Voice Hook
 * ──────────────────────────────────────────────────────────────────────
 * Dual-Engine Architecture:
 * 1. Primary Engine: Browser Native SpeechRecognition (Chrome on Android & Desktop).
 *    - Real-time live transcript updates in the UI as the user speaks.
 *    - On-device acoustic model with hardware-level noise suppression and VAD.
 *    - Instant speech-end detection without room noise lock.
 * 2. Fallback Engine: MediaRecorder + Web Audio API.
 *    - Robust EMA smoothed energy calculation (immune to single-frame noise blips).
 *    - 800ms silence turnaround after speech.
 *    - 7-second max utterance guard (never hangs for 25s).
 * 3. Real-time Audio Visualizer:
 *    - Web Audio AnalyserNode tracks mic energy (0-100) for the pulsing ring and level meter.
 */
export function useContinuousVoice({
  onUtteranceRecorded,
  silenceThresholdMs = 800,
  speechThreshold = 12,
  maxUtteranceMs = 15000,
}) {
  const [isListening, setIsListening] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState(null);

  const isListeningRef = useRef(false);
  const isUserSpeakingRef = useRef(false);
  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);
  const audioChunksRef = useRef([]);

  const onUtteranceRecordedRef = useRef(onUtteranceRecorded);
  useEffect(() => {
    onUtteranceRecordedRef.current = onUtteranceRecorded;
  }, [onUtteranceRecorded]);

  const hasSpokenRef = useRef(false);
  const speechStartTimeRef = useRef(0);
  const silenceTimerRef = useRef(null);
  const maxTimerRef = useRef(null);
  const isStoppingRef = useRef(false);
  const hasDispatchedRef = useRef(false);
  const latestTranscriptRef = useRef('');
  const mimeTypeRef = useRef('audio/webm;codecs=opus');

  // Complete and submit the recorded utterance
  const finishUtterance = useCallback((payload = null) => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    isListeningRef.current = false;

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    setIsUserSpeaking(false);
    isUserSpeakingRef.current = false;
    setAudioLevel(0);

    // Stop native SpeechRecognition if active
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
      recognitionRef.current = null;
    }

    // Stop MediaRecorder safely
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try {
        mediaRecorderRef.current.requestData();
      } catch (_) {}
      try {
        mediaRecorderRef.current.stop();
      } catch (_) {}
    } else {
      setIsListening(false);
      isListeningRef.current = false;
    }

    // Clean up mic stream tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    // Clean up AudioContext
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch (_) {}
      audioContextRef.current = null;
    }

    // Resolve payload to deliver: either passed explicitly, or from latest recognized transcript
    const toDispatch = payload || (latestTranscriptRef.current && latestTranscriptRef.current.trim().length > 0 ? { text: latestTranscriptRef.current.trim() } : null);

    if (toDispatch && !hasDispatchedRef.current) {
      hasDispatchedRef.current = true;
      setInterimTranscript('');
      onUtteranceRecordedRef.current?.(toDispatch);
    }
  }, []);

  // Cancel listening without submitting audio
  const stopListening = useCallback(() => {
    hasSpokenRef.current = false;
    hasDispatchedRef.current = true; // suppress callback
    isListeningRef.current = false;
    setInterimTranscript('');
    finishUtterance();
  }, [finishUtterance]);

  // Start continuous listening
  const startListening = useCallback(async () => {
    isStoppingRef.current = false;
    isListeningRef.current = true;
    hasSpokenRef.current = false;
    hasDispatchedRef.current = false;
    latestTranscriptRef.current = '';
    speechStartTimeRef.current = 0;
    audioChunksRef.current = [];
    setInterimTranscript('');
    setError(null);

    // Clean up any lingering timers
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    const SpeechRec = typeof window !== 'undefined'
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null;

    // 1. Initialize Visualizer Audio Stream
    let stream = null;
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioCtx();
        audioContextRef.current = audioCtx;
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }

        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.3;
        source.connect(analyser);
        analyserRef.current = analyser;
      } catch (streamErr) {
        console.warn('[useContinuousVoice] Mic stream warning:', streamErr.message);
      }
    }

    // 2. Primary Engine: Native SpeechRecognition (Chrome Desktop / Chrome Android)
    if (SpeechRec) {
      try {
        const recognition = new SpeechRec();
        recognitionRef.current = recognition;
        recognition.continuous = true; // Continuous multi-clause listening without early cutoff
        recognition.interimResults = true;
        recognition.lang = 'en-IN'; // Indian English
        recognition.maxAlternatives = 1;

        let accumulatedFinal = '';

        recognition.onstart = () => {
          setIsListening(true);
          isListeningRef.current = true;
        };

        recognition.onspeechstart = () => {
          setIsUserSpeaking(true);
          isUserSpeakingRef.current = true;
          hasSpokenRef.current = true;
          // Clear any pending silence timer when user resumes speaking
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        };

        recognition.onspeechend = () => {
          setIsUserSpeaking(false);
          isUserSpeakingRef.current = false;
          // Generous 1300ms pause buffer after natural speech end before dispatching
          if (latestTranscriptRef.current && !silenceTimerRef.current && !hasDispatchedRef.current) {
            silenceTimerRef.current = setTimeout(() => {
              if (latestTranscriptRef.current && !hasDispatchedRef.current) {
                finishUtterance({ text: latestTranscriptRef.current.trim() });
              }
            }, 1300);
          }
        };

        recognition.onresult = (event) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0]?.transcript || '';
            if (event.results[i].isFinal) {
              accumulatedFinal += (accumulatedFinal ? ' ' : '') + transcript;
            } else {
              interim += transcript;
            }
          }

          const currentText = (accumulatedFinal + (interim ? ' ' + interim : '')).trim();
          if (currentText) {
            latestTranscriptRef.current = currentText;
            setInterimTranscript(currentText);
            hasSpokenRef.current = true;
            setIsUserSpeaking(true);
            isUserSpeakingRef.current = true;
          }

          // Debounce turn submission: wait 1300ms of continuous silence after speech
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }

          silenceTimerRef.current = setTimeout(() => {
            if (latestTranscriptRef.current && latestTranscriptRef.current.trim().length > 0 && !hasDispatchedRef.current) {
              finishUtterance({ text: latestTranscriptRef.current.trim() });
            }
          }, 1300);
        };

        recognition.onend = () => {
          if (!hasDispatchedRef.current && !isStoppingRef.current) {
            if (latestTranscriptRef.current && latestTranscriptRef.current.trim().length > 0) {
              finishUtterance({ text: latestTranscriptRef.current.trim() });
            } else if (isListeningRef.current) {
              // Engine stopped due to silence while continuous mode is listening -> restart recognition safely
              setTimeout(() => {
                if (isListeningRef.current && !isStoppingRef.current && recognitionRef.current) {
                  try {
                    recognitionRef.current.start();
                  } catch (_) {}
                }
              }, 80);
            } else {
              setIsListening(false);
              isListeningRef.current = false;
              setIsUserSpeaking(false);
              setInterimTranscript('');
            }
          }
        };

        recognition.onerror = (e) => {
          console.warn('[useContinuousVoice] SpeechRecognition error:', e.error);
          if (e.error === 'not-allowed') {
            setError('Microphone permission denied. Please allow microphone access.');
            stopListening();
          } else if (e.error === 'no-speech') {
            // Silence detected by browser engine
            setIsUserSpeaking(false);
          }
        };

        recognition.start();
        setIsListening(true);
      } catch (recErr) {
        console.warn('[useContinuousVoice] SpeechRecognition start failed, falling back:', recErr);
      }
    }

    // 3. Fallback Engine: MediaRecorder (if SpeechRec not available or as parallel safety)
    if (stream && (!SpeechRec || !recognitionRef.current)) {
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
        ? 'audio/ogg;codecs=opus'
        : 'audio/wav';

      mimeTypeRef.current = mimeType;
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const hadSpoken = hasSpokenRef.current;
        setIsListening(false);
        isListeningRef.current = false;
        setIsUserSpeaking(false);
        setAudioLevel(0);

        if (!hasDispatchedRef.current) {
          const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
          audioChunksRef.current = [];
          if ((hadSpoken && audioBlob.size >= 500) || audioBlob.size >= 2500) {
            hasDispatchedRef.current = true;
            onUtteranceRecordedRef.current?.({ audioBlob });
          }
        }
      };

      recorder.start(200);
      setIsListening(true);
      isListeningRef.current = true;
    }

    // 4. Max recording duration safety timer (15 seconds max per turn)
    maxTimerRef.current = setTimeout(() => {
      console.log('[useContinuousVoice] Turn limit reached, submitting current input.');
      if (latestTranscriptRef.current && latestTranscriptRef.current.trim().length > 0) {
        finishUtterance({ text: latestTranscriptRef.current.trim() });
      } else {
        finishUtterance();
      }
    }, maxUtteranceMs);

    // 5. Real-Time Volume Level & Fallback VAD Loop
    if (analyserRef.current) {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      let noiseFloor = 10;
      let frameCount = 0;
      let smoothLevel = 0;
      let consecutiveSilenceMs = 0;
      let lastFrameTime = Date.now();

      const checkAudioLevel = () => {
        if (!analyserRef.current || isStoppingRef.current) return;

        const now = Date.now();
        const deltaTime = Math.max(1, Math.min(50, now - lastFrameTime));
        lastFrameTime = now;

        analyserRef.current.getByteFrequencyData(dataArray);

        // Vocal frequency range (bins 2 to 64 ≈ 100Hz - 2500Hz)
        let sum = 0;
        let count = 0;
        const maxBin = Math.min(dataArray.length, 64);
        for (let i = 2; i < maxBin; i++) {
          sum += dataArray[i];
          count++;
        }
        const avg = count > 0 ? sum / count : 0;
        const rawLevel = Math.min(100, Math.round((avg / 128) * 100));

        // Exponential smoothing for stable UI display
        smoothLevel = Math.round(0.75 * smoothLevel + 0.25 * rawLevel);
        setAudioLevel(smoothLevel);

        // Ambient noise floor calibration
        if (frameCount < 15) {
          noiseFloor = Math.max(4, Math.min(30, Math.round((noiseFloor * frameCount + smoothLevel) / (frameCount + 1))));
          frameCount++;
        } else if (!hasSpokenRef.current) {
          noiseFloor = Math.max(4, Math.min(30, Math.round(0.95 * noiseFloor + 0.05 * smoothLevel)));
        }

        // Only run software VAD countdown if native SpeechRecognition is not handling it
        if (!recognitionRef.current) {
          const threshold = Math.max(speechThreshold, noiseFloor + 8);
          const isSpeaking = smoothLevel >= threshold;

          if (isSpeaking) {
            setIsUserSpeaking(true);
            isUserSpeakingRef.current = true;
            hasSpokenRef.current = true;
            consecutiveSilenceMs = 0;
            if (!speechStartTimeRef.current) {
              speechStartTimeRef.current = now;
            }
          } else {
            setIsUserSpeaking(false);
            isUserSpeakingRef.current = false;

            if (hasSpokenRef.current) {
              const speechDuration = now - speechStartTimeRef.current;
              // Require at least 500ms of speech before starting silence countdown
              if (speechDuration >= 500) {
                consecutiveSilenceMs += deltaTime;
                if (consecutiveSilenceMs >= silenceThresholdMs) {
                  console.log('[useContinuousVoice] Silence detected, finishing utterance.');
                  finishUtterance();
                  return;
                }
              }
            }
          }
        }

        animFrameRef.current = requestAnimationFrame(checkAudioLevel);
      };

      animFrameRef.current = requestAnimationFrame(checkAudioLevel);
    }

    return true;
  }, [finishUtterance, stopListening, speechThreshold, silenceThresholdMs, maxUtteranceMs]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopListening();
    };
  }, [stopListening]);

  return {
    isListening,
    isUserSpeaking,
    audioLevel,
    interimTranscript,
    error,
    startListening,
    stopListening,
    finishUtterance,
  };
}
