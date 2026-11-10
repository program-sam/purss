import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { firstParents, gitVersion, readVersion, versionsOf } from './version.ts';

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'purss-version-'));
  const git = (args, date) => execFileSync('git', ['-C', dir, ...args], {
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
  git(['init', '-q', '-b', 'main']);
  const commit = (subject, date) => git(['commit', '-q', '--allow-empty', '-m', subject], date);
  return { dir, git, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the version counts the head\'s commit among its UTC day\'s commits on main', (t) => {
  const r = repo();
  t.after(r.done);
  r.commit('Late on the 7th', '2026-11-07T23:50:00Z');
  r.commit('First on the 8th', '2026-11-08T00:10:00+01:00'); // still the 7th in UTC
  r.commit('Second', '2026-11-08T09:00:00Z');
  r.commit('Third', '2026-11-08T10:00:00Z');
  const v = gitVersion(r.dir);
  assert.equal(v.version, '2631202');
  assert.equal(v.committedAt, '2026-11-08T10:00:00.000Z');
  assert.match(v.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(versionsOf(firstParents(r.dir)).map((x) => `${x.version} ${x.commit.subject}`), [
    '2631202 Third', '2631201 Second', '2631102 First on the 8th', '2631101 Late on the 7th',
  ]);
});

test('a merged branch counts once, as its merge on the first-parent line', (t) => {
  const r = repo();
  t.after(r.done);
  r.commit('Base', '2026-11-08T08:00:00Z');
  r.git(['checkout', '-q', '-b', 'side']);
  r.commit('On the branch', '2026-11-08T08:30:00Z');
  r.commit('Also on the branch', '2026-11-08T08:40:00Z');
  r.git(['checkout', '-q', 'main']);
  r.git(['merge', '-q', '--no-ff', '-m', 'Merge side', 'side'], '2026-11-08T09:00:00Z');
  assert.equal(gitVersion(r.dir).version, '2631202');
  assert.equal(firstParents(r.dir)[0].merge, true);
});

test('without history, version.json says it; without either, there is none', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'purss-version-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readVersion(dir), null);
  writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ version: '2631214', commit: 'abc', committedAt: '2026-11-08T10:00:00.000Z' }));
  assert.deepEqual(readVersion(dir), { version: '2631214', commit: 'abc', committedAt: '2026-11-08T10:00:00.000Z' });
});
