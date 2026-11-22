const db = require('../../db/connection');

class AssistantSessionManager {
  /**
   * Fetch an existing active session or provision a new one.
   * Cleans up expired sessions opportunistically.
   *
   * @param {string|null} sessionId - UUID or null
   * @param {number} ownerId - Integer PK of owner
   * @param {string} channel - 'chat' | 'voice' | 'telegram'
   * @returns {Promise<{ session: Object, isNew: boolean }>}
   */
  async getOrCreateSession(sessionId, ownerId, channel = 'chat', { allowRecovery = true } = {}) {
    // 1. Opportunistic cleanup of expired sessions
    db.query(`DELETE FROM assistant_sessions WHERE expires_at < NOW();`).catch(() => {});

    // 2. Attempt to load active session if valid UUID provided
    if (sessionId && typeof sessionId === 'string' && sessionId.trim().length === 36) {
      const res = await db.query(
        `SELECT id, owner_id, channel, state, data, messages, expires_at, created_at, updated_at
         FROM assistant_sessions
         WHERE id = $1 AND owner_id = $2 AND expires_at > NOW();`,
        [sessionId.trim(), ownerId]
      );

      if (res.rows.length > 0) {
        return { session: res.rows[0], isNew: false };
      }
    } else if (allowRecovery) {
      // 2b. Fallback: If sessionId was not provided, look for any active unexpired session for this owner
      const activeRes = await db.query(
        `SELECT id, owner_id, channel, state, data, messages, expires_at, created_at, updated_at
         FROM assistant_sessions
         WHERE owner_id = $1 AND expires_at > NOW() AND state != 'DONE'
         ORDER BY updated_at DESC
         LIMIT 1;`,
        [ownerId]
      );

      if (activeRes.rows.length > 0) {
        return { session: activeRes.rows[0], isNew: false };
      }
    }

    // 3. Provision a new session (15-minute expiry)
    const newSessionRes = await db.query(
      `INSERT INTO assistant_sessions (owner_id, channel, state, data, messages, expires_at)
       VALUES ($1, $2, 'GREETING', '{}'::jsonb, '[]'::jsonb, NOW() + INTERVAL '15 minutes')
       RETURNING id, owner_id, channel, state, data, messages, expires_at, created_at, updated_at;`,
      [ownerId, channel || 'chat']
    );

    return { session: newSessionRes.rows[0], isNew: true };
  }

  /**
   * Update session state, parameters, transcript, and refresh the 15-minute expiry.
   */
  async saveSession(session) {
    const query = `
      UPDATE assistant_sessions
      SET state = $1,
          data = $2,
          messages = $3,
          channel = COALESCE($4, channel),
          updated_at = NOW(),
          expires_at = NOW() + INTERVAL '15 minutes'
      WHERE id = $5 AND owner_id = $6
      RETURNING *;
    `;
    const values = [
      session.state,
      JSON.stringify(session.data || {}),
      JSON.stringify(session.messages || []),
      session.channel || 'chat',
      session.id,
      session.owner_id,
    ];

    const { rows } = await db.query(query, values);
    return rows[0] || session;
  }

  /**
   * Cancel / delete a session on demand.
   */
  async cancelSession(sessionId, ownerId) {
    await db.query(
      `DELETE FROM assistant_sessions WHERE id = $1 AND owner_id = $2;`,
      [sessionId, ownerId]
    );
  }

  /**
   * Append a message to the transcript history in memory.
   */
  appendMessage(session, role, text) {
    if (!session.messages) session.messages = [];
    session.messages.push({
      role: role === 'user' ? 'user' : 'assistant',
      text: String(text || '').trim(),
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = new AssistantSessionManager();

