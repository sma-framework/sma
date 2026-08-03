# The feature gate — five elements, or the feature does not enter the default path

> Checked by `sma eval gate --file <declaration.json>`. Exit 0 means the declaration is
> complete and its prediction can be run by a machine. Exit 1 means refused, naming the
> element that is missing or unusable.

A new feature is easy to justify and hard to un-ship. The gate exists because the
justification is usually written *after* the feature works, when the author already
knows the answer — and a justification written then can never be wrong. This document
is the shape a justification has to take **before** the work starts, so that it *can*
be wrong.

Five elements. Not four, and not "four plus a note about the fifth".

---

## 1. Failure class

**The observed way of being wrong that this feature addresses.**

A class, not an incident, and not a wish. "Retrieval feels imprecise" is a mood.
"The pack finds the needed record but orders it below the position a reader actually
reaches" is a class: you can point at the cases, count them, and tell whether the
count changed.

If the failure class cannot be named without using the word *better*, there is no
failure class yet — there is a preference. Preferences are legitimate; they are simply
not admissible here, because nothing can measure whether one was satisfied.

## 2. Baseline

**The recorded number the feature will be compared against, and where it is recorded.**

Not "the current behaviour" — a *recorded, re-runnable* number: a receipt from
`sma baseline capture --record`, a run of `sma eval memory`, or an equivalent measurement
whose command anyone can execute again. The baseline has to exist **before** the change,
because a baseline taken afterwards is measuring the thing that already moved.

A feature whose baseline is "we did not measure that before" is not blocked forever —
it is blocked until the measurement is taken. That delay is the point.

## 3. Falsifiable prediction

**A metric, a comparator, a numeric threshold, and the command that produces the number.**

```json
"prediction": {
  "metric": "ndcg",
  "comparator": ">=",
  "threshold": 0.55,
  "check_command": "node scripts/sma/cli.mjs eval memory --stat ndcg"
}
```

The threshold must be a **number**. This is the refusal that matters most: *"it will be
noticeably better"* is not a prediction, it is a wish, and a wish cannot turn out to be
wrong — which is exactly what makes it worthless as evidence later. `eval gate` refuses
a non-numeric threshold by name.

The comparator comes from the fixed set the predictions ledger already uses
(`==`, `!=`, `>=`, `<=`, `>`, `<`), and the check command is held to the same allowlist
the ledger enforces. A gate with a looser notion of *checkable* than the ledger would be
a documented way around the ledger.

## 4. Acceptance

**What "it worked" means, written down before the work starts.**

Acceptance is broader than the prediction: the prediction is one number, acceptance is
the whole condition — usually *the predicted number moved* **and** *the guardrails did
not move the wrong way*. A retriever that raises the ranking number while a must-be-zero
floor goes red has not passed; saying so in advance is what stops the argument later.

## 5. Rollback

**How the feature leaves the default path again, and how you would know it left cleanly.**

A flag that is off by default, a layer that can be skipped, a migration with a
documented reverse. If the honest answer is "it cannot be removed once it is in", that
is not a rollback plan — it is a reason to think harder before merging, and the gate is
doing its job by saying so.

---

## The declaration

One JSON file. The example below is a neutral archetype — a second retrieval layer, the
most common shape this gate sees:

```json
{
  "feature": "a second retrieval layer, kept behind the default path until it is measured",
  "failure_class": "the pack finds the needed record but orders it below the position a reader actually reaches, so completeness looks fine while the answer is missed",
  "baseline_ref": "the recorded retrieval baseline receipt plus the gold-set benchmark run on the same corpus, both re-runnable",
  "prediction": {
    "metric": "ndcg",
    "comparator": ">=",
    "threshold": 0.55,
    "check_command": "node scripts/sma/cli.mjs eval memory --stat ndcg"
  },
  "acceptance": "the ranking number rises past the threshold AND every must-be-zero floor stays at zero AND precision at three does not fall below the recorded baseline",
  "rollback": "the layer sits behind a flag that is off by default; turning the flag off restores the previous selection path byte for byte, and the benchmark run proves it did"
}
```

Check it:

```bash
node scripts/sma/cli.mjs eval gate --file declaration.json
```

A complete declaration exits 0 and prints the prediction it will be judged by. An
incomplete one exits 1 and names what is missing:

```
SMA eval gate: ОТКАЗ — «…» не проходит гейт допуска:
  ✗ rollback: элемент отсутствует
  ✗ prediction.threshold: порог «noticeably better than today» не число — прогноз без числа нельзя опровергнуть
```

## The rule

**A feature without a passing declaration does not enter the default path.**

It may exist. It may be built, merged, tested and shipped behind a flag that is off. What
it may not do is become the behaviour everyone gets by default, because that is the point
at which everybody starts paying for it — and the whole reason to measure cost per
verified result (`sma eval north-star`) is that features are usually added on the strength
of the thing they improve, never on the strength of what they cost.

The stopping rule follows from the same place: **a layer that does not improve the
critical numbers, or improves them only by making another one worse, does not enter the
default path — however good it looks.** Deciding that in advance, in writing, is far
easier than deciding it afterwards about work somebody already finished.

## What the gate is not

- **Not a review.** It checks that the declaration is *complete and checkable*, not that
  the idea is good. Judgment stays with people; the gate only refuses to let judgment be
  skipped.
- **Not a guarantee.** A passing declaration can still hold a prediction that turns out
  false. That is the intended outcome — a prediction that could not turn out false would
  have been refused at the gate.
- **Not retroactive by default.** The gate is cheapest when it runs before the work. Run
  afterwards it still works, but it is then measuring a decision that has already been
  made, and the pressure to write a declaration the finished feature happens to satisfy
  is very hard to resist.

---

*See also: [MEMORY-MODEL.md](MEMORY-MODEL.md) (what one record may claim),
`sma eval memory` (the floors that a guardrail row reports), `sma eval north-star`
(cost per verified correct result, and the panel of recorded guardrails).*
