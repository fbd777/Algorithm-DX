/**
 * Phase 3 Dashboard 的开发/测试夹具。
 *
 * 这是**假数据**，只用于在没有真实提交时验证界面与统计口径。
 * 安全约束：固定写入 data/dashboard-fixture.sqlite（可用 --db 覆盖），
 * 并且显式拒绝写到真实练习库 data/algorithm-dx.sqlite。
 *
 * 用法：npm run dashboard:fixture
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, Repository } from '../src/db/database.ts';
import type { Submission, SubmissionStatus } from '../src/domain.ts';

const REAL_DB = resolve('data/algorithm-dx.sqlite');
const DEFAULT_FIXTURE = 'data/dashboard-fixture.sqlite';

const DAY = 86400;
const BASE = Date.UTC(2026, 2, 1, 12, 0, 0) / 1000; // 2026-03-01T12:00:00Z

interface Draft {
  platform: string;
  account: number;
  problemId: string;
  title: string;
  url: string;
  difficulty?: number;
  tags?: string[];
  verdicts: [SubmissionStatus, number, number | null, number | null][]; // status, dayOffset, execTime ms, memory bytes
  language?: string;
}

function submission(draft: Draft, index: number, [status, dayOffset, time, memory]: [SubmissionStatus, number, number | null, number | null]): Submission {
  return {
    platform: draft.platform,
    submission_id: `${draft.problemId}-${index}`,
    problem_id: draft.problemId,
    problem_title: draft.title,
    problem_url: draft.url,
    difficulty: draft.difficulty ?? null,
    tags: draft.tags ?? [],
    status,
    raw_status: status === 'AC' ? 'OK' : status === 'PENDING' ? null : `WRONG_ANSWER`,
    language: draft.language ?? 'GNU C++20',
    execution_time: time,
    memory,
    submitted_at: BASE + dayOffset * DAY,
  };
}

const drafts: Draft[] = [
  {
    platform: 'codeforces', account: 1, problemId: '1000A', title: 'Theatre Square',
    url: 'https://codeforces.com/contest/1/problem/A', difficulty: 1000, tags: ['math'],
    verdicts: [['WA', 0, 31, 262144], ['TLE', 0, 2000, 262144], ['AC', 0, 15, 262144]],
  },
  {
    platform: 'codeforces', account: 1, problemId: '1001B', title: 'Spreadsheets',
    url: 'https://codeforces.com/contest/1/problem/B', difficulty: 1100, tags: ['implementation'],
    verdicts: [['WA', 1, 46, 524288], ['RE', 3, 62, 786432]],
  },
  {
    platform: 'codeforces', account: 1, problemId: '1002C', title: 'Ancient Berland Circus',
    url: 'https://codeforces.com/contest/1/problem/C', difficulty: 1600, tags: ['geometry'],
    verdicts: [['AC', 4, 121, 393216], ['AC', 6, 98, 393216]],
  },
  {
    platform: 'codeforces', account: 1, problemId: '1003D', title: 'Longest k-Good Segment',
    url: 'https://codeforces.com/problemset/problem/616/D', difficulty: 1400, tags: ['two pointers'],
    verdicts: [['AC', 9, 187, 1048576]],
  },
  {
    platform: 'leetcode-cn', account: 2, problemId: 'two-sum', title: '两数之和',
    url: 'https://leetcode.cn/problems/two-sum/', difficulty: null, tags: ['array', 'hash-table'],
    verdicts: [['AC', 2, 60, 41943040], ['AC', 5, 52, 41943040]], language: 'TypeScript',
  },
  {
    platform: 'leetcode-cn', account: 2, problemId: 'median-of-two-sorted-arrays', title: '寻找两个正序数组的中位数',
    url: 'https://leetcode.cn/problems/median-of-two-sorted-arrays/', difficulty: null, tags: ['binary search'],
    verdicts: [['WA', 6, 88, 41943040], ['WA', 6, 91, 41943040], ['WA', 7, 74, 41943040], ['CE', 7, null, null]],
    language: 'TypeScript',
  },
  {
    platform: 'atcoder', account: 3, problemId: 'abc300_a', title: 'N-choice question',
    url: 'https://atcoder.jp/contests/abc300/tasks/abc300_a', difficulty: 100, tags: ['implementation'],
    verdicts: [['AC', 8, 2, 1024]],
  },
  {
    platform: 'atcoder', account: 3, problemId: 'abc300_d', title: 'AABCC',
    url: 'https://atcoder.jp/contests/abc300/tasks/abc300_d', difficulty: 800, tags: ['math', 'binary search'],
    verdicts: [['WA', 10, 3, 2048], ['TLE', 11, 2000, 2048], ['AC', 12, 5, 2048]],
  },
  {
    platform: 'luogu', account: 4, problemId: 'P1001', title: 'A+B Problem',
    url: 'https://www.luogu.com.cn/problem/P1001', difficulty: 1, tags: ['入门'],
    verdicts: [['AC', 13, 12, 3096576]], language: 'C++14',
  },
  {
    platform: 'luogu', account: 4, problemId: 'P1002', title: '过河卒',
    url: 'https://www.luogu.com.cn/problem/P1002', difficulty: 2, tags: ['动态规划'],
    verdicts: [['WA', 14, 25, 3096576], ['WA', 15, 22, 3096576]],
    language: 'C++14',
  },
  {
    platform: 'matiji', account: 5, problemId: 'mt-100', title: '码蹄集示例题',
    url: 'https://www.matiji.net/exam/oj', difficulty: null, tags: [],
    verdicts: [['AC', 20, 55, 2097152], ['PENDING', 22, null, null]],
  },
];

function main(): void {
  const argv = process.argv.slice(2);
  let target = DEFAULT_FIXTURE;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') {
      const value = argv[++i];
      if (!value) throw new Error('--db 缺少路径');
      target = value;
    } else throw new Error(`未知参数：${argv[i]}`);
  }

  const dbPath = resolve(target);
  if (dbPath === REAL_DB) {
    console.error('拒绝执行：夹具不允许写入真实练习库 data/algorithm-dx.sqlite。');
    process.exit(1);
  }
  if (['', '-wal', '-shm'].some(suffix => existsSync(dbPath + suffix))) {
    throw new Error('目标数据库已存在；请使用 --db 指定新的夹具文件，避免覆盖本地数据。');
  }

  const db = openDatabase(dbPath);
  try {
    const repo = new Repository(db);
    const me = repo.createUser('我', true);
    const friend = repo.createUser('好友');
    const accounts: Record<string, number> = {
      codeforces: repo.addAccount(me, 'codeforces', 'demo_cf'),
      'leetcode-cn': repo.addAccount(me, 'leetcode-cn', 'demo-lc'),
      atcoder: repo.addAccount(friend, 'atcoder', 'friend_ac'),
      luogu: repo.addAccount(me, 'luogu', '123456'),
      matiji: repo.addAccount(me, 'matiji', 'demo-mt'),
    };

    const byAccount = new Map<number, Submission[]>();
    for (const draft of drafts) {
      const list = byAccount.get(draft.account) ?? [];
      draft.verdicts.forEach((verdict, index) => list.push(submission(draft, index + 1, verdict)));
      byAccount.set(draft.account, list);
    }

    let stored = 0;
    let accountIndex = 0;
    for (const platform of ['codeforces', 'leetcode-cn', 'atcoder', 'luogu', 'matiji']) {
      accountIndex += 1;
      const rows = byAccount.get(accountIndex);
      if (!rows) continue;
      repo.saveSubmissions(accounts[platform], rows);
      stored += rows.length;
    }

    console.log(`夹具已生成：${dbPath}`);
    console.log(`  用户 2 人、账号 ${Object.keys(accounts).length} 个、提交 ${stored} 条。`);
    console.log('  这是假数据，仅用于开发与测试，请不要与真实练习数据混用。');
  } finally {
    db.close();
  }
}

main();
