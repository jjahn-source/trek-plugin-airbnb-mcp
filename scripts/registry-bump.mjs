#!/usr/bin/env node
/**
 * Put a released version onto the registry PR that is ALREADY OPEN, instead of opening
 * another one.
 *
 * `trek-plugin publish` opens a fresh PR per version. That is the right default for a
 * plugin whose last entry is already merged, but while a PR is open it leaves a maintainer
 * with one PR per bump for the same plugin. This repo's own history is the argument: nine
 * `Ship airbnb-mcp 1.x` commits rode a single branch and merged together.
 *
 * So the flow becomes:
 *
 *   npx trek-plugin-sdk release . --repo <owner/name> --tag vX.Y.Z   # release only, no PR
 *   node scripts/registry-bump.mjs vX.Y.Z                            # amend the open PR
 *
 * If no PR is open it says so and points you back at `publish`, which is the correct tool
 * for that case, and this script never opens one.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PLUGIN_ID = 'airbnb-mcp';
const SOURCE_REPO = 'jjahn-source/trek-plugin-airbnb-mcp';
const REGISTRY = process.env.TREK_REGISTRY || 'liketrek/TREK-Plugins';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tag = args.find((a) => !a.startsWith('--'));
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error('\n  usage: node scripts/registry-bump.mjs vX.Y.Z [--dry-run]\n');
  process.exit(1);
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const die = (msg) => { console.error(`\n  Error: ${msg}\n`); process.exit(1); };

// 1. Find the open PR for this plugin. Matching on the branch prefix rather than the title
//    because the title carries the version and we are looking for ANY open bump.
let prs;
try {
  prs = JSON.parse(run('gh', ['pr', 'list', '--repo', REGISTRY, '--state', 'open',
    '--json', 'number,headRefName,headRepositoryOwner,title', '--limit', '100']));
} catch (e) {
  die(`could not list PRs on ${REGISTRY}: is \`gh\` authenticated?\n  ${e.message}`);
}
const mine = prs.filter((p) => p.headRefName.startsWith(`plugin-${PLUGIN_ID}-`));

if (mine.length === 0) {
  console.log(`\n  No open registry PR for ${PLUGIN_ID}.`);
  console.log('  The last entry is merged, so a fresh PR is the right shape:\n');
  console.log(`    npx trek-plugin-sdk publish . --repo ${SOURCE_REPO} --tag ${tag}\n`);
  process.exit(0);
}
if (mine.length > 1) {
  die(`${mine.length} open PRs for ${PLUGIN_ID} (${mine.map((p) => '#' + p.number).join(', ')}).\n` +
      '  Close all but one first. Amending the wrong branch is worse than a duplicate.');
}

const pr = mine[0];
const fork = `${pr.headRepositoryOwner.login}/${REGISTRY.split('/')[1]}`;
console.log(`\n  Amending #${pr.number}: "${pr.title}"`);
console.log(`  branch ${pr.headRefName} on ${fork}\n`);

// 2. Check out that branch.
const work = mkdtempSync(path.join(tmpdir(), 'trek-registry-'));
run('gh', ['repo', 'clone', fork, work, '--', '--quiet', '--branch', pr.headRefName]);

const entryPath = path.join(work, 'registry', 'plugins', `${PLUGIN_ID}.json`);
if (!existsSync(entryPath)) die(`the PR branch has no registry/plugins/${PLUGIN_ID}.json`);
const before = JSON.parse(readFileSync(entryPath, 'utf8'));

// 3. Rebuild the entry, merging this version onto what the branch already carries. The SDK
//    owns the sha256/size/commitSha, which is the whole point of not doing this by hand.
const merged = run('npx', ['-y', 'trek-plugin-sdk', 'entry',
  '--repo', SOURCE_REPO, '--tag', tag, '--merge', entryPath], { cwd: process.cwd() });

let parsed;
try {
  parsed = JSON.parse(merged);
} catch {
  die(`\`trek-plugin entry\` did not return JSON:\n${merged.slice(0, 400)}`);
}
if (!parsed.versions?.some((v) => v.version === tag.slice(1))) {
  die(`the rebuilt entry does not contain ${tag}, refusing to push it`);
}

// `entry` stamps a fresh publishedAt every run, so re-running for a version the branch
// already carries would push a commit whose only content is a moved timestamp. Keep the
// original stamp for anything already there. It is when that version was published, not
// when this script last ran, which makes a re-run a genuine no-op.
for (const v of parsed.versions) {
  const had = before.versions?.find((b) => b.version === v.version);
  if (had?.publishedAt) v.publishedAt = had.publishedAt;
}
writeFileSync(entryPath, JSON.stringify(parsed, null, 2) + '\n');

// 4. Commit and push. Never force: this branch is a maintainer's review surface.
const status = run('git', ['status', '--porcelain'], { cwd: work });
if (!status) {
  console.log(`  Nothing changed, ${tag} is already on the branch.\n`);
  process.exit(0);
}
if (dryRun) {
  console.log('  --dry-run: would commit and push');
  console.log(`  versions after: ${parsed.versions.map((v) => v.version).join(', ')}`);
  console.log(run('git', ['diff', '--stat'], { cwd: work }) + '\n');
  process.exit(0);
}
run('git', ['add', 'registry/plugins/' + PLUGIN_ID + '.json'], { cwd: work });
run('git', ['commit', '-m', `Ship ${PLUGIN_ID} ${tag.slice(1)}`], { cwd: work });
run('git', ['push', 'origin', pr.headRefName], { cwd: work });

const was = before.versions?.[0]?.version ?? 'nothing';
console.log(`  ${was} → ${tag.slice(1)}`);
console.log(`  https://github.com/${REGISTRY}/pull/${pr.number}\n`);
