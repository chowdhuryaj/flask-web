// Environment preflight: why can't this browser talk to the keyboard?
//
// Three failures look identical to a user ("Connect did nothing") and the
// #unsupported banner only ever caught the first:
//   1. no WebHID at all            — wrong browser, or the page isn't HTTPS
//   2. WebHID present but BLOCKED   — enterprise policy (the locked-down
//      workstation case): navigator.hid exists, the chooser never opens
//   3. WebHID fine, no device       — nothing enumerating 0xFF60, or the
//      OS/another app has it
//
// Passive checks run with no user gesture. The active probe needs a click
// (requestDevice is gesture-gated) and is what actually separates 2 from 3:
// a policy block returns an empty array WITHOUT ever painting a chooser, so
// it comes back far faster than a human can dismiss a dialog. That timing
// split is a heuristic; the unfiltered second probe is the confirmation —
// if the all-devices chooser opens, WebHID is allowed and the problem is the
// device, not the policy.

import { el } from './ui.js?v=18';
import { diag } from './diag.js?v=18';
import { USAGE_PAGE, USAGE } from './webhid.js?v=18';

// Below this, no human dismissed a dialog — the chooser never appeared.
const CHOOSER_FLOOR_MS = 400;

// tone = the existing .pill modifier; per the design system the DOT carries
// the colour and the text stays ink (--warn/--danger fail contrast as text).
const VERDICT = {
    ok: { label: 'Ready', tone: 'connected' },
    insecure: { label: 'Not HTTPS', tone: 'bad' },
    noApi: { label: 'No WebHID', tone: 'bad' },
    policy: { label: 'Blocked by policy', tone: 'bad' },
    noDevice: { label: 'No keyboard found', tone: 'warn' },
    unknown: { label: 'Needs the device probe', tone: 'warn' },
};

function isChromium() {
    const brands = navigator.userAgentData?.brands;
    if (brands?.length) return brands.some((b) => /Chromium/i.test(b.brand));
    return /Chrome|Chromium|Edg\//.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent);
}

function browserName() {
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua)) return `Edge ${ua.match(/Edg\/([\d.]+)/)?.[1] ?? ''}`.trim();
    if (/Firefox/.test(ua)) return 'Firefox';
    if (/Chrome/.test(ua)) return `Chrome ${ua.match(/Chrome\/([\d.]+)/)?.[1] ?? ''}`.trim();
    if (/Safari/.test(ua)) return 'Safari';
    return 'unknown browser';
}

/** Permissions-Policy check. Catches iframe/header blocks; NOT enterprise policy. */
function policyAllows(feature) {
    const pp = document.permissionsPolicy ?? document.featurePolicy;
    if (!pp?.allowsFeature) return null; // unknown, not a failure
    try { return pp.allowsFeature(feature); } catch { return null; }
}

/**
 * Everything decidable without a click.
 * @returns {{verdict:string, checks:Array, hid:boolean, serial:boolean}}
 */
export async function passiveChecks() {
    const checks = [];
    const add = (name, state, detail) => checks.push({ name, state, detail });

    const secure = window.isSecureContext;
    add('Secure context (HTTPS)', secure ? 'pass' : 'fail',
        secure ? location.origin
            : `${location.origin} — WebHID is hidden entirely off HTTPS, which looks exactly like an unsupported browser`);

    const chromium = isChromium();
    add('Chromium-based browser', chromium ? 'pass' : 'fail', browserName());

    // Truthiness, not `in` — an API that exists but is unusable must read as
    // "no WebHID", never as a policy block.
    const hasHid = !!navigator.hid?.requestDevice;
    add('navigator.hid present', hasHid ? 'pass' : 'fail',
        hasHid ? 'the WebHID API exists' : 'no WebHID API on this page');

    const hasSerial = !!navigator.serial?.requestPort;
    add('navigator.serial present', hasSerial ? 'pass' : 'warn',
        hasSerial ? 'the ZMK Studio keymap editor can run'
            : 'no WebSerial — tuning tabs would still work, the keymap editor would not');

    const hidPolicy = policyAllows('hid');
    if (hidPolicy === false) add('Permissions-Policy allows hid', 'fail', 'this document is denied the hid feature');
    else if (hidPolicy === true) add('Permissions-Policy allows hid', 'pass', 'document-level policy is fine');

    const serialPolicy = policyAllows('serial');
    if (serialPolicy === false) add('Permissions-Policy allows serial', 'fail', 'this document is denied the serial feature');

    // getDevices() rejecting (rather than returning []) is itself a policy tell.
    let granted = [];
    let getDevicesThrew = null;
    if (hasHid) {
        try {
            const all = await navigator.hid.getDevices();
            granted = all.filter((d) => d.collections?.some(
                (c) => c.usagePage === USAGE_PAGE && c.usage === USAGE));
            add('Previously-granted devices', granted.length ? 'pass' : 'info',
                granted.length
                    ? granted.map((d) => `${d.productName ?? 'device'} ${hex4(d.vendorId)}:${hex4(d.productId)}`).join(', ')
                    : 'none yet — normal on a first visit, tells us nothing on its own');
        } catch (e) {
            getDevicesThrew = e;
            add('Previously-granted devices', 'fail', `getDevices() threw ${e.name}: ${e.message}`);
        }
    }

    let verdict = 'unknown';
    if (!secure && !hasHid) verdict = 'insecure';
    else if (!hasHid) verdict = 'noApi';
    else if (hidPolicy === false || getDevicesThrew) verdict = 'policy';

    return { verdict, checks, hid: hasHid, serial: hasSerial, granted };
}

function hex4(n) { return (n ?? 0).toString(16).padStart(4, '0'); }

/**
 * Active probe — needs a user gesture. Opens the browser's device chooser
 * (filtered to raw HID), then, if that comes back empty, an unfiltered one.
 * @returns {{verdict:string, detail:string, timings:object}}
 */
export async function activeProbe() {
    // Truthiness, not `in`: a present-but-undefined navigator.hid would fall
    // through to a TypeError and get misreported as an unknown failure.
    if (!navigator.hid?.requestDevice) {
        return { verdict: 'noApi', detail: 'This browser exposes no usable WebHID API — nothing to probe. Use Edge or Chrome, over HTTPS.' };
    }

    const timings = {};
    let filtered;
    const t0 = performance.now();
    try {
        filtered = await navigator.hid.requestDevice({
            filters: [{ usagePage: USAGE_PAGE, usage: USAGE }],
        });
    } catch (e) {
        timings.filtered = Math.round(performance.now() - t0);
        diag.log('preflight', `filtered requestDevice threw ${e.name} in ${timings.filtered}ms`);
        // SecurityError = permissions policy. NotAllowedError off a real click
        // is Chromium's enterprise-block shape.
        const policyish = e.name === 'SecurityError' || e.name === 'NotAllowedError';
        return {
            verdict: policyish ? 'policy' : 'unknown',
            timings,
            detail: policyish
                ? `The browser refused the request outright (${e.name}: ${e.message}). That is a policy block, not a missing keyboard — check edge://policy for DefaultWebHidGuardSetting and WebHidBlockedForUrls.`
                : `requestDevice threw ${e.name}: ${e.message}`,
        };
    }
    timings.filtered = Math.round(performance.now() - t0);

    if (filtered.length) {
        diag.log('preflight', `filtered chooser returned ${filtered.length} device(s) in ${timings.filtered}ms`);
        return {
            verdict: 'ok',
            timings,
            device: filtered[0],
            detail: `WebHID works and the keyboard's raw-HID interface (usage page 0x${USAGE_PAGE.toString(16)}) is visible. Nothing is blocking you — hit Connect.`,
        };
    }

    // Empty. Either the chooser never opened (policy) or it opened and had
    // nothing worth choosing (device). Time is the first clue.
    const instant = timings.filtered < CHOOSER_FLOOR_MS;
    diag.log('preflight', `filtered chooser empty in ${timings.filtered}ms (instant=${instant})`);

    let unfiltered;
    const t1 = performance.now();
    try {
        unfiltered = await navigator.hid.requestDevice({ filters: [] });
    } catch (e) {
        timings.unfiltered = Math.round(performance.now() - t1);
        return {
            verdict: 'policy',
            timings,
            detail: `The filtered chooser came back empty and the unfiltered one threw ${e.name}: ${e.message}. WebHID is blocked here.`,
        };
    }
    timings.unfiltered = Math.round(performance.now() - t1);
    diag.log('preflight', `unfiltered chooser returned ${unfiltered.length} in ${timings.unfiltered}ms`);

    if (unfiltered.length) {
        return {
            verdict: 'noDevice',
            timings,
            detail: `WebHID itself is allowed — the unfiltered chooser opened and you picked "${unfiltered[0].productName ?? 'a device'}". So the problem is the keyboard's raw-HID interface: it is not enumerating usage page 0x${USAGE_PAGE.toString(16)}/0x${USAGE.toString(16)} to this user. Check that the LEFT half is the one plugged in, and that no other Flask app has it open.`,
        };
    }

    if (timings.filtered < CHOOSER_FLOOR_MS && timings.unfiltered < CHOOSER_FLOOR_MS) {
        return {
            verdict: 'policy',
            timings,
            detail: `Both choosers returned empty in ${timings.filtered}ms / ${timings.unfiltered}ms — faster than any dialog a human could dismiss. The chooser never opened, which means enterprise policy is blocking WebHID on this site. Open edge://policy and look for DefaultWebHidGuardSetting (2 = block) and WebHidBlockedForUrls.`,
        };
    }

    return {
        verdict: 'noDevice',
        timings,
        detail: `The chooser opened (${timings.unfiltered}ms) but listed no keyboard you picked. WebHID is allowed; the device is not reaching the browser. Try a different USB port/cable, and make sure the left half is the one connected.`,
    };
}

/** Copyable text report — AJ reads this back from a box I can't drive. */
export function reportText(passive, active) {
    // Globals stay inside the function (diag.js's rule) so this module keeps
    // importing cleanly under node for the vector suite.
    const href = typeof location !== 'undefined' ? location.href : '(no location)';
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '(no navigator)';
    const lines = ['Flask preflight', new Date().toISOString(), href, ua, ''];
    for (const c of passive.checks) {
        lines.push(`[${c.state.toUpperCase().padEnd(4)}] ${c.name} — ${c.detail}`);
    }
    lines.push('', `Passive verdict: ${passive.verdict}`);
    if (active) {
        lines.push(`Probe verdict:   ${active.verdict}`);
        lines.push(`Probe timings:   ${JSON.stringify(active.timings ?? {})}`);
        lines.push(`Probe detail:    ${active.detail}`);
    }
    return lines.join('\n');
}

const STATE_ICON = { pass: '✓', fail: '✕', warn: '!', info: '·' };

/**
 * The panel. Renders passive results immediately, offers the probe behind a
 * button (gesture), and always offers the copyable report.
 */
export async function renderPreflight(host) {
    const passive = await passiveChecks();
    let active = null;

    const body = el('div', { class: 'preflight-body' });
    const verdictPill = el('span', { class: 'pill' });
    const detail = el('p', { class: 'faint' });

    const paint = () => {
        const v = VERDICT[active?.verdict ?? passive.verdict] ?? VERDICT.unknown;
        verdictPill.className = `pill ${v.tone}`;
        verdictPill.replaceChildren(el('span', { class: 'dot' }), el('span', { text: v.label }));
        detail.textContent = active?.detail ?? verdictDetail(passive.verdict);
        body.replaceChildren(...passive.checks.map((c) => el('div', { class: `preflight-row ${c.state}` },
            el('span', { class: 'preflight-icon', text: STATE_ICON[c.state] ?? '·' }),
            el('span', { class: 'preflight-name', text: c.name }),
            el('span', { class: 'preflight-detail faint', text: c.detail }))));
    };

    const probeBtn = el('button', { class: 'btn primary', text: 'Probe for the keyboard' });
    probeBtn.addEventListener('click', async () => {
        probeBtn.disabled = true;
        probeBtn.textContent = 'Probing…';
        try {
            active = await activeProbe();
        } catch (e) {
            active = { verdict: 'unknown', detail: `Probe failed: ${e.message}` };
        }
        probeBtn.disabled = false;
        probeBtn.textContent = 'Probe again';
        paint();
    });

    const copyBtn = el('button', { class: 'btn', text: 'Copy report' });
    copyBtn.addEventListener('click', async () => {
        const text = reportText(passive, active);
        try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied'; }
        catch { window.prompt('Copy this report:', text); }
        setTimeout(() => { copyBtn.textContent = 'Copy report'; }, 1500);
    });

    paint();
    host.replaceChildren(
        el('div', { class: 'preflight-head' },
            el('h3', { text: 'Compatibility check' }), verdictPill),
        detail,
        body,
        el('p', { class: 'faint' },
            'The probe opens the browser\'s own device chooser. If no chooser appears at all, that is the answer: policy is blocking WebHID, not a missing keyboard.'),
        el('div', { class: 'preflight-actions' }, probeBtn, copyBtn));
    return { passive, probe: () => active };
}

function verdictDetail(v) {
    switch (v) {
    case 'insecure':
        return 'This page is not on HTTPS, so the browser hides WebHID completely. Use the https:// address — off a secure origin this is indistinguishable from an unsupported browser.';
    case 'noApi':
        return 'This browser has no WebHID. Use Edge or Chrome — Firefox and Safari have never shipped it.';
    case 'policy':
        return 'WebHID exists but this page is denied it. On a managed machine open edge://policy and look for DefaultWebHidGuardSetting, WebHidBlockedForUrls, and URLBlocklist.';
    default:
        return 'The passive checks pass, which means the browser is capable. Whether it is allowed to reach the keyboard needs the probe below — it is the only thing that can tell a policy block apart from a missing device.';
    }
}
