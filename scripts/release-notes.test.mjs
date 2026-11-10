import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { releaseNotes, toMarkdown } from './release-notes.ts';

test('release notes: after one version up to another, by day, newest first, a merge listing its branch', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'purss-notes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (args, date) => execFileSync('git', ['-C', dir, ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  const commit = (s, date) => git(['commit', '-q', '--allow-empty', '-m', s], date);
  git(['init', '-q', '-b', 'main'], '2026-11-07T08:00:00Z');
  commit('Old news', '2026-11-07T08:00:00Z'); // 2631101
  commit('Lists load faster', '2026-11-07T09:00:00Z'); // 2631102
  commit('Baskets can be renamed', '2026-11-08T08:00:00Z'); // 2631201
  git(['checkout', '-q', '-b', 'side'], '2026-11-08T08:10:00Z');
  commit('Podcasts show their length', '2026-11-08T08:20:00Z');
  commit('Podcasts remember the speed', '2026-11-08T08:30:00Z');
  git(['checkout', '-q', 'main'], '2026-11-08T08:40:00Z');
  git(['merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side'], '2026-11-08T09:00:00Z'); // 2631202
  commit('Not yet released', '2026-11-08T10:00:00Z'); // 2631203

  const days = releaseNotes(dir, '2631101', '2631202');
  assert.deepEqual(days.map((d) => [d.from, d.to]), [['2631201', '2631202'], ['2631102', '2631102']]);
  assert.equal(toMarkdown(days, '2631101', '2631202'), [
    '# Changes after 2631101, up to 2631202', '',
    '## 8 November 2026 (2631201 to 2631202)', '',
    '- Podcasts show their length (2631202)',
    '- Podcasts remember the speed (2631202)',
    '- Baskets can be renamed (2631201)', '',
    '## 7 November 2026 (2631102)', '',
    '- Lists load faster (2631102)', '',
  ].join('\n'));
  assert.equal(releaseNotes(dir, '2631203', null).length, 0);
});
