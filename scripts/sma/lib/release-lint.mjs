/**
 * release-lint.mjs — the predictions-lint leg of the release ritual.
 *
 * WHY A LEG AND NOT A HABIT. The prediction lint over a live plans tree takes
 * minutes, so nobody runs it by hand and nothing else invokes it: a rule whose
 * violations are visible only to whoever remembers to look is a lint postfactum,
 * not a gate. The owner ruled: the release ritual runs it, so no release leaves
 * with an unlinted prediction corpus. prepublishOnly calls this file after the
 * package checks; a non-zero exit stops the publish.
 *
 * WHERE THE PLANS COME FROM. The tree being released carries no plans of its
 * own — planning lives beside the checkout that ships it, and naming that
 * location in a published file would weld one machine's layout into the package.
 * So the location is LOCAL state: `lintPlansDir` in `<repo>/.sma/config.json`
 * (the same unversioned file the memory budget override lives in), or the
 * SMA_LINT_PLANS_DIR environment variable, which wins when both are set.
 *
 * NO CONFIGURED TREE IS A SAID SKIP, NEVER A SILENT PASS: an install without a
 * plans tree (every consumer of the package) prints the skip and exits 0 — the
 * leg gates the house that keeps plans, without taxing the houses that do not.
 *
 * The lint itself is the ordinary verb (`cli.mjs lint --plans <dir> --json`),
 * spawned rather than imported so this leg can never drift from what a person
 * running the verb by hand would see. Exit code is the verb's own.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const CLI = join(REPO_ROOT, 'scripts', 'sma', 'cli.mjs')

/** The corpus the spawned verb reads. The leg gates PREDICTIONS, not the local
 * memory corpus — a release hostage to one machine's private notes would gate the
 * wrong thing — so the verb is pointed at the bundled clean fixture corpus, which
 * is green by construction, and only the plans tree can redden the leg. */
const CLEAN_CORPUS = join(REPO_ROOT, 'scripts', 'sma', 'fixtures', 'lint', 'clean')

function configuredPlansDir() {
  const env = process.env.SMA_LINT_PLANS_DIR
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  // SMA_RELEASE_LINT_CONFIG exists for the leg's own tests, which must be able
  // to stand on a machine whose real .sma/config.json already names a tree.
  const configPath = process.env.SMA_RELEASE_LINT_CONFIG || join(REPO_ROOT, '.sma', 'config.json')
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    if (typeof cfg.lintPlansDir === 'string' && cfg.lintPlansDir.trim() !== '') return cfg.lintPlansDir.trim()
  } catch {
    /* no local config — the skip below says so */
  }
  return null
}

const plansDir = configuredPlansDir()
if (!plansDir) {
  process.stdout.write(
    'predictions lint: no plans tree configured — skipped (set lintPlansDir in .sma/config.json or SMA_LINT_PLANS_DIR to gate releases on it)\n',
  )
  process.exit(0)
}
if (!existsSync(plansDir)) {
  // A CONFIGURED tree that is missing is a broken promise, not a consumer state.
  process.stderr.write(`predictions lint: configured plans tree does not exist: ${plansDir}\n`)
  process.exit(1)
}

process.stdout.write(`predictions lint: linting plans in ${plansDir} (this is the slow, honest leg)\n`)
const res = spawnSync(process.execPath, [CLI, 'lint', '--plans', plansDir, '--corpus', CLEAN_CORPUS, '--progress'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
})
process.exit(typeof res.status === 'number' ? res.status : 1)
