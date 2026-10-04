/** Calendar-day helpers in a business's own time zone (the server runs in UTC, so "today" must not use server time). */
const DAY = 24 * 60 * 60 * 1000;

function validZone(tz) {
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

/** The calendar date (YYYY-MM-DD) of an instant in the zone. */
function dateKey(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: validZone(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
}

/** How far the zone is ahead of UTC at that instant, in milliseconds. */
function offsetMs(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: validZone(tz), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(new Date(date).getTime() / 1000) * 1000;
}

/** The instant the zone's calendar day containing `date` began. */
function startOfDay(date, tz) {
  const [y, m, d] = dateKey(date, tz).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // the offset can differ at the start of the day (daylight saving), so settle it from the first guess
  let start = guess - offsetMs(new Date(guess), tz);
  start = guess - offsetMs(new Date(start), tz);
  return new Date(start);
}

module.exports = { dateKey, startOfDay, offsetMs, validZone, DAY };
