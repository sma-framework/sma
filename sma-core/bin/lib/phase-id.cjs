"use strict";
/**
 * Pure phase-id parsing/matching helpers — normalize, token match,
 * milestone/phase-dir id parsing, phase-markdown regex builders.
 *
 * Extracted from core.cts (ADR-857 rollout phase 2a / issue #865).
 * The hand-written bodies are preserved byte-for-behaviour; only the module
 * boundary moved. The core.cjs re-export spine was retired in epic #1267;
 * callers import phase-id helpers from phase-id.cjs directly.
 *
 * Dependencies: none (pure string/regex, no Node built-ins required).
 */
// ─── Phase-id helpers ─────────────────────────────────────────────────────────
function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
// project_code values start with an uppercase letter (e.g. PROJ, APP_CODE);
// leading underscores are not valid project codes per .planning/config.json.
const PROJECT_CODE_PREFIX_STRIP_RE = /^[A-Z][A-Z0-9_]*-(?=\d)/;
const PROJECT_CODE_PREFIX_STRIP_RE_I = /^[A-Z][A-Z0-9_]*-(?=\d)/i;
const PROJECT_CODE_PREFIX_CAPTURE_RE_I = /^([A-Z][A-Z0-9_]*)-(\d.*)/i;
const OPTIONAL_PROJECT_CODE_PREFIX_SOURCE = '(?:[A-Z][A-Z0-9_]*-)?';
function stripProjectCodePrefix(value, caseInsensitive = true) {
    const input = String(value);
    const re = caseInsensitive ? PROJECT_CODE_PREFIX_STRIP_RE_I : PROJECT_CODE_PREFIX_STRIP_RE;
    return input.replace(re, '');
}
function hasProjectCodePrefix(value) {
    return PROJECT_CODE_PREFIX_STRIP_RE_I.test(String(value));
}
function normalizePhaseName(phase) {
    const str = String(phase);
    // Strip optional project_code prefix (e.g., 'CK-01' → '01')
    const stripped = stripProjectCodePrefix(str, false);
    // Milestone-prefixed phase IDs: M-NN or M-N-N (deep decomposition).
    const milestoneMatch = stripped.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);
    if (milestoneMatch) {
        const major = milestoneMatch[1].padStart(2, '0');
        const subSegments = milestoneMatch[2].slice(1).split('-').map(s => s.padStart(2, '0'));
        const suffix = milestoneMatch[3] || '';
        return `${major}-${subSegments.join('-')}${suffix}`;
    }
    // Standard numeric phases: 1, 01, 12A, 12.1
    const match = stripped.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
    if (match) {
        const padded = match[1].padStart(2, '0');
        // Preserve original case of letter suffix (#1962).
        const letter = match[2] || '';
        const decimal = match[3] || '';
        return padded + letter + decimal;
    }
    // Custom phase IDs (e.g. PROJ-42, AUTH-101): return as-is
    return str;
}
function getMilestoneFromPhaseId(phaseId) {
    const stripped = stripProjectCodePrefix(phaseId);
    const m = stripped.match(/^0*(\d+)-\d/);
    if (!m)
        return null;
    const major = parseInt(m[1], 10);
    if (major === 0 || major === 999)
        return null;
    return `v${major}.0`;
}
function getPhaseDirFromPhaseId(phaseId, phaseName, projectCode) {
    const stripped = stripProjectCodePrefix(phaseId);
    const m = stripped.match(/^0*(\d+)-(0*(\d+(?:-\d+)*))$/);
    if (!m)
        return null;
    const milestone = String(parseInt(m[1], 10)).padStart(2, '0');
    const subParts = m[2].split('-').map(p => String(parseInt(p, 10)).padStart(2, '0'));
    const sub = subParts.join('-');
    const slug = phaseName
        ? phaseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        : '';
    const parts = [milestone, sub, slug].filter(Boolean);
    const base = parts.join('-');
    return projectCode ? `${projectCode}-${base}` : base;
}
/**
 * Render a regex source fragment matching a phase number against ROADMAP/STATE
 * prose regardless of zero-padding on either side.
 */
function phaseMarkdownRegexSource(phaseNum) {
    const stripped = stripProjectCodePrefix(phaseNum);
    // Milestone-prefixed IDs: M-NN or M-N-N (deep).
    const milestoneSegments = stripped.match(/^(\d+)((?:-\d+)*)([A-Z]?(?:\.\d+)*)$/i);
    if (milestoneSegments && milestoneSegments[2]) {
        const majorUnpadded = milestoneSegments[1].replace(/^0+/, '') || '0';
        const subParts = milestoneSegments[2].slice(1).split('-');
        const subFragments = subParts.map(s => {
            const unpadded = s.replace(/^0+/, '') || '0';
            return `0*${escapeRegex(unpadded)}`;
        });
        const suffix = milestoneSegments[3] || '';
        const suffixFragment = suffix ? escapeRegex(suffix) : '';
        return `0*${escapeRegex(majorUnpadded)}-${subFragments.join('-')}${suffixFragment}`;
    }
    // Plain numeric phase: 1, 01, 12A, 12.1
    const match = stripped.match(/^0*(\d+)([A-Z])?((?:\.\d+)*)$/i);
    if (!match)
        return escapeRegex(phaseNum);
    const integer = match[1].replace(/^0+/, '') || '0';
    const letter = match[2] ? escapeRegex(match[2]) : '';
    const decimal = match[3] ? escapeRegex(match[3]) : '';
    return `0*${escapeRegex(integer)}${letter}${decimal}`;
}
/**
 * #3599: when the caller passed a project-code-prefixed ID like `PROJ-42`,
 * return the exact-escaped form.
 */
function phaseMarkdownRegexSourceExact(phaseNum) {
    const raw = String(phaseNum);
    if (!hasProjectCodePrefix(raw))
        return null;
    return escapeRegex(raw);
}
function comparePhaseNum(a, b) {
    // Strip optional project_code prefix before comparing
    const sa = stripProjectCodePrefix(a);
    const sb = stripProjectCodePrefix(b);
    const milestoneA = sa.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);
    const milestoneB = sb.match(/^(\d+)((?:-\d+)+)([A-Z]?(?:\.\d+)*)$/i);
    if (milestoneA && milestoneB) {
        const segsA = [parseInt(milestoneA[1], 10), ...milestoneA[2].slice(1).split('-').map(s => parseInt(s, 10))];
        const segsB = [parseInt(milestoneB[1], 10), ...milestoneB[2].slice(1).split('-').map(s => parseInt(s, 10))];
        const maxSegs = Math.max(segsA.length, segsB.length);
        for (let i = 0; i < maxSegs; i++) {
            const av = segsA[i] !== undefined ? segsA[i] : 0;
            const bv = segsB[i] !== undefined ? segsB[i] : 0;
            if (av !== bv)
                return av - bv;
        }
        const sufA = milestoneA[3] || '';
        const sufB = milestoneB[3] || '';
        if (sufA !== sufB)
            return sufA < sufB ? -1 : 1;
        return 0;
    }
    if (milestoneA || milestoneB)
        return String(a).localeCompare(String(b));
    const pa = sa.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
    const pb = sb.match(/^(\d+)([A-Z])?((?:\.\d+)*)/i);
    if (!pa || !pb)
        return String(a).localeCompare(String(b));
    const intDiff = parseInt(pa[1], 10) - parseInt(pb[1], 10);
    if (intDiff !== 0)
        return intDiff;
    const la = (pa[2] || '').toUpperCase();
    const lb = (pb[2] || '').toUpperCase();
    if (la !== lb) {
        if (!la)
            return -1;
        if (!lb)
            return 1;
        return la < lb ? -1 : 1;
    }
    const aDecParts = pa[3] ? pa[3].slice(1).split('.').map(p => parseInt(p, 10)) : [];
    const bDecParts = pb[3] ? pb[3].slice(1).split('.').map(p => parseInt(p, 10)) : [];
    const maxLen = Math.max(aDecParts.length, bDecParts.length);
    if (aDecParts.length === 0 && bDecParts.length > 0)
        return -1;
    if (bDecParts.length === 0 && aDecParts.length > 0)
        return 1;
    for (let i = 0; i < maxLen; i++) {
        const av = Number.isFinite(aDecParts[i]) ? aDecParts[i] : 0;
        const bv = Number.isFinite(bDecParts[i]) ? bDecParts[i] : 0;
        if (av !== bv)
            return av - bv;
    }
    return 0;
}
// A leading run that already spells a complete phase number: `08`, `49`,
// `12A`, `12.1`. Whatever follows such a run belongs to the slug, not the id.
const COMPLETE_PHASE_NUMBER_RE = /^\d+[A-Z]?(?:\.\d+)*$/i;
// Hand-written planning trees spell the word out (`phase-8-user-accounts`).
// The literal label is not a project_code — the number after it is the token.
const PHASE_LABEL_PREFIX_RE = /^phase-(?=\d)/i;
/**
 * Split a phase directory name into its phase token and the slug that follows.
 *
 * Directory names lead with the phase number (`08-memory`, `12.1-hotfix`,
 * `CK-08-memory`); hand-made trees lead with a spelled-out label
 * (`phase-8-memory`). A slug may itself begin with digit segments
 * (`09-2-3-import-rewrite`), so the token stops at the FIRST leading run that
 * already forms a complete phase number instead of swallowing every leading
 * digit segment — otherwise such a directory answers to no phase at all.
 *
 * Milestone-decomposed ids (`01-02-name` = milestone 1, phase 2) share that
 * shape, so every longer leading run is kept as an alternative candidate and
 * phaseTokenMatches accepts whichever one the caller asked for.
 *
 * @returns {{token: string, slug: string, candidates: string[]}}
 */
function splitPhaseDirName(dirName) {
    const name = String(dirName);
    // consumedPrefix is stripped from the slug; tokenPrefix is part of the id.
    let consumedPrefix = '';
    let tokenPrefix = '';
    let rest = name;
    const labelMatch = name.match(PHASE_LABEL_PREFIX_RE);
    if (labelMatch) {
        consumedPrefix = labelMatch[0];
        rest = name.slice(consumedPrefix.length);
    }
    else {
        const codePrefixMatch = name.match(PROJECT_CODE_PREFIX_CAPTURE_RE_I);
        if (codePrefixMatch) {
            consumedPrefix = codePrefixMatch[1] + '-';
            tokenPrefix = consumedPrefix;
            rest = codePrefixMatch[2];
        }
    }
    const segments = rest.split('-');
    const tokenSegments = [];
    const candidates = [];
    let tokenLength = 0;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!/^\d/.test(seg) && !(i === 0 && /^[A-Za-z]{1,3}\d/.test(seg))) {
            break;
        }
        tokenSegments.push(seg);
        const accumulated = tokenSegments.join('-');
        candidates.push(tokenPrefix + accumulated);
        if (tokenLength === 0 && COMPLETE_PHASE_NUMBER_RE.test(accumulated)) {
            tokenLength = tokenSegments.length;
        }
    }
    if (tokenSegments.length === 0) {
        return { token: name, slug: '', candidates: [name] };
    }
    // No leading run spelled a complete number (e.g. `v2-foo`): keep the whole run.
    if (tokenLength === 0) {
        tokenLength = tokenSegments.length;
    }
    const tokenBody = tokenSegments.slice(0, tokenLength).join('-');
    const slug = name.slice(consumedPrefix.length + tokenBody.length).replace(/^-/, '');
    return { token: tokenPrefix + tokenBody, slug, candidates };
}
/**
 * Extract the phase token from a directory name.
 */
function extractPhaseToken(dirName) {
    return splitPhaseDirName(dirName).token;
}
/**
 * Check if a directory name's phase token matches the normalized phase exactly.
 *
 * Candidates are compared raw AND normalized, so an unpadded hand-made name
 * (`phase-8-…`, `8-…`) resolves against the padded canonical id (`08`).
 */
function phaseTokenMatches(dirName, normalized) {
    const target = String(normalized).toUpperCase();
    const hit = (candidate) => candidate.toUpperCase() === target ||
        normalizePhaseName(candidate).toUpperCase() === target;
    if (splitPhaseDirName(dirName).candidates.some(hit))
        return true;
    const stripped = stripProjectCodePrefix(dirName);
    if (stripped !== dirName && splitPhaseDirName(stripped).candidates.some(hit))
        return true;
    return false;
}
module.exports = {
    escapeRegex,
    OPTIONAL_PROJECT_CODE_PREFIX_SOURCE,
    stripProjectCodePrefix,
    normalizePhaseName,
    getMilestoneFromPhaseId,
    getPhaseDirFromPhaseId,
    phaseMarkdownRegexSource,
    phaseMarkdownRegexSourceExact,
    comparePhaseNum,
    splitPhaseDirName,
    extractPhaseToken,
    phaseTokenMatches,
};
