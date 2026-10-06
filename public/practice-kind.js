// Compare against the start of this attempt, not the number of AC submissions.
export function inferPracticeKind(items, endedAt, seconds) {
  if (!Number.isFinite(endedAt) || !Number.isFinite(seconds) || seconds <= 0) return 'unknown';
  const startedAt = endedAt - seconds;
  return items.some(row => row.status === 'AC' && Number.isFinite(row.submitted_at)
    && row.submitted_at < startedAt) ? 'repeat' : 'unknown';
}
