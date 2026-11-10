import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const workspacePaths = [
  'apps/web',
  'apps/api',
  'apps/worker',
  'apps/egress',
  'apps/push-relay',
  'apps/extension',
  'apps/mobile',
  'apps/desktop',
  'apps/site',
  'packages/domain',
  'packages/freshrss',
  'packages/connectors',
  'packages/ui',
];

export const planFiles = [
  'README.md',
  '01-product.md',
  '02-domain-model.md',
  '03-experience-and-design.md',
  '04-source-onboarding.md',
  '05-architecture.md',
  '06-freshrss-integration.md',
  '07-baskets-and-retention.md',
  '08-connectors-and-discovery.md',
  '09-views-and-queries.md',
  '10-security-and-privacy.md',
  '11-packaging-and-operations.md',
  '12-roadmap.md',
  '13-validation.md',
  '14-decisions-and-risks.md',
  '15-references.md',
  '16-review.md',
  '17-storage-and-ownership.md',
  '18-hosted-service.md',
];

const ignoredDirectories = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.output', '.cache',
  '.secrets', 'data', 'backups', 'playwright-report', 'test-results',
]);

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      files.push(...await markdownFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function checkWorkspace(root) {
  const errors = [];
  const packageNames = new Set();
  for (const directory of ['', ...workspacePaths]) {
    const manifestPath = path.join(root, directory, 'package.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        errors.push(`${directory || '.'}: package name is required`);
      } else if (packageNames.has(manifest.name)) {
        errors.push(`${directory || '.'}: duplicate package name ${manifest.name}`);
      } else {
        packageNames.add(manifest.name);
      }
      if (manifest.private !== true) {
        errors.push(`${directory || '.'}: package must remain private`);
      }
      if (!directory && JSON.stringify(manifest.workspaces) !== JSON.stringify(['apps/*', 'packages/*'])) {
        errors.push('Root package must declare the planned apps and packages workspaces');
      }
    } catch (error) {
      errors.push(`${directory || '.'}: cannot read valid package.json (${error.message})`);
    }
  }

  const requiredDocuments = [
    'README.md', 'AGENTS.md', 'infra/README.md', 'tests/acceptance/README.md',
    ...workspacePaths.map((directory) => `${directory}/README.md`),
    ...planFiles.map((filename) => `plan/${filename}`),
  ];
  for (const filename of requiredDocuments) {
    try {
      if (!(await stat(path.join(root, filename))).isFile()) {
        errors.push(`Required document is not a file: ${filename}`);
      }
    } catch {
      errors.push(`Missing required document: ${filename}`);
    }
  }

  let documentCount = 0;
  for (const filename of await markdownFiles(root)) {
    documentCount += 1;
    const content = await readFile(filename, 'utf8');
    for (const match of content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      try {
        const localTarget = decodeURIComponent(target.split(/[?#]/)[0]);
        const resolved = path.resolve(path.dirname(filename), localTarget);
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          errors.push(`${path.relative(root, filename)}: link escapes repository: ${target}`);
          continue;
        }
        await stat(resolved);
      } catch {
        errors.push(`${path.relative(root, filename)}: broken local link: ${target}`);
      }
    }
  }

  return { errors, documentCount, packageCount: packageNames.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await checkWorkspace(root);
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log(`Scaffold OK: ${result.packageCount} private packages, ${result.documentCount} Markdown documents; local link destinations exist.`);
  }
}
