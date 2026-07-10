# Transitional /gsd-* alias layer (D-9.1-02)

This directory holds THIN alias skills that map the old `/gsd-*` command names
1:1 onto the canonical `/sma-*` commands. They exist only so parallel terminals
with old muscle memory (and old instructions in STATE.md / memory files) keep
working during the transition. Each alias delegates to its `/sma-*` target and
adds zero behavior.

## Aliases

| Alias | Canonical target | Workflow |
|---|---|---|
| /gsd-plan-phase | /sma-plan-phase | workflows/plan-phase.md |
| /gsd-execute-phase | /sma-execute-phase | workflows/execute-phase.md |
| /gsd-discuss-phase | /sma-discuss-phase | workflows/discuss-phase.md |
| /gsd-verify-work | /sma-verify-work | workflows/verify-work.md |
| /gsd-quick | /sma-quick | workflows/quick.md |
| /gsd-debug | /sma-debug | workflows/debug.md |
| /gsd-progress | /sma-progress | workflows/progress.md |
| /gsd-resume-work | /sma-resume-work | workflows/resume-project.md |
| /gsd-pause-work | /sma-pause-work | workflows/pause-work.md |
| /gsd-fast | /sma-fast | workflows/fast.md |
| /gsd-help | /sma-help | workflows/help.md |

## Removal condition (D-9.1-02)

`/sma-*` is canonical from wave 0. This alias layer is DELETED as soon as the
adopting project's remaining pre-rename live phases are closed
(their STATE.md / ROADMAP entries marked complete). Do not extend it, do not
add behavior to it, do not add new aliases: new commands ship as `/sma-*` only.

Deletion command (run from the repo root, one commit):

```
git rm -r sma-core/aliases && git commit -m "aliases: remove transitional /gsd-* layer (D-9.1-02 condition met: phases 51/52 closed)"
```

## Installer contract (9.1-04)

The installer (`npx sma-framework init`) installs this directory ONLY when the
`--with-gsd-aliases` flag is passed. Default installs get the `/sma-*` surface
only. This contract is binding on plan 9.1-04.

## Note on the zero-residue gate

`tools/verify-rebrand.mjs` deliberately EXCLUDES `sma-core/aliases/**` from the
old-brand residue scan: the `gsd` prefix here is the whole point of the layer.
The exclusion is recorded in `rename-map.json`.
