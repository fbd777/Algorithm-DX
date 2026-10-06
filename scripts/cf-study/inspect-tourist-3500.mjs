// Read-only audit of official API snapshots already cached by the study.
// Does not treat time between ACs as measured time spent on a problem.
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { hash } from './core.mjs';

const handle = 'tourist';
const root = path.resolve('data/cf-study');
const out = path.resolve(process.argv[2] ?? 'results/tourist-3500');
const sources = [];
async function read(method, params = {}) {
  const base = path.join(root, 'raw', method, hash(method + '?' + new URLSearchParams(params)) + '.json');
  let bytes, file = base;
  try { bytes = await fs.readFile(file); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    file += '.gz'; bytes = gunzipSync(await fs.readFile(file));
  }
  const envelope = JSON.parse(bytes);
  if (envelope.status !== 'OK') throw new Error('Bad snapshot: ' + file);
  sources.push({ method, params, file, source: envelope.source, fetchedAt: envelope.fetchedAt });
  return envelope.result;
}

const problems = await read('problemset.problems');
const hard = new Map(problems.problems.filter(p => p.rating === 3500).map(p => [`${p.contestId}:${p.index}`, p]));
const hardContests = new Set([...hard.values()].map(p => p.contestId));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
const rows = [], timelines = [], skipped = [];
const formal = s => s.author?.participantType === 'CONTESTANT' && s.author.members?.length === 1 &&
  s.author.members[0].handle.toLowerCase() === handle;
for (const c of manifest.contests) {
  if (!hardContests.has(c.id)) continue;
  const standings = await read('contest.standings', { contestId: c.id });
  const contestant = standings.rows.find(r => r.party.participantType === 'CONTESTANT' &&
    r.party.members.length === 1 && r.party.members[0].handle.toLowerCase() === handle);
  if (!contestant) continue;
  const targets = standings.problems.filter((p, i) => hard.has(`${c.id}:${p.index}`) && contestant.problemResults[i].points > 0);
  if (!targets.length) continue;
  const contest = standings.contest;
  const status = await read('contest.status', { contestId: c.id });
  const subs = status.filter(s => formal(s) && s.contestId === c.id &&
    s.creationTimeSeconds >= contest.startTimeSeconds && s.creationTimeSeconds <= contest.startTimeSeconds + contest.durationSeconds)
    .sort((a, b) => a.creationTimeSeconds - b.creationTimeSeconds || a.id - b.id);
  const firstAc = new Map();
  for (const s of subs) if (s.verdict === 'OK' && !firstAc.has(s.problem.index)) firstAc.set(s.problem.index, s);
  let oldRating = null;
  try { oldRating = (await read('contest.ratingChanges', { contestId: c.id })).find(r => r.handle.toLowerCase() === handle)?.oldRating ?? null; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const relative = s => s.creationTimeSeconds - contest.startTimeSeconds;
  timelines.push({ contestId: c.id, contestStart: contest.startTimeSeconds, duration: contest.durationSeconds,
    submissions: subs.map(s => ({ id: s.id, problem: s.problem.index, secondsFromStart: relative(s), verdict: s.verdict })) });
  for (const p of targets) {
    const ac = firstAc.get(p.index);
    if (!ac) { skipped.push({ contestId: c.id, problem: p.index, reason: 'Standings success but no matching final OK in cached status' }); continue; }
    const earlierAcs = [...firstAc.values()].filter(s => s.creationTimeSeconds < ac.creationTimeSeconds);
    const previous = earlierAcs.sort((a, b) => b.creationTimeSeconds - a.creationTimeSeconds)[0];
    const start = previous?.creationTimeSeconds ?? contest.startTimeSeconds;
    const own = subs.filter(s => s.problem.index === p.index && s.creationTimeSeconds <= ac.creationTimeSeconds);
    const other = subs.filter(s => s.problem.index !== p.index && s.creationTimeSeconds > start && s.creationTimeSeconds < ac.creationTimeSeconds);
    const stem = p.index.replace(/\d+$/, '');
    const earlierSibling = earlierAcs.filter(s => s.problem.index.replace(/\d+$/, '') === stem).map(s => s.problem.index);
    const ratingProblem = hard.get(`${c.id}:${p.index}`);
    const fromStart = relative(ac);
    rows.push({ contestId: c.id, contestName: contest.name,
      dateUtc: new Date(contest.startTimeSeconds * 1000).toISOString().slice(0, 10),
      problem: p.index, problemName: ratingProblem.name, problemRatingSnapshot: ratingProblem.rating, oldRating,
      submissionId: ac.id, secondsFromContestStart: fromStart,
      previousAcProblem: previous?.problem.index ?? null,
      previousAcSecondsFromStart: previous ? relative(previous) : 0,
      secondsSincePreviousAc: ac.creationTimeSeconds - start,
      firstSubmissionSecondsFromStart: relative(own[0]),
      secondsFirstSubmissionToAc: ac.creationTimeSeconds - own[0].creationTimeSeconds,
      attemptsThroughAc: own.length,
      otherProblemSubmissionsInInterval: other.map(s => ({ problem: s.problem.index, seconds: relative(s), verdict: s.verdict })),
      targetSubmittedBeforePreviousAc: own[0].creationTimeSeconds < start,
      earlierAcceptedSiblingProblems: earlierSibling,
      problemUrl: `https://codeforces.com/problemset/problem/${c.id}/${p.index}`,
      submissionUrl: `https://codeforces.com/contest/${c.id}/submission/${ac.id}`,
      timelineUrl: `https://codeforces.com/submissions/${handle}/contest/${c.id}`,
    });
  }
}
rows.sort((a, b) => b.dateUtc.localeCompare(a.dateUtc) || a.secondsFromContestStart - b.secondsFromContestStart);
const clean = rows.filter(r => !r.otherProblemSubmissionsInInterval.length && !r.targetSubmittedBeforePreviousAc && !r.earlierAcceptedSiblingProblems.length);
const median = xs => { const s = [...xs].sort((a,b) => a-b); return s.length ? (s[Math.floor((s.length-1)/2)] + s[Math.floor(s.length/2)])/2 : null; };
const result = { handle, selection: 'Formal solo participation; problem rating exactly 3500 in cached problemset; first final OK submitted within contest duration; only study-cached contests examined.',
  limitations: ['Cached study contests are not all tourist contests.', 'Problem ratings are snapshot ratings, not necessarily ratings at contest time.', 'Time since previous AC is a proxy, not actual read-to-AC duration; silent interleaving cannot be observed.', 'Hard variants may reuse work from earlier easy variants.', 'One player with varying pre-contest rating cannot determine T97 for all 3500-rated players.'],
  count: rows.length, heuristicCleanCount: clean.length,
  heuristicCleanMedianSeconds: median(clean.map(r => r.secondsSincePreviousAc)),
  rows, skipped, timelines, sources };
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'tourist-3500.json'), JSON.stringify(result, null, 2) + '\n');
const clock = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
for (const r of rows) console.log(JSON.stringify({ date:r.dateUtc, problem:`${r.contestId}${r.problem}`, name:r.problemName, oldRating:r.oldRating, fromStart:clock(r.secondsFromContestStart), previous:r.previousAcProblem,
  interval:clock(r.secondsSincePreviousAc), submission:r.submissionId, early:r.targetSubmittedBeforePreviousAc, interleaved:r.otherProblemSubmissionsInInterval.length, siblings:r.earlierAcceptedSiblingProblems }));
console.log(JSON.stringify({ count: result.count, clean: clean.length, cleanMedian: clock(result.heuristicCleanMedianSeconds), skipped }));
