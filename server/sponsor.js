// Per-account accounting of gas the relayer has sponsored (also used for the daily cap).
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

export function sponsorship(store, account, now = Date.now()) {
  const rec = store.data.sponsored?.[account];
  if (!rec) return { day: dayOf(now), calls_today: 0, total_calls: 0, total_near: 0 };
  return { day: dayOf(now), calls_today: rec.day === dayOf(now) ? rec.calls : 0, total_calls: rec.total_calls, total_near: rec.total_near };
}

export function recordSponsored(store, account, feeNear, now = Date.now()) {
  store.data.sponsored ||= {};
  const day = dayOf(now);
  const rec = store.data.sponsored[account] || { day, calls: 0, total_calls: 0, total_near: 0 };
  if (rec.day !== day) { rec.day = day; rec.calls = 0; }
  rec.calls += 1;
  rec.total_calls += 1;
  rec.total_near = Number((rec.total_near + feeNear).toFixed(6));
  store.data.sponsored[account] = rec;
  store.save();
}
