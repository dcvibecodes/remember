'use strict';

// Shared repeat-rule + timezone math for recurring reminders.
//
// A repeat rule is stored as the string 'none', or as JSON:
//   { type: 'daily'|'weekly'|'monthly'|'yearly'|'custom',
//     interval: N,                 // default 1; custom requires >= 1
//     unit: 'days'|'weeks'|'months', // custom only
//     anchorDay: 1-31,             // monthly/yearly/custom-months: day-of-month to aim for
//     anchorMonth: 1-12 }          // yearly only
//
// MONTH-EDGE POLICY (acceptance requirement): a monthly series anchored on the
// 31st clamps to the last day of short months (Feb 28/29, Apr 30, ...) and then
// returns to the anchor day (31st) the next month. The anchor is stored in the
// rule, so late completion never drifts the series. Yearly Feb 29 clamps to
// Feb 28 in non-leap years for the same reason.
//
// Time models: 'fixed' (absolute UTC instant), 'floating' ("6pm wherever I
// am", computed in the last-synced device zone), 'anchored' ("6pm in a fixed
// zone"). Pass zone=null for fixed (UTC calendar math); otherwise an IANA zone
// name for wall-clock math. Existing reminders keep model 'fixed'.

const REPEAT_TYPES = ['none', 'daily', 'weekly', 'monthly', 'yearly', 'custom'];
const CUSTOM_UNITS = ['days', 'weeks', 'months'];

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  throw err;
}

// ---------- timezones ----------

function isValidTimeZone(zone) {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock fields of an instant in a zone: { y, mo (1-12), d, h, mi }.
function instantToWall(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    y: Number(get('year')),
    mo: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour')) % 24,
    mi: Number(get('minute')),
  };
}

// Offset (ms) of a zone at a given instant, via the classic format-roundtrip.
function zoneOffsetMs(zone, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  const asUTC = Date.UTC(
    Number(get('year')), Number(get('month')) - 1, Number(get('day')),
    Number(get('hour')) % 24, Number(get('minute')), Number(get('second'))
  );
  return asUTC - Math.floor(ms / 1000) * 1000;
}

// Resolve wall-clock fields in a zone back to an instant. Handles DST gaps by
// stepping forward (a nonexistent 2:30am becomes ~3:00am) and ambiguous times
// by settling on the earlier offset.
function wallToInstant(zone, w) {
  const target = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let t = target - zoneOffsetMs(zone, target);
  for (let i = 0; i < 4; i += 1) {
    const off = zoneOffsetMs(zone, t);
    const next = target - off;
    if (next === t) break;
    t = next;
  }
  const check = instantToWall(t, zone);
  if (check.y !== w.y || check.mo !== w.mo || check.d !== w.d || check.h !== w.h || check.mi !== w.mi) {
    // Fell in a DST gap: step forward until the wall clock matches again.
    for (let i = 0; i < 12; i += 1) {
      t += 15 * 60 * 1000;
      const c = instantToWall(t, zone);
      if (c.y === w.y && c.mo === w.mo && c.d === w.d && c.h === w.h && c.mi === w.mi) break;
    }
  }
  return new Date(t).toISOString();
}

function daysInMonth(y, mo1) {
  return new Date(Date.UTC(y, mo1, 0)).getUTCDate();
}

// ---------- repeat rules ----------

function parseRepeatRule(value) {
  if (value === undefined || value === null || value === '' || value === 'none') {
    return { type: 'none' };
  }
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase();
    if (['daily', 'weekly', 'monthly', 'yearly'].includes(word)) {
      return { type: word, interval: 1 };
    }
    try {
      return parseRepeatRule(JSON.parse(value));
    } catch {
      return bad('Invalid repeat rule');
    }
  }
  if (typeof value !== 'object') return bad('Invalid repeat rule');
  const type = String(value.type || 'none').toLowerCase();
  if (type === 'none') return { type: 'none' };
  if (!REPEAT_TYPES.includes(type)) return bad('Invalid repeat rule');
  const interval = value.interval === undefined ? 1 : Number(value.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 366) {
    return bad('Repeat interval must be a whole number from 1 to 366');
  }
  const rule = { type, interval };
  if (type === 'custom') {
    const unit = String(value.unit || 'days').toLowerCase();
    if (!CUSTOM_UNITS.includes(unit)) return bad('Custom repeat unit must be days, weeks, or months');
    rule.unit = unit;
  }
  if (value.anchorDay !== undefined) {
    const anchorDay = Number(value.anchorDay);
    if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) return bad('Invalid repeat anchor day');
    rule.anchorDay = anchorDay;
  }
  if (value.anchorMonth !== undefined) {
    const anchorMonth = Number(value.anchorMonth);
    if (!Number.isInteger(anchorMonth) || anchorMonth < 1 || anchorMonth > 12) return bad('Invalid repeat anchor month');
    rule.anchorMonth = anchorMonth;
  }
  return rule;
}

function encodeRepeatRule(rule) {
  if (!rule || rule.type === 'none') return 'none';
  return JSON.stringify(rule);
}

function ruleLabel(rule) {
  if (!rule || rule.type === 'none') return 'Does not repeat';
  const n = rule.interval || 1;
  switch (rule.type) {
    case 'daily': return n === 1 ? 'Daily' : `Every ${n} days`;
    case 'weekly': return n === 1 ? 'Weekly' : `Every ${n} weeks`;
    case 'monthly': return n === 1 ? 'Monthly' : `Every ${n} months`;
    case 'yearly': return n === 1 ? 'Yearly' : `Every ${n} years`;
    case 'custom': {
      const unit = rule.unit === 'weeks' ? 'week' : rule.unit === 'months' ? 'month' : 'day';
      return n === 1 ? `Daily-equivalent (${unit})` : `Every ${n} ${unit}s`;
    }
    default: return 'Repeats';
  }
}

function isRecurringRule(rule) {
  return Boolean(rule && rule.type && rule.type !== 'none');
}

// Fill anchorDay/anchorMonth from the series start date, in the effective zone.
function anchorRule(rule, dueISO, zone) {
  const out = { ...rule };
  const needsDay = rule.type === 'monthly' || rule.type === 'yearly'
    || (rule.type === 'custom' && rule.unit === 'months');
  if (needsDay && out.anchorDay === undefined) {
    const w = zone ? instantToWall(new Date(dueISO).getTime(), zone) : null;
    const d = new Date(dueISO);
    out.anchorDay = zone ? w.d : d.getUTCDate();
  }
  if (rule.type === 'yearly' && out.anchorMonth === undefined) {
    const w = zone ? instantToWall(new Date(dueISO).getTime(), zone) : null;
    const d = new Date(dueISO);
    out.anchorMonth = zone ? w.mo : d.getUTCMonth() + 1;
  }
  return out;
}

// One step forward from a scheduled occurrence. The anchor in the rule keeps
// monthly/yearly series on their original day-of-month (clamped in short
// months), so late completion never drifts the schedule.
function advanceOccurrence(rule, fromISO, zone) {
  const from = new Date(fromISO).getTime();
  if (Number.isNaN(from)) bad('Invalid date');
  const interval = rule.interval || 1;

  if (!zone) {
    const d = new Date(from);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const h = d.getUTCHours();
    const mi = d.getUTCMinutes();
    const at = (yy, mm, dd) => new Date(Date.UTC(yy, mm - 1, dd, h, mi)).toISOString();
    if (rule.type === 'daily' || (rule.type === 'custom' && rule.unit === 'days')) {
      return at(y, mo, day + interval);
    }
    if (rule.type === 'weekly' || (rule.type === 'custom' && rule.unit === 'weeks')) {
      return at(y, mo, day + 7 * interval);
    }
    if (rule.type === 'monthly' || (rule.type === 'custom' && rule.unit === 'months')) {
      const total = (y * 12 + (mo - 1)) + interval;
      const ny = Math.floor(total / 12);
      const nm = (total % 12) + 1;
      return at(ny, nm, Math.min(rule.anchorDay ?? day, daysInMonth(ny, nm)));
    }
    if (rule.type === 'yearly') {
      const ny = y + interval;
      const nm = rule.anchorMonth ?? mo;
      return at(ny, nm, Math.min(rule.anchorDay ?? day, daysInMonth(ny, nm)));
    }
    return bad('Invalid repeat rule');
  }

  const w = instantToWall(from, zone);
  const at = (parts) => wallToInstant(zone, { ...parts, h: w.h, mi: w.mi });
  if (rule.type === 'daily' || (rule.type === 'custom' && rule.unit === 'days')) {
    return at({ y: w.y, mo: w.mo, d: w.d + interval });
  }
  if (rule.type === 'weekly' || (rule.type === 'custom' && rule.unit === 'weeks')) {
    return at({ y: w.y, mo: w.mo, d: w.d + 7 * interval });
  }
  if (rule.type === 'monthly' || (rule.type === 'custom' && rule.unit === 'months')) {
    const total = (w.y * 12 + (w.mo - 1)) + interval;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return at({ y: ny, mo: nm, d: Math.min(rule.anchorDay ?? w.d, daysInMonth(ny, nm)) });
  }
  if (rule.type === 'yearly') {
    const ny = w.y + interval;
    const nm = rule.anchorMonth ?? w.mo;
    return at({ y: ny, mo: nm, d: Math.min(rule.anchorDay ?? w.d, daysInMonth(ny, nm)) });
  }
  return bad('Invalid repeat rule');
}

// First scheduled occurrence strictly after `now`, advancing from the
// SCHEDULED time (never from the completion time), so late completion keeps
// the original rhythm with no drift. Already-past occurrences are skipped.
function firstFutureOccurrence(rule, fromISO, zone, nowISO) {
  if (!isRecurringRule(rule)) return null;
  const now = new Date(nowISO || new Date().toISOString()).getTime();
  let candidate = advanceOccurrence(rule, fromISO, zone);
  let guard = 0;
  while (new Date(candidate).getTime() <= now) {
    candidate = advanceOccurrence(rule, candidate, zone);
    guard += 1;
    if (guard > 10000) bad('Repeat rule did not reach a future date');
  }
  return candidate;
}

// Keep a wall-clock time but move it into a new zone ("6pm wherever I am").
// Used when the device reports a new timezone for floating reminders.
function recomputeInZone(dueISO, fromZone, toZone) {
  const w = instantToWall(new Date(dueISO).getTime(), fromZone);
  return wallToInstant(toZone, w);
}

// ---------- natural-language repeat detection ----------
// PWA reality check: chrono gives us the date; recurrence keywords are matched
// here with plain regexes so the rule model stays dependency-free.

const REPEAT_PATTERNS = [
  { re: /\bevery\s+(\d{1,3})\s+(days?|weeks?|months?)\b/i, custom: true },
  { re: /\b(daily|every\s+day|each\s+day)\b/i, type: 'daily' },
  { re: /\b(weekly|every\s+week|each\s+week)\b/i, type: 'weekly' },
  { re: /\b(monthly|every\s+month|each\s+month)\b/i, type: 'monthly' },
  { re: /\b(yearly|every\s+year|each\s+year)\b/i, type: 'yearly' },
];

function detectRepeat(text) {
  const input = String(text || '');
  for (const pattern of REPEAT_PATTERNS) {
    const match = input.match(pattern.re);
    if (!match) continue;
    let rule;
    if (pattern.custom) {
      const interval = Number(match[1]);
      const word = match[2].toLowerCase();
      const unit = word.startsWith('day') ? 'days' : word.startsWith('week') ? 'weeks' : 'months';
      if (!Number.isInteger(interval) || interval < 1 || interval > 366) continue;
      rule = { type: 'custom', interval, unit };
    } else {
      rule = { type: pattern.type, interval: 1 };
    }
    const cleaned = input.replace(match[0], ' ').replace(/\s{2,}/g, ' ').replace(/[\s,;]+$/, '').trim();
    return { rule, cleaned };
  }
  return { rule: { type: 'none' }, cleaned: input.trim() };
}

// Bare day-of-month phrases chrono won't touch ("on the 31st", "the 10th").
// Returns the day plus the text with the phrase removed, or null.
function detectMonthDay(text) {
  const input = String(text || '');
  const match = input.match(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i);
  if (!match) return null;
  const day = Number(match[1]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const cleaned = input.replace(match[0], ' ').replace(/\s{2,}/g, ' ').replace(/[\s,;]+$/, '').trim();
  return { day, cleaned };
}

// Resolve a day-of-month to the upcoming calendar date in a zone.
function upcomingMonthDay(day, zone, nowMs) {
  const w = instantToWall(nowMs, zone);
  let y = w.y;
  let mo = w.mo;
  if (day < w.d || day > daysInMonth(y, mo)) {
    mo += 1;
    if (mo > 12) { mo = 1; y += 1; }
  }
  const d = Math.min(day, daysInMonth(y, mo));
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

module.exports = {
  REPEAT_TYPES,
  parseRepeatRule,
  encodeRepeatRule,
  ruleLabel,
  isRecurringRule,
  anchorRule,
  advanceOccurrence,
  firstFutureOccurrence,
  recomputeInZone,
  detectRepeat,
  detectMonthDay,
  upcomingMonthDay,
  isValidTimeZone,
  instantToWall,
  wallToInstant,
};