import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkWorkspace, planFiles, workspacePaths } from './check-workspace.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'purss-scaffold-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [index, directory] of ['', ...workspacePaths].entries()) {
    const target = path.join(root, directory);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'package.json'), JSON.stringify({
      name: `fixture-${index}`,
      private: true,
      ...(directory ? {} : { workspaces: ['apps/*', 'packages/*'] }),
    }));
  }
  const documents = [
    'README.md', 'AGENTS.md', 'infra/README.md', 'tests/acceptance/README.md',
    ...workspacePaths.map((directory) => `${directory}/README.md`),
    ...planFiles.map((filename) => `plan/${filename}`),
  ];
  for (const document of documents) {
    await mkdir(path.dirname(path.join(root, document)), { recursive: true });
    await writeFile(path.join(root, document), '# Fixture\n');
  }
  return root;
}

test('accepts the private scaffold and ignores external and anchor-only links', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'README.md'), '[plan](plan/README.md) [web](https://example.com/) [section](#section)');
  const result = await checkWorkspace(root);
  assert.deepEqual(result.errors, []);
  assert.equal(result.packageCount, workspacePaths.length + 1);
});

test('reports broken local links and missing plan documents', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'README.md'), '[missing](missing.md)');
  await rm(path.join(root, 'plan', planFiles[1]));
  const result = await checkWorkspace(root);
  assert.ok(result.errors.some((error) => error.includes('broken local link')));
  assert.ok(result.errors.some((error) => error.includes('Missing required document')));
});

test('rejects duplicate package names and non-private packages', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'apps/web/package.json'), JSON.stringify({ name: 'fixture-0' }));
  const result = await checkWorkspace(root);
  assert.ok(result.errors.some((error) => error.includes('duplicate package name')));
  assert.ok(result.errors.some((error) => error.includes('must remain private')));
});

test('reports malformed package manifests without stopping all checks', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'apps/api/package.json'), '{');
  const result = await checkWorkspace(root);
  assert.ok(result.errors.some((error) => error.includes('cannot read valid package.json')));
});

test('rejects local link destinations outside the repository', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'README.md'), '[outside](../outside.md)');
  const result = await checkWorkspace(root);
  assert.ok(result.errors.some((error) => error.includes('link escapes repository')));
});
