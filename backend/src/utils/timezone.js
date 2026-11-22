/**
 * Timezone utilities for clinic schedule calculation
 * Pure native Intl.DateTimeFormat implementation without heavy external libraries.
 */

/**
 * Convert a local date string (YYYY-MM-DD) and time string (HH:mm or HH:mm:ss)
 * in a specified IANA timezone (e.g. 'Asia/Kolkata', 'America/New_York') to a UTC Date object.
 *
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @param {string} timeStr - 'HH:mm' or 'HH:mm:ss'
 * @param {string} timeZone - IANA timezone string
 * @returns {Date} UTC Date object
 */
function localToUtc(dateStr, timeStr, timeZone = 'UTC') {
  if (!dateStr) return new Date();
  const safeTime = (timeStr || '00:00:00').trim();
  const [y, m, d] = dateStr.split('-').map(Number);
  const timeParts = safeTime.split(':').map(Number);
  const h = timeParts[0] || 0;
  const min = timeParts[1] || 0;
  const s = timeParts[2] || 0;

  // Approximate UTC instant
  const utcCandidate = new Date(Date.UTC(y, m - 1, d, h, min, s));

  // Determine actual local time parts rendered by this UTC instant in the target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = formatter.formatToParts(utcCandidate);
  const partMap = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const localY = parseInt(partMap.year, 10);
  const localM = parseInt(partMap.month, 10);
  const localD = parseInt(partMap.day, 10);
  const localH = parseInt(partMap.hour === '24' ? '0' : partMap.hour, 10);
  const localMin = parseInt(partMap.minute, 10);
  const localSec = parseInt(partMap.second, 10);

  const renderedLocalAsUtc = Date.UTC(localY, localM - 1, localD, localH, localMin, localSec);
  const offsetMs = renderedLocalAsUtc - utcCandidate.getTime();

  return new Date(utcCandidate.getTime() - offsetMs);
}

/**
 * Get weekday integer (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
 * for a given dateStr (YYYY-MM-DD) in the specified IANA timezone.
 *
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @param {string} timeZone - IANA timezone
 * @returns {number} Weekday (0-6)
 */
function getWeekdayInTimezone(dateStr, timeZone = 'UTC') {
  // Use noon local time to avoid midnight edge issues and daylight saving shifts
  const utcDate = localToUtc(dateStr, '12:00:00', timeZone);
  const dayStr = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(utcDate);

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days.indexOf(dayStr);
}

/**
 * Format a UTC Date object into a readable 12-hour time label (e.g. '10:30 AM')
 * in the specified IANA timezone.
 *
 * @param {Date|string} date - UTC Date or ISO string
 * @param {string} timeZone - IANA timezone
 * @returns {string} e.g. '10:30 AM'
 */
function formatTimeInTimezone(date, timeZone = 'UTC') {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

/**
 * Format a UTC Date object into a 24-hour time string (e.g. '10:30')
 * in the specified IANA timezone.
 *
 * @param {Date|string} date - UTC Date or ISO string
 * @param {string} timeZone - IANA timezone
 * @returns {string} e.g. '10:30'
 */
function format24hTimeInTimezone(date, timeZone = 'UTC') {
  const d = typeof date === 'string' ? new Date(date) : date;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const h = parts.find((p) => p.type === 'hour')?.value || '00';
  const min = parts.find((p) => p.type === 'minute')?.value || '00';
  return `${h === '24' ? '00' : h}:${min}`;
}

/**
 * Format a Date to YYYY-MM-DD in the specified timezone
 *
 * @param {Date|string} date - Date object or ISO string
 * @param {string} timeZone - IANA timezone
 * @returns {string} 'YYYY-MM-DD'
 */
function formatDateInTimezone(date, timeZone = 'UTC') {
  const d = typeof date === 'string' ? new Date(date) : date;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);

  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

module.exports = {
  localToUtc,
  getWeekdayInTimezone,
  formatTimeInTimezone,
  format24hTimeInTimezone,
  formatDateInTimezone,
};

