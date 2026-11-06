const formatterCache = new Map();

function getZonedPartsFormatter(timeZone) {
  if (!timeZone) return null;
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      })
    );
  }
  return formatterCache.get(timeZone);
}

export function validateIanaTimeZone(raw) {
  const tz = String(raw || "").trim();
  if (!tz) return "";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return "";
  }
}

export function getZonedCalendarParts(date, timeZone) {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes()
    };
  }
  const formatter = getZonedPartsFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const read = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? Number.parseInt(p.value, 10) : NaN;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute")
  };
}

export function getLocalDateKey(date, timeZone) {
  const { year, month, day } = getZonedCalendarParts(date, timeZone);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    const fallback = new Date(date);
    return `${fallback.getFullYear()}-${String(fallback.getMonth() + 1).padStart(2, "0")}-${String(
      fallback.getDate()
    ).padStart(2, "0")}`;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getMinutesOfDayInZone(date, timeZone) {
  const { hour, minute } = getZonedCalendarParts(date, timeZone);
  return hour * 60 + minute;
}

export function isSameZonedCalendarDay(a, b, timeZone) {
  return getLocalDateKey(a, timeZone) === getLocalDateKey(b, timeZone);
}

export function buildPauseRangeEndAt(now, startMinutes, endMinutes, timeZone) {
  const cross = startMinutes > endMinutes;
  const inPause = (m) =>
    cross ? m >= startMinutes || m < endMinutes : m >= startMinutes && m < endMinutes;

  let t = new Date(now);
  t.setMilliseconds(0);
  for (let i = 0; i < 25 * 60; i += 1) {
    const m = getMinutesOfDayInZone(t, timeZone);
    if (!inPause(m)) {
      return t;
    }
    t = new Date(t.getTime() + 60 * 1000);
  }
  return t;
}

/** Oldest calendar date key (YYYY-MM-DD) to keep when retaining `keepDays` days ending at `todayKey`. */
export function oldestKeptDateKey(todayKey, keepDays) {
  const keep = Math.max(1, Number(keepDays) || 1);
  const [y, m, d] = todayKey.split("-").map((v) => Number.parseInt(v, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return todayKey;
  }
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - (keep - 1));
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
