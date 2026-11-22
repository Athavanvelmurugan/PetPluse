import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Sparkles, Bot, Mic, MicOff, Send, X, RotateCcw,
  Volume2, VolumeX, MessageSquare, AlertCircle, Calendar
} from 'lucide-react';
import { useAssistantSession } from './useAssistantSession';
import { useSpeech } from './useSpeech';
import { useContinuousVoice } from './useContinuousVoice';
import { ChatMessageList } from './ChatMessageList';
import { QuickReplyChips } from './QuickReplyChips';
import './assistant.css';

export function AssistantDrawer({
  isOpen = false,
  onClose,
  initialMode = 'chat',
  onAppointmentBooked,
}) {
  const [mode, setMode] = useState(initialMode);
  const [inputVal, setInputVal] = useState('');
  const [isHandsFreeActive, setIsHandsFreeActive] = useState(true);

  const {
    sessionId,
    state,
    messages,
    chips,
    loading,
    error: apiError,
    appointment,
    sendTurn,
    resetSession,
  } = useAssistantSession();

  const { isSpeaking: isAssistantSpeaking, isMuted, toggleMute, speak, stop: stopSpeaking } = useSpeech();

  const inputRef = useRef(null);
  const hasInitializedRef = useRef(false);
  const stateRef = useRef(state);
  const modeRef = useRef(mode);
  const isOpenRef = useRef(isOpen);
  const isHandsFreeRef = useRef(isHandsFreeActive);

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { isOpenRef.current = isOpen; }, [isOpen]);
  useEffect(() => { isHandsFreeRef.current = isHandsFreeActive; }, [isHandsFreeActive]);

  // Forward declaration of startListening ref to break cyclic dependency
  const startListeningRef = useRef(null);

  // Resume listening after Dharu finishes speaking if in hands-free voice mode
  const handleTurnSpeechEnd = useCallback(() => {
    if (
      modeRef.current === 'voice' &&
      isOpenRef.current &&
      isHandsFreeRef.current &&
      stateRef.current !== 'DONE'
    ) {
      setTimeout(() => {
        if (
          modeRef.current === 'voice' &&
          isOpenRef.current &&
          isHandsFreeRef.current &&
          stateRef.current !== 'DONE'
        ) {
          startListeningRef.current?.();
        }
      }, 350);
    }
  }, []);

  // Handle recorded utterance from silence detection or native speech recognition
  const handleUtteranceRecorded = useCallback(async (payload) => {
    if (!payload || !isOpenRef.current) return;

    let res;
    if (typeof payload === 'string') {
      res = await sendTurn({ text: payload, channel: 'voice' });
    } else if (payload.text) {
      res = await sendTurn({ text: payload.text, channel: 'voice' });
    } else if (payload instanceof Blob) {
      res = await sendTurn({ audioBlob: payload, channel: 'voice' });
    } else if (payload.audioBlob) {
      res = await sendTurn({ audioBlob: payload.audioBlob, channel: 'voice' });
    }

    if (res?.reply) {
      speak(res.reply, handleTurnSpeechEnd, res?.voiceHint);
    }
  }, [sendTurn, speak, handleTurnSpeechEnd]);

  const {
    isListening,
    isUserSpeaking,
    audioLevel,
    interimTranscript,
    error: micError,
    startListening,
    stopListening,
    finishUtterance,
  } = useContinuousVoice({
    onUtteranceRecorded: handleUtteranceRecorded,
    silenceThresholdMs: 800,
    speechThreshold: 12,
    maxUtteranceMs: 15000,
  });

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  // Sync initial mode and trigger greeting turn when drawer opens (microphone does NOT auto-start)
  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      if (!sessionId && !hasInitializedRef.current) {
        hasInitializedRef.current = true;
        sendTurn({ channel: initialMode }).then((res) => {
          if (res?.reply && initialMode === 'voice') {
            speak(res.reply, undefined, res?.voiceHint);
          }
        });
      }
    }
  }, [isOpen, initialMode, sessionId, sendTurn, speak]);

  // Track last notified appointment to prevent duplicate/infinite callback loops
  const lastNotifiedAppointmentKeyRef = useRef(null);

  // Notify parent component when appointment is booked (exactly once per appointment)
  useEffect(() => {
    if (appointment && onAppointmentBooked) {
      const apptKey = appointment.id || `${appointment.date}-${appointment.time}-${appointment.doctorName}`;
      if (apptKey && apptKey !== lastNotifiedAppointmentKeyRef.current) {
        lastNotifiedAppointmentKeyRef.current = apptKey;
        onAppointmentBooked(appointment);
      }
    }
  }, [appointment, onAppointmentBooked]);

  // Auto-focus input on chat mode
  useEffect(() => {
    if (isOpen && mode === 'chat' && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen, mode]);

  // Close drawer on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Stop TTS speech and microphone when drawer closes
  useEffect(() => {
    if (!isOpen) {
      stopSpeaking();
      stopListening();
    }
  }, [isOpen, stopSpeaking, stopListening]);

  // Switch modes cleanly (microphone does NOT auto-start on tab switch)
  const handleModeSwitch = (newMode) => {
    setMode(newMode);
    stopSpeaking();
    stopListening();
  };

  // Handle Text Send in Chat Mode
  const handleSendText = useCallback(async () => {
    const trimmed = inputVal.trim();
    if (!trimmed || loading) return;

    setInputVal('');
    stopSpeaking();

    const res = await sendTurn({ text: trimmed, channel: 'chat' });
    if (res?.reply && !isMuted) {
      speak(res.reply, undefined, res?.voiceHint);
    }
  }, [inputVal, loading, sendTurn, speak, isMuted, stopSpeaking]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendText();
    }
  };

  // Handle Quick Reply Chip Click
  const handleChipClick = useCallback(async (action) => {
    if (loading) return;
    stopSpeaking();
    stopListening();

    const res = await sendTurn({ action, channel: mode });
    if (res?.reply && (mode === 'voice' || !isMuted)) {
      speak(
        res.reply,
        mode === 'voice' ? handleTurnSpeechEnd : undefined,
        res?.voiceHint
      );
    }
  }, [loading, sendTurn, mode, isMuted, speak, stopSpeaking, stopListening, handleTurnSpeechEnd]);

  // Toggle Hands-Free Microphone listening manually
  const toggleVoiceCapture = useCallback(() => {
    if (isListening) {
      if (isUserSpeaking) {
        // User tapped while speaking -> complete turn immediately and submit!
        finishUtterance();
      } else {
        setIsHandsFreeActive(false);
        stopListening();
      }
    } else {
      setIsHandsFreeActive(true);
      stopSpeaking();
      startListening();
    }
  }, [isListening, isUserSpeaking, finishUtterance, stopListening, stopSpeaking, startListening]);

  if (!isOpen) return null;

  // Retrieve the latest assistant reply for Voice mode display
  const botMessages = messages.filter((m) => m.role === 'assistant');
  const latestBotReply = botMessages.length > 0 ? botMessages[botMessages.length - 1].text : null;
  const userMessages = messages.filter((m) => m.role === 'user');
  const latestUserTranscript = userMessages.length > 0 ? userMessages[userMessages.length - 1].text : null;

  return (
    <div className="assistant-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Appointment Assistant Dharu">
      <div className="assistant-drawer" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <header className="assistant-header">
          <div className="assistant-header-left">
            <div className="assistant-bot-badge" aria-hidden="true">
              <Bot size={22} />
            </div>
            <div className="assistant-title-group">
              <span className="assistant-title">Dharu AI Assistant</span>
              <span className="assistant-subtitle">Hands-Free Conversational Voice</span>
            </div>
          </div>

          <div className="assistant-header-actions">
            <button
              type="button"
              className="assistant-icon-btn"
              onClick={toggleMute}
              title={isMuted ? 'Unmute voice reading' : 'Mute voice reading'}
              aria-label={isMuted ? 'Unmute voice' : 'Mute voice'}
            >
              {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>

            <button
              type="button"
              className="assistant-icon-btn"
              onClick={() => {
                const doReset = resetSession || restartSession;
                doReset?.();
                stopSpeaking();
                stopListening();
                sendTurn({ channel: mode }).then((res) => {
                  if (res?.reply && mode === 'voice') {
                    speak(res.reply, undefined, res?.voiceHint);
                  }
                });
              }}
              title="Start a new conversation"
              aria-label="Restart conversation"
            >
              <RotateCcw size={18} />
            </button>

            <button
              type="button"
              className="assistant-icon-btn"
              onClick={onClose}
              title="Close assistant"
              aria-label="Close assistant"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        {/* Mode Switcher Tabs */}
        <nav className="assistant-mode-bar" aria-label="Assistant Interaction Modes">
          <button
            type="button"
            className={`assistant-mode-tab ${mode === 'chat' ? 'active' : ''}`}
            onClick={() => handleModeSwitch('chat')}
          >
            <MessageSquare size={16} />
            <span>Chat Mode</span>
          </button>

          <button
            type="button"
            className={`assistant-mode-tab ${mode === 'voice' ? 'active' : ''}`}
            onClick={() => handleModeSwitch('voice')}
          >
            <Mic size={16} />
            <span>Voice Mode</span>
          </button>
        </nav>

        {/* Mode 1: Chat View */}
        {mode === 'chat' && (
          <>
            <ChatMessageList
              messages={messages}
              chips={chips}
              onSelectChip={handleChipClick}
              onChipClick={handleChipClick}
              loading={loading}
            />

            {apiError && (
              <div className="p-3 bg-danger-soft text-danger-ink border-t border-danger-border flex items-center gap-2 text-xs">
                <AlertCircle size={14} />
                <span>{apiError}</span>
              </div>
            )}

            <footer className="assistant-chat-footer">
              <input
                ref={inputRef}
                type="text"
                className="assistant-chat-input"
                placeholder="Type a message (e.g., Book visit for Luna tomorrow)..."
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={loading}
                aria-label="Chat message input"
              />

              <button
                type="button"
                className="assistant-icon-btn"
                onClick={() => handleModeSwitch('voice')}
                title="Switch to Voice mode"
                aria-label="Switch to Voice mode"
              >
                <Mic size={18} />
              </button>

              <button
                type="button"
                className="assistant-send-btn"
                onClick={handleSendText}
                disabled={!inputVal.trim() || loading}
                title="Send message"
                aria-label="Send message"
              >
                <Send size={18} />
              </button>
            </footer>
          </>
        )}

        {/* Mode 2: Voice View */}
        {mode === 'voice' && (
          <div className="assistant-voice-body">
            <div className="voice-status-box">
              <span className="voice-status-title">
                {isUserSpeaking
                  ? 'I hear you speaking...'
                  : isListening
                  ? 'Listening... (tap button or pause when done)'
                  : loading
                  ? 'Transcribing and processing audio...'
                  : isAssistantSpeaking
                  ? 'Dharu is speaking...'
                  : 'Click microphone to start speaking'}
              </span>
              <span className="voice-status-sub">
                {isListening
                  ? 'Pause or tap button to send'
                  : 'Click the button below when you are ready to speak'}
              </span>
            </div>

            {micError && (
              <div className="p-3 bg-danger-soft text-danger-ink border border-danger-border rounded-md text-xs flex items-center gap-2 max-w-sm">
                <AlertCircle size={16} />
                <span>{micError}</span>
              </div>
            )}

            {/* Pulsing Mic Visualizer with Live Audio Level */}
            <div className="voice-mic-wrapper">
              {(isListening || isAssistantSpeaking) && (
                <div
                  className={`voice-pulse-ring ${isUserSpeaking ? 'speaking' : ''}`}
                />
              )}
              <button
                type="button"
                className={`voice-mic-main-btn ${isListening ? 'listening' : ''}`}
                onClick={toggleVoiceCapture}
                disabled={loading}
                title={
                  isListening
                    ? isUserSpeaking
                      ? 'Tap to send what you just said'
                      : 'Tap to stop listening'
                    : 'Click to start speaking'
                }
                aria-label={isListening ? 'Stop or send speech' : 'Start speaking'}
              >
                <Mic size={32} />
              </button>
            </div>

            {/* Voice Activity Level Meter */}
            {isListening && (
              <div className="voice-vad-meter-bar" aria-label="Speech Volume Meter">
                <div
                  className="voice-vad-level-fill"
                  style={{ width: `${Math.max(12, Math.min(100, audioLevel))}%` }}
                  data-speaking={isUserSpeaking ? 'true' : 'false'}
                />
              </div>
            )}

            {/* Tap to Send Immediately Option */}
            {isListening && (
              <button
                type="button"
                className="voice-done-btn"
                onClick={finishUtterance}
                disabled={loading}
                title="Send your spoken message now without waiting for pause"
              >
                <span>Done Speaking (Send Now)</span>
              </button>
            )}

            {/* Transcribed Speech & Dharu Reply Cards */}
            <div className="voice-transcript-card">
              <span className="voice-transcript-label">
                {interimTranscript
                  ? 'Hearing you say...'
                  : latestUserTranscript
                  ? 'I heard:'
                  : 'Voice Transcript:'}
              </span>
              <p>
                {interimTranscript || latestUserTranscript || 'Your spoken words will appear here as you speak.'}
              </p>
            </div>

            {latestBotReply && (
              <div className="voice-transcript-card">
                <span className="voice-transcript-label">Dharu says:</span>
                <p>{latestBotReply}</p>
              </div>
            )}

            {/* Quick Reply Chips in Voice View */}
            {chips && chips.length > 0 && (
              <div className="voice-chips-wrapper">
                <QuickReplyChips chips={chips} onSelect={handleChipClick} onChipClick={handleChipClick} disabled={loading} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
