import React, { useEffect, useRef } from 'react';
import { Calendar, CheckCircle2, Clock, MapPin, User, Download, Sparkles } from 'lucide-react';
import { QuickReplyChips } from './QuickReplyChips';

/**
 * Client-side .ics (iCalendar) file generator
 */
function downloadIcsCalendar(appointment) {
  if (!appointment) return;

  const { petName, doctorName, date, time, hospitalName, address, scheduledAt, durationMin = 15 } = appointment;

  let startIso = scheduledAt;
  if (!startIso && date && time) {
    startIso = `${date}T${time}:00Z`;
  }

  const startDate = startIso ? new Date(startIso) : new Date();
  const endDate = new Date(startDate.getTime() + durationMin * 60 * 1000);

  const formatIcsTime = (d) => {
    return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  };

  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//PetCare AI//Appointment Assistant//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:petcare-apt-${Date.now()}@petcare.ai`,
    `DTSTAMP:${formatIcsTime(new Date())}`,
    `DTSTART:${formatIcsTime(startDate)}`,
    `DTEND:${formatIcsTime(endDate)}`,
    `SUMMARY:Veterinary Appointment: ${petName || 'Pet'} with Dr. ${doctorName || 'Vet'}`,
    `DESCRIPTION:Clinical consultation for ${petName} at ${hospitalName || 'Central Animal Hospital'}. Attending Veterinarian: Dr. ${doctorName}.`,
    `LOCATION:${hospitalName || 'PetCare Hospital'}${address ? ', ' + address : ''}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `appointment_${petName || 'pet'}_${date || 'date'}.ics`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function ChatMessageList({ messages = [], chips = [], onSelectChip, onChipClick, loading = false }) {
  const endRef = useRef(null);
  const handleChip = onSelectChip || onChipClick;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, chips]);

  return (
    <div className="assistant-chat-body assistant-message-list" role="log" aria-live="polite">
      {messages.map((msg, index) => {
        const isUser = msg.role === 'user';
        const isLatestBot = !isUser && index === messages.length - 1;

        return (
          <div key={msg.id || index} className={`assistant-bubble-row ${isUser ? 'user' : 'bot'}`}>
            {!isUser && (
              <div className="assistant-avatar" aria-hidden="true">
                <Sparkles size={18} />
              </div>
            )}

            <div className={`assistant-bubble ${isUser ? 'user' : 'bot'} ${msg.isError ? 'error' : ''}`}>
              {msg.isVoiceTranscript && (
                <div className="assistant-heard-label">
                  <span className="heard-tag">🎙️ I heard:</span>
                </div>
              )}

              <div className="assistant-bubble-text">{msg.text}</div>

              {/* Confirmation Card when appointment is confirmed */}
              {msg.appointment && (
                <div className="assistant-confirmation-card">
                  <div className="confirmation-header">
                    <CheckCircle2 size={20} className="confirmation-icon" aria-hidden="true" />
                    <span className="confirmation-title">Appointment Confirmed</span>
                  </div>

                  <div className="confirmation-details">
                    <div className="detail-item">
                      <User size={15} className="detail-icon" />
                      <span><strong>Patient:</strong> {msg.appointment.petName}</span>
                    </div>
                    <div className="detail-item">
                      <User size={15} className="detail-icon" />
                      <span><strong>Doctor:</strong> Dr. {msg.appointment.doctorName}</span>
                    </div>
                    <div className="detail-item">
                      <Calendar size={15} className="detail-icon" />
                      <span><strong>Date:</strong> {msg.appointment.date}</span>
                    </div>
                    <div className="detail-item">
                      <Clock size={15} className="detail-icon" />
                      <span><strong>Time:</strong> {msg.appointment.time}</span>
                    </div>
                    {msg.appointment.hospitalName && (
                      <div className="detail-item">
                        <MapPin size={15} className="detail-icon" />
                        <span><strong>Hospital:</strong> {msg.appointment.hospitalName}</span>
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    className="assistant-calendar-btn"
                    onClick={() => downloadIcsCalendar(msg.appointment)}
                  >
                    <Download size={16} aria-hidden="true" />
                    <span>Add to Calendar (.ics)</span>
                  </button>
                </div>
              )}

              {/* Render quick-reply chips under the latest bot bubble */}
              {isLatestBot && chips && chips.length > 0 && !loading && (
                <div className="assistant-bubble-chips">
                  <QuickReplyChips chips={chips} onSelect={handleChip} onChipClick={handleChip} />
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Typing Indicator */}
      {loading && (
        <div className="assistant-bubble-row bot">
          <div className="assistant-avatar" aria-hidden="true">
            <Sparkles size={18} />
          </div>
          <div className="assistant-bubble bot typing">
            <div className="assistant-typing-dots">
              <span className="dot"></span>
              <span className="dot"></span>
              <span className="dot"></span>
            </div>
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}

