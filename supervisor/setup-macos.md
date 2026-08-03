# SMA V5 — running a 24/7 worker fleet on a Mac mini (launchd)

*Русская версия: [`setup-macos.ru.md`](setup-macos.ru.md).*

This is the first-time setup of a dedicated host for a worker fleet. The daemon
core is host-agnostic; only the thin macOS binding through launchd lives here.
This is the macOS twin of [`setup-windows.md`](setup-windows.md): the same order,
the same smoke principle, a different supervisor.

The procedure targets ANY macOS host, not one particular machine or household.
The first external run of this checklist will most likely be done by a beta
tester, on THEIR own Mac mini with THEIR own accounts. So:

- Steps 1-8 (base setup + smoke + local daemon + roster) must pass on any Mac
  mini: the owner and a beta tester run them the same way.
- Step 9, «Handing work back to the owner», is a SEPARATE park-host path: it is
  needed only when the mini holds the owner's own work (their clone, their
  tasks). A beta tester who just runs the smoke and a local daemon does not need
  step 9.

The steps a human runs by hand are written in plain language. The engineering
detail follows in separate blocks.

> **About security.** The daemon never reaches origin: it has no path to the
> publish verb. Publishing to main is always done by the owner, from their own
> machine (`/sma-ship`). Work approved on the mini comes back the other way — the
> owner adds the mini as a git remote and pulls it themselves (step 9). The clone
> on the mini physically cannot publish: its push address is disabled (step 4).

---

## 1. A user with automatic login

Create a SEPARATE user on the Mac mini for the worker (`worker`, say) and turn on
automatic login for it: **System Settings → Users & Groups → Automatic login →
pick that user**. That way the mini logs into the worker's session by itself
after a reboot, launchd brings the daemon up (RunAtLoad), and every account works
under that user.

> Why automatic login and not a boot-time service with no user. Workers launch
> `claude` and `codex`, and their authorization is TIED TO A USER (`claude
> setup-token` tokens, the `~/.claude` directory, a separate `CLAUDE_CONFIG_DIR`
> per account). A background service with no session (a LaunchDaemon) may not
> reach that authorization or the Keychain at all. So the 24/7 form is a
> LaunchAgent under an automatic-login user.

## 2. Homebrew and the base packages

Install Homebrew (if it is not there yet), then node, git and Postgres:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node git postgresql@16
brew services start postgresql@16     # the local queue database on the host
which node                            # note the path: Apple Silicon → /opt/homebrew/bin/node
```

> The path to node matters for the plist (step 7). On Apple Silicon it is
> `/opt/homebrew/bin/node`, on an Intel mini `/usr/local/bin/node`. Take whatever
> `which node` printed.

## 3. The workers' global CLIs (check the exact package names)

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
claude --version && codex --version   # both commands must print a version
```

> The exact package names are not re-verified here (both CLIs already work on the
> reference Windows machine). If `claude`/`codex` are not found after the install,
> check the vendor's current package name and fix the command. The smoke (step 5)
> checks that both commands answer.

## 4. Repository clones (origin is read-only)

The worker gets ITS OWN clones — it never shares the owner's working copy. Clone
the SMA product and, if this mini is going to hold the owner's tasks, your work
repository. Right after cloning, DISABLE origin's publish address, so the clone
physically cannot publish:

```bash
cd ~
git clone <SMA_REPO_URL> sma
git clone <YOUR_REPO_URL> project          # only if the mini holds the owner's tasks

# make origin READ-ONLY (fetch-only) in every clone:
cd ~/sma       && git remote set-url --push origin DISABLED
cd ~/project   && git remote set-url --push origin DISABLED
git remote -v                              # origin must show (fetch), and push → DISABLED
```

> `DISABLED` is a deliberately broken address: any attempt to publish from the
> clone fails immediately. This is the third layer of the owner-publishes law (the
> first two are the absence of a path to the publish verb in the daemon's sources,
> and a merge verb that is local-only).

## 5. The cross-platform smoke — THE FIRST STEP AFTER THE CLONES

Before you configure the daemon, prove that the SMA verbs and the host
prerequisites work on macOS. The harness has so far run ONLY on Windows — this
smoke accepts it on macOS:

```bash
cd ~/sma
node supervisor/smoke-macos.mjs
```

The smoke is a sequential checklist: every step prints `PASS` or `FAIL` and moves
on, and at the end the process exits with the number of failures (exit 0 =
everything green). It checks:

1. node >= 22.5 + git on PATH.
2. a full `pnpm test` run in `~/sma` (a one-time acceptance of the whole suite on
   this machine).
3. a live `worktree provision` → base check → `worktree remove` round.
4. a `statusline install` → render → uninstall round.
5. the POSIX branch of hook installation (never once exercised on real macOS).
6. `claude --version` + `codex --version` (a check of the package names from step 3).
7. postgresql@16 up + `psql -c 'select 1'`.
8. `CLAUDE_CONFIG_DIR` isolation across two accounts.

Report the smoke result to the owner (how many PASS out of how many). The red
steps are the list of what has to be installed or fixed before the next steps.

## 6. Account tokens and the daemon config

For every Max/Pro account in the pool, make a headless token and put it in an
environment variable of the user the daemon runs as:

```bash
claude setup-token                    # repeat per account, under its CLAUDE_CONFIG_DIR
```

Keep the tokens in an env file with mode 0600 (owner-readable only), NEVER in git
and never in the daemon config itself:

```bash
umask 077
printf 'export SMA_MAX_1_TOKEN=...\nexport SMA_MAX_2_TOKEN=...\nexport SMA_MAX_3_TOKEN=...\nexport SMA_PRO_1_TOKEN=...\n' > ~/.sma-daemon/tokens.env
chmod 600 ~/.sma-daemon/tokens.env
```

The daemon config is written on the first boot, with a fresh 64-character front
token. Create it ahead of time and fill it in:

```bash
cd ~/sma
node --input-type=module -e "import('./daemon/src/config.mjs').then(m=>m.loadConfig())"
```

In `~/.sma-daemon/config.json` set:

- `queueUrl` = `postgres://localhost:5432/sma_daemon` — the local queue database
  on the host. NEVER your project's working database and NEVER a production
  database.
- `bind` — `127.0.0.1` to check it locally; `0.0.0.0` only deliberately, so that
  the roster opens from other devices over the LAN.
- `workers` — the pool's accounts: each with its own `account.configDir` and the
  name of the environment variable holding its token in `account.oauthTokenEnv`
  (the token value lives only in the environment, never on disk).
- `token` (the front token) stays as generated — it is what opens the roster.

> **About mode 0600.** The daemon config carries the front token and is written
> with mode 0600. The env file with the OAuth tokens is 0600 too. Neither a token
> nor the names of the environment variables are ever printed: everything logged
> passes through `secretsView`, which folds secrets down to `[set]`/`[unset]`.

## 7. Installing the LaunchAgent

Copy the plist template into `~/Library/LaunchAgents`, replace the two
placeholders IN THE COPY, and load the agent:

```bash
cp ~/sma/supervisor/com.sma.daemon.plist ~/Library/LaunchAgents/com.sma.daemon.plist
# in the copy, replace:
#   <SMA_HOME>    -> the absolute path of the clone (e.g. /Users/worker/sma)
#   <WORKER_HOME> -> the user's home directory (e.g. /Users/worker)
# and the path to node if needed (Intel: /usr/local/bin/node)

launchctl load -w ~/Library/LaunchAgents/com.sma.daemon.plist
launchctl list | grep com.sma.daemon           # the daemon must be in the list
tail -f ~/Library/Logs/sma-daemon.log          # the daemon's log
```

The agent is set with `KeepAlive` — launchd restarts the daemon after any crash.
To remove the agent:
`launchctl unload -w ~/Library/LaunchAgents/com.sma.daemon.plist`.

## 8. Checking the roster from a second device

If `bind` = `0.0.0.0`, open the roster from a phone or laptop on the same
network: `http://<MINI_IP>:7777/?token=<FRONT_TOKEN_FROM_THE_CONFIG>`. The roster
must show the fleet's status bar, the queue and the worker cards. The first visit
with `?token=` sets an HttpOnly cookie — after that the token is not needed in
the address.

> Deferred hardening (not required for a first run): over the LAN this is plain
> HTTP today, which is acceptable because the roster carries task metadata only,
> never code diffs without a token, never subscription tokens. Later: mkcert/TLS
> or `tailscale serve`.

## 9. Handing work back to the owner (the park-host path)

> ⚠ This step is needed ONLY when the mini holds the owner's tasks (their clone of
> the work repository). A beta tester who runs the smoke and a local daemon at
> home should skip step 9.

The hand-back scheme: work approved on the mini sits in the local main of its
clone; **the owner adds the mini as a git remote on THEIR machine and pulls it
themselves** — the daemon and the worker have no path to origin at all.

```bash
# run by the OWNER on THEIR machine:
git remote add mini worker@<MINI_IP>:/Users/worker/project
git fetch mini
git log mini/main --oneline           # the worker's approved commits
# then the owner decides what to merge and publish, through their own /sma-ship
```

The alternative — «the daemon publishes `wt/*` branches itself» — is REJECTED by
default: it would require an explicit exception to the owner-publishes law. If the
owner picks a different scheme, adjust this step to match it.

---

## First run

_(To be filled in after the first run on a dedicated Mac mini. It will carry: the
smoke result N/N, the kill-drill result under launchd, an end-to-end
enqueue → approve → pull run, and confirmation of the hand-back scheme.)_
