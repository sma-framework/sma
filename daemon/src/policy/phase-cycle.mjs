/**
 * phase-cycle.mjs — THE COMMANDS OF THE PHASE CYCLE, IN ONE PLACE.
 *
 * WHY THIS FILE EXISTS AT ALL. Two parts of the daemon need the same strings and they sit
 * on opposite sides of the machine: the front door that STARTS a stage writes the command onto
 * the task, and the runner that SPAWNS the session turns it into the session's prompt. While
 * the dictionary lived inside the front server, the runner had exactly two ways to reach it —
 * import the web server into the worker path (a layering inversion), or read the command off
 * the task's TITLE and trust it. This module is the third way, and it is the reason neither of
 * those had to happen.
 *
 * THE TITLE IS NOT AN INSTRUCTION, AND THAT IS THE WHOLE POINT. A title is an ordinary text
 * field: it is written by a door, but it can also be edited, renamed, restored from a backup,
 * or set by a row that reached the table some other way. Everywhere else in this product the
 * content of a task is fenced as DATA precisely because of that. So the runner does NOT read
 * the command it is about to execute out of the record — it looks the stage up here and
 * rebuilds the command from a frozen constant. The only text that can ever become a bare
 * instruction is one of these frozen templates, whatever the row says.
 *
 * THE PAIR CANNOT DRIFT, AND THAT IS PROVED RATHER THAN INTENDED. The door and the runner
 * call the SAME function with the same arguments, and the suite pins their outputs equal byte
 * for byte for every stage. If the two ever diverged, the screen would show a person one
 * command while the worker ran another — the class of defect this whole file is built to make
 * impossible.
 *
 * NO PATH TO AUTO-MODE EXISTS HERE, BY CONSTRUCTION. None of the commands carries a flag
 * that would let the machine answer a question in the founder's place, and `assertNoAutomation`
 * refuses the command if one is ever added — enforced at the point of use rather than
 * remembered at the point of editing. Both callers get that guard by construction, because
 * both go through `stageCommand`.
 *
 * Zero imports on purpose: a frozen vocabulary that everything may depend on must depend on
 * nothing.
 */

/**
 * THE COMMANDS — one per stage, frozen, with `{phase}` as their only hole. A stage the
 * table does not name has no command and is refused by name.
 *
 * `--text` and `--batch` are the shape of a stage RUN BY A DAEMON: no interactive prompt to
 * answer and no terminal to answer it at. What a stage does when it nevertheless reaches a
 * question is park it as an artefact — the headless branch of the workflow — and the answer
 * arrives later through the decision door, which starts the very same command again.
 */
export const STAGE_COMMANDS = Object.freeze({
  discuss: '/sma-discuss-phase {phase} --batch --text',
  plan: '/sma-plan-phase {phase} --text',
  // the drawing stage, between the plan and the work. Same frozen shape as the others, and
  // deliberately no flag that would let the machine settle a design question in a person's
  // place — a drawing nobody chose is the one artefact of a phase that cannot be re-derived
  design: '/sma-design-phase {phase} --text',
  execute: '/sma-execute-phase {phase}',
  verify: '/sma-verify-work {phase} --text',
})

/**
 * The phase a stage may be started for: bounded, and unable to READ as a flag.
 *
 * The leading character class is the load-bearing part — a phase that could begin with a dash
 * would let the substitution below graft an option onto the command line.
 */
export const PHASE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The flags that would hand a founder's decision to a machine, or strip the session that is
 * supposed to make it. A command carrying one is a defect in THIS file, so it throws rather
 * than answering 400: no request can produce it, and no request should be told about it.
 */
const AUTOMATION_FLAGS = /(^|\s)--(auto|bare|dangerously-skip-permissions|permission-mode)(\s|=|$)/

/**
 * assertNoAutomation(command) → the same command, or a throw naming the flag it grew.
 *
 * @param {string} command
 * @returns {string}
 */
export function assertNoAutomation(command) {
  if (AUTOMATION_FLAGS.test(command)) {
    throw new Error(`stage command carries an automation flag: ${command}`)
  }
  return command
}

/**
 * stageCommand(stage, phase) → the command that stage is started with, or null for a stage
 * nobody declared.
 *
 * `null` rather than a throw, because both callers have a better answer than a crash for an
 * unknown stage: the door refuses the request by name, and the runner refuses the task by name.
 *
 * The phase is checked HERE and not only at the door. The door validates what a person typed;
 * this function is also called by the runner, whose input is a row that reached the table at
 * some earlier time, and a row is not a request. A phase that fails the grammar is treated the
 * same as an unknown stage: no command, so the caller refuses instead of assembling one out of
 * something unbounded.
 *
 * @param {string} stage
 * @param {string|number} phase
 * @returns {string|null}
 */
export function stageCommand(stage, phase) {
  if (!Object.prototype.hasOwnProperty.call(STAGE_COMMANDS, stage)) return null
  const text = phase === undefined || phase === null ? '' : String(phase)
  if (!PHASE_RE.test(text)) return null
  return assertNoAutomation(STAGE_COMMANDS[stage].replace('{phase}', text))
}
