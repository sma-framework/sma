---
description: GSD slash commands use the /gsd- hyphen prefix, not the /gsd- colon variant which is stale.
kind: bug-lesson
tags: [workflow, bug-lesson]
use-when: writing a GSD command in docs or a prompt
importance: 6
---

# GSD commands use the hyphen namespace separator

**Set 2026-06-16 (founder correction).**

The GSD commands use the hyphen namespace separator, not the colon form.

**Why:** stale colon references in older docs kept leaking into new notes.

**How to apply:** always write the hyphen form; when you read the colon form in
old docs, treat it as the stale alias and do not propagate it.
