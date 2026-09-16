export const DAY = 86_400_000;
export const dateKey = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
export const parseDate = (value) => new Date(`${value}T12:00:00`);
export const addDays = (value, amount) => { const day = parseDate(value); day.setDate(day.getDate() + amount); return dateKey(day); };

export function isScheduledOn(habit, day) {
  // Archiving stops a habit from appearing in today's workflow, but must not
  // erase its past schedule when calculating retained historical analytics.
  if (habit.deleted_at) return false;
  if (habit.schedule_type === 'daily') return true;
  if (habit.schedule_type === 'weekdays') return (habit.scheduled_weekdays || []).includes(parseDate(day).getDay());
  const rule = habit.custom_schedule || {};
  if (rule.kind === 'dates') return (rule.dates || []).includes(day);
  if (rule.kind === 'interval' && rule.anchorDate && Number(rule.every) > 0) {
    return Math.round((parseDate(day) - parseDate(rule.anchorDate)) / DAY) % Number(rule.every) === 0;
  }
  return false;
}

export function entryCompletion(habit, entry) {
  if (!entry || entry.deleted_at) return false;
  if (habit.habit_type === 'quantity') return Number(entry.quantity || 0) >= Number(habit.target_quantity);
  return entry.status === 'completed';
}

export function effectiveStatus(habit, entry) {
  if (entryCompletion(habit, entry)) return 'completed';
  if (entry?.status === 'missed') return 'missed';
  return 'pending';
}

export function habitStreaks(habit, entries, through = dateKey()) {
  const byDay = new Map(entries.filter((entry) => !entry.deleted_at).map((entry) => [entry.entry_date, entry]));
  const start = habit.created_at ? dateKey(new Date(habit.created_at)) : through;
  const scheduled = [];
  for (let day = start; day <= through; day = addDays(day, 1)) if (isScheduledOn(habit, day)) scheduled.push(day);
  let longest = 0; let currentRun = 0; let current = 0;
  for (const day of scheduled) {
    if (entryCompletion(habit, byDay.get(day))) { currentRun += 1; longest = Math.max(longest, currentRun); }
    else currentRun = 0;
  }
  for (let index = scheduled.length - 1; index >= 0; index -= 1) {
    const day = scheduled[index];
    if (day > through) continue;
    if (entryCompletion(habit, byDay.get(day))) current += 1;
    else break;
  }
  return { current, longest, scheduledDays: scheduled.length, completedDays: scheduled.filter((day) => entryCompletion(habit, byDay.get(day))).length };
}

export function habitAnalytics(habits, entries, through = dateKey()) {
  const active = habits.filter((habit) => !habit.deleted_at && !habit.is_archived);
  const today = active.filter((habit) => isScheduledOn(habit, through));
  const complete = today.filter((habit) => entryCompletion(habit, entries.find((entry) => entry.habit_id === habit.id && entry.entry_date === through)));
  const streaks = active.map((habit) => habitStreaks(habit, entries.filter((entry) => entry.habit_id === habit.id), through));
  return { todayTotal: today.length, todayCompleted: complete.length, todayPercent: today.length ? Math.round(complete.length / today.length * 100) : 0, longestStreak: Math.max(0, ...streaks.map((item) => item.longest)) };
}
