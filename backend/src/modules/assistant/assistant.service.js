const assistantContext = require('./assistant.context');
const assistantExtractor = require('./assistant.extractor');
const assistantSessions = require('./assistant.sessions');
const messages = require('./assistant.messages');
const schedulingService = require('../scheduling/scheduling.service');
const schedulingRepo = require('../scheduling/scheduling.repository');
const ownerPortalService = require('../owner-portal/owner.portal.service');
const timezoneUtil = require('../../utils/timezone');
const { logAuditEvent } = require('../audit-viewer/audit.event.logger');
const db = require('../../db/connection');

// Emergency clinical red flag terms
const EMERGENCY_TERMS = [
  'poison',
  'poisoning',
  'seizure',
  'bleeding',
  'blood',
  'unconscious',
  'not breathing',
  'struggling to breathe',
  'choking',
  'hit by car',
  'snake bite',
  'collapsed',
];

function levenshteinDistance(a, b) {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const matrix = [];
  for (let i = 0; i <= al; i++) matrix[i] = [i];
  for (let j = 0; j <= bl; j++) matrix[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[al][bl];
}

function stringSimilarity(a, b) {
  const s1 = String(a || '').toLowerCase().trim();
  const s2 = String(b || '').toLowerCase().trim();
  if (s1 === s2) return 1.0;
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(s1, s2);
  return (maxLen - dist) / maxLen;
}

class AssistantService {
  /**
   * Main turn processing engine.
   *
   * @param {Object} params
   * @param {Object} params.owner - Authenticated owner record from req.owner
   * @param {string|null} params.sessionId - Session UUID
   * @param {string} params.channel - 'chat' | 'voice' | 'telegram'
   * @param {string|null} params.text - Typed or transcribed user utterance
   * @param {Object|null} params.action - Direct quick-reply chip payload { type, ... }
   * @param {string|null} params.transcript - If voice, raw transcript string
   * @returns {Promise<{ sessionId: string, state: string, reply: string, transcript?: string, chips: Array, appointment?: Object }>}
   */
  async processTurn({ owner, sessionId = null, channel = 'chat', text = null, action = null, transcript = null }) {
    const userText = text ? text.trim() : null;
    const isInitialTurn = !userText && !action && transcript === null;

    // 1. Load or create persistent session (only recover existing session if user is submitting active input)
    const { session, isNew } = await assistantSessions.getOrCreateSession(sessionId, owner.id, channel, {
      allowRecovery: !isInitialTurn,
    });
    if (!session.data) session.data = {};

    // 2. Load dynamic clinic context
    const clinicId = session.data.clinicId || owner.clinic_id || owner.clinicId || 1;
    const context = await assistantContext.loadContext(owner.id, clinicId);
    session.data.clinicId = context.clinicId;

    if (userText) {
      assistantSessions.appendMessage(session, 'user', userText);
    }

    // 3. Safety Intercept: Check for life-threatening medical emergencies
    if (userText && this._isEmergency(userText)) {
      const reply = messages.emergencyAlert(context.clinic.name, context.clinic.phone);
      assistantSessions.appendMessage(session, 'assistant', reply);
      await assistantSessions.saveSession(session);
      return {
        sessionId: session.id,
        state: session.state,
        reply,
        transcript: transcript || userText,
        chips: [
          { label: `Call Emergency: ${context.clinic.phone}`, action: { type: 'call_phone', phone: context.clinic.phone } },
          { label: 'Start Over', action: { type: 'intent', value: 'greeting' } },
        ],
      };
    }

    // 4. Initial turn / greeting when session is newly created without input or audio
    if (isNew && !userText && !action && transcript === null) {
      const reply = messages.greeting(owner.name);
      assistantSessions.appendMessage(session, 'assistant', reply);
      await assistantSessions.saveSession(session);
      return {
        sessionId: session.id,
        state: 'GREETING',
        reply,
        chips: this._buildGreetingChips(),
        voiceHint: /[\u0B80-\u0BFF]/.test(reply) ? 'ta-IN-PallaviNeural' : 'en-IN-NeerjaExpressiveNeural',
      };
    }

    // 4b. Voice Audio Inaudible / No Speech Detected Fallback
    if (transcript !== null && !userText && !action) {
      if (session.state === 'COLLECT') {
        const nextParam = await this._collectNextParameter(session, context, owner);
        const reply = `I didn't quite catch that. ${nextParam.reply}`;
        assistantSessions.appendMessage(session, 'assistant', reply);
        await assistantSessions.saveSession(session);
        return {
          sessionId: session.id,
          state: session.state,
          reply,
          chips: nextParam.chips || [],
        };
      }
      const reply = "I didn't quite catch that. How can I help you today?";
      assistantSessions.appendMessage(session, 'assistant', reply);
      await assistantSessions.saveSession(session);
      return {
        sessionId: session.id,
        state: session.state,
        reply,
        chips: this._buildGreetingChips(),
      };
    }

    // 5. State Machine Transition Dispatcher
    let turnResult;
    if (action) {
      // Direct chip tap: bypasses LLM entirely for speed and determinism
      turnResult = await this._handleAction({ session, action, context, owner });
    } else {
      // Free-text or spoken turn: invoke Groq + Zod extractor
      turnResult = await this._handleFreeText({ session, text: userText, context, owner });
    }

    assistantSessions.appendMessage(session, 'assistant', turnResult.reply);
    await assistantSessions.saveSession(session);

    return {
      sessionId: session.id,
      state: session.state,
      reply: turnResult.reply,
      transcript: transcript || (channel === 'voice' ? userText : undefined),
      chips: turnResult.chips || [],
      appointment: turnResult.appointment || null,
      voiceHint: /[\u0B80-\u0BFF]/.test(turnResult.reply) ? 'ta-IN-PallaviNeural' : 'en-IN-NeerjaExpressiveNeural',
    };
  }

  _isEmergency(text) {
    const lower = text.toLowerCase();
    return EMERGENCY_TERMS.some((term) => lower.includes(term));
  }

  _isOutOfScope(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    // Clinical exceptions: If pet is sick, poisoned, injured, or discussing clinic/appointments, it is IN-SCOPE.
    if (/(poison|toxic|vomit|seizure|bleeding|emergency|sick|hurt|doctor|vet|clinic|appointment|consult|fever|cough|limp|wound|scratch)/i.test(lower)) {
      return false;
    }
    const OUT_OF_SCOPE_PATTERNS = [
      /\b(cook|cooking|recipe|recipes|briyani|biryani|idly|idli|dosa|sambar|pasta|pizza|cake|bake|baking|ferment|batter|ingredient|boil|fry)\b/i,
      /\b(code|coding|java|python|javascript|c\+\+|html|css|sql|function|algorithm|spiral matrix|matrix|program|programming|debug|compiler)\b/i,
      /\b(movie|cinema|actor|actress|trailer|film|box office|song|lyrics|cricket|football|politics|homework|essay|philosophy)\b/i,
    ];
    return OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(lower));
  }

  _buildGreetingChips() {
    return [
      { label: 'Book appointment', action: { type: 'intent', value: 'book' } },
      { label: 'My appointments', action: { type: 'intent', value: 'list' } },
      { label: 'Cancel appointment', action: { type: 'intent', value: 'cancel' } },
    ];
  }

  /**
   * Handles direct chip taps without calling the LLM.
   */
  async _handleAction({ session, action, context, owner }) {
    switch (action.type) {
      case 'intent': {
        if (action.value === 'book') {
          session.state = 'COLLECT';
          session.data = { clinicId: context.clinicId };
          return this._collectNextParameter(session, context, owner);
        }
        if (action.value === 'list') {
          return this._listAppointments(session, owner, context);
        }
        if (action.value === 'cancel') {
          return this._pickAppointmentToCancel(session, owner, context);
        }
        if (action.value === 'help') {
          return {
            reply: messages.help(),
            chips: this._buildGreetingChips(),
          };
        }
        session.state = 'GREETING';
        return { reply: messages.greeting(owner.name), chips: this._buildGreetingChips() };
      }

      case 'pick_pet': {
        const pet = context.pets.find((p) => p.id === parseInt(action.id, 10));
        if (pet) {
          session.data.petId = pet.id;
          session.data.petName = pet.name;
        }
        return this._collectNextParameter(session, context, owner);
      }

      case 'pick_doctor': {
        const doc = context.doctors.find((d) => d.id === parseInt(action.id, 10));
        if (doc) {
          session.data.doctorId = doc.id;
          session.data.doctorName = doc.name;
        }
        return this._collectNextParameter(session, context, owner);
      }

      case 'pick_date': {
        session.data.date = action.date;
        return this._collectNextParameter(session, context, owner);
      }

      case 'pick_slot': {
        const chosen = (session.data.slots || []).find((s) => s.start === action.start);
        if (chosen) {
          session.data.chosenSlot = chosen;
          session.state = 'CONFIRM';
          return {
            reply: messages.confirmPrompt(session.data.petName, session.data.doctorName, session.data.date, chosen.label),
            chips: [
              { label: 'Yes, Confirm', action: { type: 'confirm', value: true } },
              { label: 'No, Change', action: { type: 'confirm', value: false } },
            ],
          };
        }
        return {
          reply: messages.slotNotAvailable(),
          chips: this._buildSlotChips(session.data.slots),
        };
      }

      case 'confirm': {
        if (action.value === true) {
          return this._executeBooking(session, context, owner);
        }
        // User said No to confirmation: offer to change slot or restart
        session.state = 'COLLECT';
        return {
          reply: 'No problem. Would you like to pick a different time slot or start over?',
          chips: [
            { label: 'Pick another time', action: { type: 'pick_date', date: session.data.date } },
            { label: 'Start Over', action: { type: 'intent', value: 'book' } },
          ],
        };
      }

      case 'select_cancel': {
        const apptId = parseInt(action.id, 10);
        return this._confirmCancelAppointment(session, apptId, owner);
      }

      case 'execute_cancel': {
        const apptId = parseInt(action.id, 10);
        return this._executeCancel(session, apptId, owner, context);
      }

      default:
        return { reply: messages.rephrase(), chips: this._buildGreetingChips() };
    }
  }

  /**
   * Handles natural language text/voice turns with Groq + Zod extraction.
   */
  async _handleFreeText({ session, text, context, owner }) {
    const enrichedContext = {
      ...context,
      petName: session.data?.petName || null,
      doctorName: session.data?.doctorName || null,
      date: session.data?.date || null,
    };
    const extracted = await assistantExtractor.extract({
      text,
      context: enrichedContext,
      currentState: session.state,
    });

    // 0. Strict Veterinary Guardrails: Intercept non-veterinary & out-of-scope requests
    if (this._isOutOfScope(text) || extracted.intent === 'out_of_scope') {
      const petName = session.data?.petName || null;
      const reply = messages.outOfScopeDecline(petName);
      // DO NOT advance session state to COLLECT or corrupt booking data
      return {
        reply,
        chips: this._buildGreetingChips(),
      };
    }

    // Global intent redirection & natural inquiries
    if (extracted.intent === 'greeting' && session.state === 'GREETING') {
      return { reply: messages.greeting(owner.name), chips: this._buildGreetingChips() };
    }
    if (extracted.intent === 'list') {
      return this._listAppointments(session, owner, context);
    }
    if (extracted.intent === 'cancel' && session.state === 'GREETING') {
      return this._pickAppointmentToCancel(session, owner, context);
    }
    if (extracted.intent === 'help') {
      return { reply: messages.help(), chips: this._buildGreetingChips() };
    }

    // Direct answer for doctor inquiries (e.g. "what doctors do you have?")
    if (extracted.intent === 'inquire_doctors') {
      const docList = context.doctors.map((d) => `Dr. ${d.name.replace(/^Dr\.?\s+/i, '')} (${d.specialty || 'General'})`).join(', ');
      const reply = extracted.conversational_reply || `We have ${docList} available. Which doctor would you like to see?`;
      return {
        reply,
        chips: context.doctors.map((d) => ({
          label: `Dr. ${d.name.replace(/^Dr\.?\s+/i, '')}`,
          action: { type: 'pick_doctor', id: d.id },
        })),
      };
    }

    // Direct answer for general clinic information / FAQs
    if (extracted.intent === 'clinic_info') {
      const defaultInfo = `Our clinic is open Monday to Saturday from 9:00 AM to 7:00 PM. For emergency inquiries, please call ${context.clinic?.phone || '+91 98765 43210'}.`;
      const reply = extracted.conversational_reply || defaultInfo;

      if (session.state === 'COLLECT' || session.state === 'PICK_SLOT') {
        const nextParam = await this._collectNextParameter(session, context, owner);
        return {
          reply: `${reply} ${nextParam.reply}`,
          chips: nextParam.chips || [],
        };
      }
      if (session.state === 'CONFIRM') {
        const cleanDocName = (session.data.doctorName || '').replace(/^Dr\.?\s+/i, '');
        return {
          reply: `${reply} Shall I proceed to confirm the booking for ${session.data.petName} with Dr. ${cleanDocName} on ${session.data.date} at ${session.data.chosenSlot?.label}?`,
          chips: [
            { label: 'Yes, Confirm', action: { type: 'confirm', value: true } },
            { label: 'No, Change', action: { type: 'confirm', value: false } },
          ],
        };
      }

      return {
        reply,
        chips: this._buildGreetingChips(),
      };
    }

    // Flexible parameter modifications at any time (change date, doctor, pet, time)
    if (extracted.intent === 'change_parameter' || extracted.intent === 'reschedule') {
      if (extracted.changeTarget === 'doctor' || extracted.doctorName) {
        delete session.data.doctorId;
        delete session.data.doctorName;
        delete session.data.slots;
        delete session.data.chosenSlot;
        session.state = 'COLLECT';
        if (extracted.doctorName) {
          const matchResult = this._fuzzyMatchDoctor(extracted.doctorName, context.doctors);
          if (matchResult.match) {
            session.data.doctorId = matchResult.match.id;
            session.data.doctorName = matchResult.match.name;
          }
        }
        const nextParam = await this._collectNextParameter(session, context, owner);
        const prefix = extracted.conversational_reply ? `${extracted.conversational_reply} ` : '';
        return {
          reply: `${prefix}${nextParam.reply}`,
          chips: nextParam.chips || [],
        };
      }
      if (extracted.changeTarget === 'date' || extracted.date) {
        delete session.data.slots;
        delete session.data.chosenSlot;
        session.state = 'COLLECT';
        if (extracted.date) {
          session.data.date = extracted.date;
        } else {
          delete session.data.date;
        }
        const nextParam = await this._collectNextParameter(session, context, owner);
        const prefix = extracted.conversational_reply ? `${extracted.conversational_reply} ` : '';
        return {
          reply: `${prefix}${nextParam.reply}`,
          chips: nextParam.chips || [],
        };
      }
      if (extracted.changeTarget === 'pet' || extracted.petName) {
        delete session.data.petId;
        delete session.data.petName;
        session.state = 'COLLECT';
        if (extracted.petName) {
          const matchedPet = context.pets.find(
            (p) => stringSimilarity(p.name, extracted.petName) >= 0.7 || p.name.toLowerCase().includes(extracted.petName.toLowerCase())
          );
          if (matchedPet) {
            session.data.petId = matchedPet.id;
            session.data.petName = matchedPet.name;
          }
        }
        const nextParam = await this._collectNextParameter(session, context, owner);
        const prefix = extracted.conversational_reply ? `${extracted.conversational_reply} ` : '';
        return {
          reply: `${prefix}${nextParam.reply}`,
          chips: nextParam.chips || [],
        };
      }
      if (extracted.changeTarget === 'time') {
        delete session.data.chosenSlot;
        session.state = 'PICK_SLOT';
        const nextParam = await this._collectNextParameter(session, context, owner);
        const prefix = extracted.conversational_reply ? `${extracted.conversational_reply} ` : '';
        return {
          reply: `${prefix}${nextParam.reply}`,
          chips: nextParam.chips || [],
        };
      }
      if (extracted.intent === 'reschedule') {
        return this._pickAppointmentToCancel(session, owner, context);
      }
    }

    // Inquire availability: resolve date/doctor and show open slots
    if (extracted.intent === 'inquire_availability') {
      if (extracted.doctorName && !session.data.doctorId) {
        const matchResult = this._fuzzyMatchDoctor(extracted.doctorName, context.doctors);
        if (matchResult.match) {
          session.data.doctorId = matchResult.match.id;
          session.data.doctorName = matchResult.match.name;
        }
      }
      if (extracted.date) {
        session.data.date = extracted.date;
      }
      session.state = 'COLLECT';
      const nextParam = await this._collectNextParameter(session, context, owner);
      const prefix = extracted.conversational_reply ? `${extracted.conversational_reply} ` : '';
      return {
        reply: `${prefix}${nextParam.reply}`,
        chips: nextParam.chips || [],
      };
    }

    // State: CONFIRM -> user answering Yes/No
    if (session.state === 'CONFIRM') {
      if (extracted.confirm === 'yes') {
        return this._executeBooking(session, context, owner);
      }
      if (extracted.confirm === 'no') {
        session.state = 'COLLECT';
        return {
          reply: 'Booking cancelled. What would you like to change?',
          chips: [
            { label: 'Choose another slot', action: { type: 'pick_date', date: session.data.date } },
            { label: 'Start over', action: { type: 'intent', value: 'book' } },
          ],
        };
      }
      const prefix = extracted.conversational_reply ? `${extracted.conversational_reply} ` : '';
      return {
        reply: `${prefix}${messages.confirmPrompt(session.data.petName, session.data.doctorName, session.data.date, session.data.chosenSlot?.label)}`,
        chips: [
          { label: 'Yes, Confirm', action: { type: 'confirm', value: true } },
          { label: 'No, Change', action: { type: 'confirm', value: false } },
        ],
      };
    }

    // State: PICK_SLOT -> user spoke or typed a slot time
    if (session.state === 'PICK_SLOT') {
      const slots = session.data.slots || [];
      const matched = this._matchSlotTime(slots, extracted.time, text);

      if (matched) {
        session.data.chosenSlot = matched;
        session.state = 'CONFIRM';
        return {
          reply: messages.confirmPrompt(session.data.petName, session.data.doctorName, session.data.date, matched.label),
          chips: [
            { label: 'Yes, Confirm', action: { type: 'confirm', value: true } },
            { label: 'No, Change', action: { type: 'confirm', value: false } },
          ],
        };
      }
      if (extracted.timeOfDay) {
        const filtered = this._filterSlotsByTimeOfDay(slots, extracted.timeOfDay);
        return {
          reply: `Here are the available ${extracted.timeOfDay} slots with Dr. ${session.data.doctorName}:`,
          chips: this._buildSlotChips(filtered),
        };
      }
    }

    // If in GREETING and utterance is unclassified without any booking entities, rephrase without forcing COLLECT
    if (session.state === 'GREETING' && extracted.intent === 'other' && !extracted.doctorName && !extracted.petName && !extracted.date && !extracted.time) {
      return {
        reply: messages.rephrase(),
        chips: this._buildGreetingChips(),
      };
    }

    // State: COLLECT or initial book intent
    session.state = 'COLLECT';

    // Merge extracted parameters
    if (extracted.reason) session.data.reason = extracted.reason;

    // Doctor matching
    if (extracted.doctorName && !session.data.doctorId) {
      const matchResult = this._fuzzyMatchDoctor(extracted.doctorName, context.doctors);
      if (matchResult.match) {
        session.data.doctorId = matchResult.match.id;
        session.data.doctorName = matchResult.match.name;
      } else if (matchResult.multiple) {
        return {
          reply: messages.multipleDoctorsMatched(),
          chips: matchResult.candidates.map((d) => ({
            label: `Dr. ${d.name.replace(/^Dr\.?\s+/i, '')}`,
            action: { type: 'pick_doctor', id: d.id },
          })),
        };
      } else {
        return {
          reply: messages.doctorNotFound(extracted.doctorName),
          chips: context.doctors.map((d) => ({
            label: `Dr. ${d.name.replace(/^Dr\.?\s+/i, '')}`,
            action: { type: 'pick_doctor', id: d.id },
          })),
        };
      }
    }

    // Pet matching
    if (extracted.petName && !session.data.petId) {
      const matchedPet = context.pets.find(
        (p) => stringSimilarity(p.name, extracted.petName) >= 0.7 || p.name.toLowerCase().includes(extracted.petName.toLowerCase())
      );
      if (matchedPet) {
        session.data.petId = matchedPet.id;
        session.data.petName = matchedPet.name;
      }
    }

    // Date matching
    if (extracted.date) {
      session.data.date = extracted.date;
    }

    // Time matching (if user specified time early)
    if (extracted.time) {
      session.data.pendingTime = extracted.time;
    }
    if (extracted.timeOfDay) {
      session.data.timeOfDay = extracted.timeOfDay;
    }

    const nextParam = await this._collectNextParameter(session, context, owner);

    // If the user provided a conversational or empathetic reply from LLM:
    if (extracted.conversational_reply) {
      if (session.state === 'PICK_SLOT') {
        const cleanReply = extracted.conversational_reply
          .replace(/(could|can)\s+you\s+let\s+me\s+know\s+the\s+preferred\s+time[^.?]*[.?]?/gi, '')
          .trim();
        return {
          reply: cleanReply ? `${cleanReply} ${nextParam.reply}` : nextParam.reply,
          chips: nextParam.chips || [],
        };
      }
      return {
        reply: extracted.conversational_reply,
        chips: nextParam.chips || [],
      };
    }

    return nextParam;
  }

  _matchSlotTime(slots, queryTime, rawText) {
    if (!slots || slots.length === 0) return null;
    const cleanRaw = (rawText || '').toLowerCase().replace(/\./g, '');
    const qTime = (queryTime || '').trim();

    // 1. Direct match on 24h time (e.g. "09:45" or "9:45")
    if (qTime) {
      const qClean = qTime.replace(/^0/, '');
      const found = slots.find((s) => s.time === qTime || s.time.replace(/^0/, '') === qClean);
      if (found) return found;
    }

    // 2. Direct match on label or rawText
    for (const s of slots) {
      const cleanLabel = s.label.toLowerCase().replace(/\./g, '');
      if (qTime && cleanLabel.includes(qTime.toLowerCase())) return s;
      if (cleanRaw && cleanRaw.includes(cleanLabel)) return s;
      // Also match time part only (e.g. "9:45")
      const timeOnly = s.label.replace(/\s*(am|pm)/i, '').trim();
      const regexTime = new RegExp(`\\b0?${timeOnly}\\b`);
      if (regexTime.test(cleanRaw)) {
        if (cleanRaw.includes('pm') && s.label.toLowerCase().includes('am')) continue;
        if (cleanRaw.includes('am') && s.label.toLowerCase().includes('pm')) continue;
        return s;
      }
    }

    return null;
  }

  _fuzzyMatchDoctor(queryName, doctors = []) {
    const cleanQuery = queryName.replace(/^Dr\.?\s+/i, '').toLowerCase().trim();
    const scored = doctors.map((d) => {
      const cleanDoc = d.name.replace(/^Dr\.?\s+/i, '').toLowerCase().trim();
      const sim = stringSimilarity(cleanQuery, cleanDoc);
      const isSub = cleanDoc.includes(cleanQuery) || cleanQuery.includes(cleanDoc);
      const effectiveSim = isSub ? Math.max(0.85, sim) : sim;
      return { doctor: d, similarity: effectiveSim };
    });

    scored.sort((a, b) => b.similarity - a.similarity);
    const best = scored[0];
    if (best && best.similarity >= 0.6) {
      const closeMatches = scored.filter((s) => s.similarity >= 0.6);
      if (closeMatches.length > 1 && Math.abs(closeMatches[0].similarity - closeMatches[1].similarity) < 0.15) {
        return { multiple: true, candidates: closeMatches.map((m) => m.doctor) };
      }
      return { match: best.doctor };
    }
    return { match: null, multiple: false };
  }

  /**
   * Evaluates missing parameters in priority: Pet -> Doctor -> Date -> Slot
   */
  async _collectNextParameter(session, context, owner) {
    // 1. Resolve Pet
    if (!session.data.petId) {
      if (context.pets.length === 1) {
        // Auto-select if guardian has exactly 1 pet
        session.data.petId = context.pets[0].id;
        session.data.petName = context.pets[0].name;
      } else if (context.pets.length > 1) {
        return {
          reply: messages.askPet(),
          chips: context.pets.map((p) => ({
            label: `${p.name} (${p.species})`,
            action: { type: 'pick_pet', id: p.id },
          })),
        };
      } else {
        return {
          reply: 'You do not have any registered pets. Please register a pet in the portal first.',
          chips: [{ label: 'Register Pet', action: { type: 'intent', value: 'help' } }],
        };
      }
    }

    // 2. Resolve Doctor
    if (!session.data.doctorId) {
      if (context.doctors.length === 1) {
        // Auto-select if clinic has exactly 1 doctor
        session.data.doctorId = context.doctors[0].id;
        session.data.doctorName = context.doctors[0].name;
      } else if (context.doctors.length > 1) {
        return {
          reply: messages.askDoctor(),
          chips: context.doctors.map((d) => ({
            label: `Dr. ${d.name.replace(/^Dr\.?\s+/i, '')}`,
            action: { type: 'pick_doctor', id: d.id },
          })),
        };
      }
    }

    // 3. Resolve Date
    if (!session.data.date) {
      const today = context.todayDate;
      const tmrwDate = new Date(today);
      tmrwDate.setDate(tmrwDate.getDate() + 1);
      const tomorrow = tmrwDate.toISOString().split('T')[0];

      return {
        reply: messages.askDate(),
        chips: [
          { label: 'Today', action: { type: 'pick_date', date: today } },
          { label: 'Tomorrow', action: { type: 'pick_date', date: tomorrow } },
        ],
      };
    }

    // 4. Compute Available Slots
    const rawSlots = await schedulingService.getAvailableSlots(
      session.data.clinicId,
      session.data.doctorId,
      session.data.date
    );

    const availableSlots = rawSlots.filter((s) => s.available);

    if (availableSlots.length === 0) {
      // Find next 3 dates with slots (look up to 14 days ahead)
      const nextDates = await this._findNextDatesWithSlots(
        session.data.clinicId,
        session.data.doctorId,
        session.data.date,
        14
      );

      return {
        reply: messages.noSlots(session.data.doctorName, session.data.date, nextDates),
        chips: nextDates.map((d) => ({
          label: d,
          action: { type: 'pick_date', date: d },
        })),
      };
    }

    session.data.slots = availableSlots;

    // Check if user pre-specified a time earlier in turn
    if (session.data.pendingTime) {
      const matched = this._matchSlotTime(availableSlots, session.data.pendingTime, session.data.pendingTime);
      if (matched) {
        delete session.data.pendingTime;
        session.data.chosenSlot = matched;
        session.state = 'CONFIRM';
        return {
          reply: messages.confirmPrompt(session.data.petName, session.data.doctorName, session.data.date, matched.label),
          chips: [
            { label: 'Yes, Confirm', action: { type: 'confirm', value: true } },
            { label: 'No, Change', action: { type: 'confirm', value: false } },
          ],
        };
      }
    }

    // Transition to PICK_SLOT
    session.state = 'PICK_SLOT';
    let filteredSlots = availableSlots;
    if (session.data.timeOfDay) {
      filteredSlots = this._filterSlotsByTimeOfDay(availableSlots, session.data.timeOfDay);
    }

    return {
      reply: messages.slotsAvailable(session.data.doctorName, session.data.date, filteredSlots, 5),
      chips: this._buildSlotChips(filteredSlots),
    };
  }

  _filterSlotsByTimeOfDay(slots, timeOfDay) {
    if (timeOfDay === 'morning') {
      return slots.filter((s) => {
        const [h] = s.time.split(':').map(Number);
        return h < 12;
      });
    }
    if (timeOfDay === 'afternoon') {
      return slots.filter((s) => {
        const [h] = s.time.split(':').map(Number);
        return h >= 12 && h < 17;
      });
    }
    if (timeOfDay === 'evening') {
      return slots.filter((s) => {
        const [h] = s.time.split(':').map(Number);
        return h >= 17;
      });
    }
    return slots;
  }

  _buildSlotChips(slots = []) {
    return slots.map((s) => ({
      label: s.label,
      action: { type: 'pick_slot', start: s.start, label: s.label },
    }));
  }

  async _findNextDatesWithSlots(clinicId, doctorId, startDateStr, maxDays = 14) {
    const dates = [];
    const base = new Date(startDateStr);

    for (let i = 1; i <= maxDays; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      const slots = await schedulingService.getAvailableSlots(clinicId, doctorId, dateStr);
      if (slots.some((s) => s.available)) {
        dates.push(dateStr);
        if (dates.length >= 3) break;
      }
    }
    return dates;
  }

  /**
   * Finalizes the booking transaction.
   */
  async _executeBooking(session, context, owner) {
    const { petId, petName, doctorId, doctorName, date, chosenSlot, reason } = session.data;

    // Join all user messages for audit transcript
    const userTranscript = (session.messages || [])
      .filter((m) => m.role === 'user')
      .map((m) => m.text)
      .join(' | ');

    try {
      const appointment = await ownerPortalService.bookAppointment(owner.id, {
        clinicId: context.clinicId,
        petId,
        doctorId,
        appointmentDate: date,
        startTime: chosenSlot.time,
        durationMin: chosenSlot.durationMin || 15,
        reason: reason || 'Veterinary visit booked via Dharu Assistant',
      });

      // Update booking channel and transcript
      await db.query(
        `UPDATE appointments
         SET booking_channel = $1, booking_transcript = $2
         WHERE id = $3;`,
        [session.channel || 'chat', userTranscript, appointment.id]
      );

      session.state = 'DONE';

      // Dispatch confirmation email (with .ics calendar) and Web Push notification
      const notificationService = require('../notifications/notification.service');
      const doctorObj = context.doctors.find((d) => d.id === doctorId) || { id: doctorId, name: doctorName };
      const petObj = context.pets.find((p) => p.id === petId) || { id: petId, name: petName };

      notificationService.sendAppointmentConfirmation({
        clinicId: context.clinicId,
        appointment,
        owner,
        doctor: doctorObj,
        pet: petObj,
        clinic: context.clinic,
      }).catch((e) => console.error('[Assistant] Confirmation notification dispatch error:', e.message));

      // Log structured audit event
      logAuditEvent({
        clinicId: context.clinicId,
        actorUserId: owner.userId || null,
        actorRole: 'pet_owner',
        action: 'appointment_booked_assistant',
        targetType: 'appointment',
        targetId: appointment.id,
        metadata: {
          sessionId: session.id,
          channel: session.channel,
          petId,
          doctorId,
          scheduledAt: appointment.scheduled_at,
        },
      }).catch((e) => console.error('[Assistant] Audit event logging error:', e.message));

      // Build confirmation response with calendar (.ics) generation payload
      const reply = messages.bookingSuccess(petName, doctorName, date, chosenSlot.label, context.clinic.name);
      return {
        reply,
        state: 'DONE',
        chips: [
          { label: 'View My Appointments', action: { type: 'intent', value: 'list' } },
          { label: 'Book Another', action: { type: 'intent', value: 'book' } },
        ],
        appointment: {
          id: appointment.id,
          petName,
          doctorName,
          date,
          time: chosenSlot.label,
          hospitalName: context.clinic.name,
          address: context.clinic.address,
          scheduledAt: appointment.scheduled_at,
          durationMin: chosenSlot.durationMin || 15,
        },
      };
    } catch (err) {
      if (err.statusCode === 409 || err.code === 'SLOT_CONFLICT') {
        // Double booking race condition: refetch slots and return to PICK_SLOT
        const refreshedSlots = await schedulingService.getAvailableSlots(context.clinicId, doctorId, date);
        session.data.slots = refreshedSlots.filter((s) => s.available);
        session.state = 'PICK_SLOT';
        return {
          reply: messages.conflictRetry(doctorName, date),
          chips: this._buildSlotChips(session.data.slots),
        };
      }
      throw err;
    }
  }

  async _listAppointments(session, owner, context) {
    const query = `
      SELECT a.id, a.scheduled_at, a.duration_min, a.status, a.reason,
             p.name AS pet_name, u.name AS doctor_name
      FROM appointments a
      JOIN pet_owners po ON po.pet_id = a.pet_id
      JOIN pets p ON p.id = a.pet_id
      LEFT JOIN users u ON u.id = a.doctor_id
      WHERE po.owner_id = $1 AND a.status IN ('scheduled', 'confirmed') AND a.scheduled_at >= NOW()
      ORDER BY a.scheduled_at ASC;
    `;
    const { rows } = await db.query(query, [owner.id]);

    if (rows.length === 0) {
      return {
        reply: messages.noAppointments(),
        chips: [{ label: 'Book an Appointment', action: { type: 'intent', value: 'book' } }],
      };
    }

    const reply = messages.myAppointmentsList(rows.length);
    const chips = rows.map((a) => {
      const timeLabel = timezoneUtil.formatTimeInTimezone(a.scheduled_at, context.timeZone);
      const dateLabel = timezoneUtil.formatDateInTimezone(a.scheduled_at, context.timeZone);
      return {
        label: `${a.pet_name} with ${a.doctor_name || 'Doctor'} on ${dateLabel} (${timeLabel})`,
        action: { type: 'select_cancel', id: a.id },
      };
    });

    return { reply, chips };
  }

  async _pickAppointmentToCancel(session, owner, context) {
    const query = `
      SELECT a.id, a.scheduled_at, p.name AS pet_name, u.name AS doctor_name
      FROM appointments a
      JOIN pet_owners po ON po.pet_id = a.pet_id
      JOIN pets p ON p.id = a.pet_id
      LEFT JOIN users u ON u.id = a.doctor_id
      WHERE po.owner_id = $1 AND a.status IN ('scheduled', 'confirmed') AND a.scheduled_at >= NOW()
      ORDER BY a.scheduled_at ASC;
    `;
    const { rows } = await db.query(query, [owner.id]);

    if (rows.length === 0) {
      return {
        reply: 'You have no active appointments to cancel.',
        chips: [{ label: 'Book appointment', action: { type: 'intent', value: 'book' } }],
      };
    }

    return {
      reply: 'Which appointment would you like to cancel?',
      chips: rows.map((a) => {
        const timeLabel = timezoneUtil.formatTimeInTimezone(a.scheduled_at, context.timeZone);
        const dateLabel = timezoneUtil.formatDateInTimezone(a.scheduled_at, context.timeZone);
        return {
          label: `Cancel: ${a.pet_name} on ${dateLabel} at ${timeLabel}`,
          action: { type: 'select_cancel', id: a.id },
        };
      }),
    };
  }

  async _confirmCancelAppointment(session, apptId, owner) {
    // Security check: verify appointment belongs to owner
    const query = `
      SELECT a.id, a.scheduled_at, a.clinic_id, p.name AS pet_name, u.name AS doctor_name
      FROM appointments a
      JOIN pet_owners po ON po.pet_id = a.pet_id
      JOIN pets p ON p.id = a.pet_id
      LEFT JOIN users u ON u.id = a.doctor_id
      WHERE a.id = $1 AND po.owner_id = $2;
    `;
    const { rows } = await db.query(query, [apptId, owner.id]);
    if (rows.length === 0) {
      return { reply: 'Appointment not found or you are not authorized to cancel it.', chips: this._buildGreetingChips() };
    }

    const appt = rows[0];
    const timeZone = await schedulingRepo.getClinicTimezone(appt.clinic_id);
    const dateLabel = timezoneUtil.formatDateInTimezone(appt.scheduled_at, timeZone);
    const timeLabel = timezoneUtil.formatTimeInTimezone(appt.scheduled_at, timeZone);

    session.data.cancelApptId = appt.id;
    session.data.cancelPetName = appt.pet_name;
    session.data.cancelDate = dateLabel;

    return {
      reply: messages.cancelConfirmPrompt(appt.pet_name, appt.doctor_name, dateLabel, timeLabel),
      chips: [
        { label: 'Yes, Cancel it', action: { type: 'execute_cancel', id: appt.id } },
        { label: 'No, Keep it', action: { type: 'intent', value: 'greeting' } },
      ],
    };
  }

  async _executeCancel(session, apptId, owner, context) {
    // Security verification
    const verifyQuery = `
      SELECT a.id, a.clinic_id, p.name AS pet_name, a.scheduled_at
      FROM appointments a
      JOIN pet_owners po ON po.pet_id = a.pet_id
      JOIN pets p ON p.id = a.pet_id
      WHERE a.id = $1 AND po.owner_id = $2;
    `;
    const { rows } = await db.query(verifyQuery, [apptId, owner.id]);
    if (rows.length === 0) {
      return { reply: 'Appointment not found or you are not authorized to cancel it.', chips: this._buildGreetingChips() };
    }

    const appt = rows[0];
    await schedulingRepo.update(appt.clinic_id, appt.id, {
      status: 'cancelled',
      cancelled_reason: 'Cancelled via Pet Guardian Assistant',
    });

    logAuditEvent({
      clinicId: appt.clinic_id,
      actorUserId: owner.userId || null,
      actorRole: 'pet_owner',
      action: 'appointment_cancelled_assistant',
      targetType: 'appointment',
      targetId: appt.id,
      metadata: { sessionId: session.id },
    }).catch(() => {});

    // Dispatch cancellation notification via email and web push
    const notificationService = require('../notifications/notification.service');
    notificationService.sendAppointmentCancellation({
      clinicId: appt.clinic_id,
      appointment: appt,
      owner,
      pet: { name: appt.pet_name },
      clinic: context.clinic,
    }).catch((e) => console.error('[Assistant] Cancellation notification dispatch error:', e.message));

    session.state = 'GREETING';
    const dateLabel = timezoneUtil.formatDateInTimezone(appt.scheduled_at, context.timeZone);

    return {
      reply: messages.cancelledSuccess(appt.pet_name, dateLabel),
      chips: [
        { label: 'Book another appointment', action: { type: 'intent', value: 'book' } },
        { label: 'My appointments', action: { type: 'intent', value: 'list' } },
      ],
    };
  }
}

module.exports = new AssistantService();
