#!/usr/bin/env python3
"""WP3 browser checks: the catalog BindingPicker in its three hosts.

Run:  PORT=8143 python3 serve.py
      PORT=8143 python3 tests/browser/picker.py

No hardware: harness.py stubs navigator.hid/serial. The flask_holdtap
channel (0x2A) is mocked in the page; the offline sim does not serve it.
Screenshots: tests/artifacts/picker/ and, with WP3_SHOTS=dir, the three
host shots for the report.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness as H  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = H.ROOT / 'tests' / 'artifacts' / 'picker'
SHOTS = Path(os.environ['WP3_SHOTS']) if os.environ.get('WP3_SHOTS') else None

OPEN = """async ({surface, host, title, position, live}) => {
  const bp = await import('./binding-picker.js?v=61');
  const cat = await import('./behavior-catalog.js?v=61');
  window.__picked = [];
  let app = {};
  if (live) {
    // flask_holdtap mock: contract bytes, 38 key slots, slot 20 = 280 ms.
    const t = Array.from({length: 38}, () => ({term: 200, quick: 0, idle: 0, flavor: 1}));
    t[20] = {term: 280, quick: 175, idle: 150, flavor: 1};
    const fr = (i) => [i, t[i].term >> 8, t[i].term & 255, t[i].quick >> 8, t[i].quick & 255, t[i].idle >> 8, t[i].idle & 255, t[i].flavor, 0];
    window.__holdtap = t;
    app = { protocolVersion: 17, flask: {
      async getU16(ch, id) { if (ch !== 0x2A) throw new Error('unhandled'); return 38; },
      async getBytes(ch, id, [i]) { return fr(i); },
      async setBytes(ch, id, p) { t[p[0]].term = Math.max(50, Math.min(1000, (p[1] << 8) | p[2])); return fr(p[0]); },
      async save() {},
    } };
    await cat.attachHoldtap(app);
  }
  window.__close?.();
  const anchor = host === 'docked' ? document.querySelector('#wp3-dock') : document.querySelector('.kb-svg .keycap');
  window.__close = bp.openPicker({ surface, host, title, anchor, app, position,
    onPick: (v) => window.__picked.push(v) });
  return true;
}"""


def picker_root(page):
    return page.locator('.picker.bp').last


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
    fails = []
    check = lambda c, m: c or fails.append(m)  # noqa: E731
    with sync_playwright() as p:
        browser = H.launch(p)

        # ---------------- TOTEM ----------------
        ctx, page, errors = H.new_context(browser, viewport=(1440, 1000), seeds=())
        H.open_workspace(page, 'TOTEM (ZMK)')
        fx = json.loads((H.FIXTURES / 'totem-behaviors.json').read_text())
        bid = {b['displayName']: b['id'] for b in fx['behaviors'] if b['displayName']}

        # Docked (the keymap tab's picker is the catalog picker now).
        dock = page.locator('#panels .panel.active .picker.bp').first
        dock.wait_for()
        groups = dock.locator('.bp-groups .chip').all_inner_texts()
        check(groups == ['Keys', 'Modifiers', 'Layers', 'Media & System', 'Run'], f'totem groups {groups}')
        # Search "esc": one Esc key, nothing duplicated.
        dock.locator('.bp-search').fill('esc')
        names = dock.locator('.bp-key').evaluate_all('xs => xs.map(x => x.getAttribute("aria-label"))')
        check(names.count('Escape') == 1, f'search esc keys {names}')
        check(len(names) == len(set(names)), f'search esc duplicates {names}')
        dock.locator('.bp-search').fill('')

        # Key 0 → Modifiers › Mod-tap, tap A, Fast → the sim gets Mod-Tap (fast 150).
        page.locator('.kb-svg .keycap').first.click()
        dock.locator('.bp-groups .chip', has_text='Modifiers').click()
        row = dock.locator('.bp-entry[data-entry="mod-tap"]')
        # The offline sim serves flask_holdtap (0x2A) now, so the picker defaults to
        # live timing; pick the compiled source to exercise the variant chips.
        row.locator('.bp-seg[aria-label="Timing source"] .chip', has_text='Compiled timing').click()
        seg = row.locator('.bp-seg[aria-label="Timing"] .chip').all_inner_texts()
        check(seg == ['Fast · 150 ms', 'Standard · 200 ms', 'Slow · 300 ms'], f'timing chips {seg}')
        row.locator('.bp-ctl', has_text='Tap').locator('.bp-key').click()
        row.locator('.bp-nested .bp-key[aria-label="A"]').click()
        row = dock.locator('.bp-entry[data-entry="mod-tap"]')
        row.locator('.chip', has_text='Fast · 150 ms').click()
        dock.locator('.bp-entry[data-entry="mod-tap"] .bp-assign').click()
        page.wait_for_timeout(400)
        ws = json.loads(page.evaluate("localStorage.getItem('flask-offline-totem')"))
        b0 = ws['zmk']['keymap']['layers'][0]['bindings'][0]
        check(b0['behaviorId'] == bid['Mod-Tap (fast 150)'] and b0['param2'] == 0x70004,
              f'fast mod-tap in sim: {b0}')
        dock.screenshot(path=str(OUT / 'totem-docked.png'))
        if SHOTS:
            page.locator('#panels .panel.active').screenshot(path=str(SHOTS / 'wp3-docked.png'))

        # Popover on a key.
        page.evaluate(OPEN, {'surface': 'zmk.key', 'host': 'popover', 'title': 'Key 1', 'position': None, 'live': False})
        pop = page.locator('.picker-popover')
        check(pop.count() == 1, 'popover open')
        pop.locator('.chip', has_text='Layers').click()
        page.screenshot(path=str(OUT / 'totem-popover.png'))
        if SHOTS:
            page.screenshot(path=str(SHOTS / 'wp3-popover.png'))
        page.keyboard.press('Escape')
        check(page.locator('.picker-popover').count() == 0, 'popover closes on Escape')

        # Sheet: combo output (no Leader, no Advanced) and leader output (no Layers).
        page.evaluate(OPEN, {'surface': 'zmk.comboOutput', 'host': 'sheet', 'title': 'Combo 3 output', 'position': None, 'live': False})
        sheet = page.locator('.picker-sheet')
        check(sheet.locator('h2').inner_text() == 'Combo 3 output', 'sheet title')
        sheet.locator('.chip', has_text='Run').click()
        run = sheet.locator('.bp-entry').evaluate_all('xs => xs.map(x => x.dataset.entry)')
        check(run == ['macro', 'tap-dance'], f'combo output Run entries {run}')
        check('Advanced' not in sheet.locator('.bp-groups .chip').all_inner_texts(), 'combo output hides Advanced')
        sheet.locator('.chip', has_text='Modifiers').click()
        page.screenshot(path=str(OUT / 'totem-sheet.png'))
        if SHOTS:
            page.screenshot(path=str(SHOTS / 'wp3-sheet.png'))
        page.keyboard.press('Escape')
        page.evaluate(OPEN, {'surface': 'zmk.typedOutput', 'host': 'sheet', 'title': 'Sequence 1 output', 'position': None, 'live': False})
        g = page.locator('.picker-sheet .bp-groups .chip').all_inner_texts()
        check(g == ['Keys', 'Media & System', 'Run'], f'leader output groups {g}')
        page.locator('.picker-sheet .chip', has_text='Media & System').click()
        media = page.locator('.picker-sheet .bp-entry').evaluate_all('xs => xs.map(x => x.dataset.entry)')
        check(media == ['media-key'], f'typed output Media entries {media}')
        page.keyboard.press('Escape')
        page.evaluate(OPEN, {'surface': 'zmk.cskBase', 'host': 'sheet', 'title': 'Base key', 'position': None, 'live': False})
        check(page.locator('.picker-sheet .bp-mods').count() == 0, 'CSK base has no mods row')
        page.keyboard.press('Escape')

        # Live per-key timing (mocked 0x2A, proto 17): slider at key 20.
        page.evaluate(OPEN, {'surface': 'zmk.key', 'host': 'sheet', 'title': 'Key 20', 'position': 20, 'live': True})
        sheet = page.locator('.picker-sheet')
        sheet.locator('.chip', has_text='Modifiers').click()
        row = sheet.locator('.bp-entry[data-entry="mod-tap"]')
        check(row.locator('input[type=range]').count() == 1, 'live slider shown')
        row.locator('.bp-ctl', has_text='Tap').locator('.bp-key').click()
        row.locator('.bp-nested .bp-key[aria-label="T"]').click()
        row = sheet.locator('.bp-entry[data-entry="mod-tap"]')
        row.locator('input[type=range]').evaluate('(s) => { s.value = 330; s.dispatchEvent(new Event("input")); }')
        row.locator('.bp-assign').click()
        page.wait_for_timeout(300)
        picked = page.evaluate('window.__picked')
        term = page.evaluate('window.__holdtap[20].term')
        check(picked and picked[-1]['behaviorId'] == bid['Hold-Tap (live)'], f'live pick {picked}')
        check(term == 330, f'slot 20 term {term}')
        if SHOTS:
            page.evaluate(OPEN, {'surface': 'zmk.key', 'host': 'sheet', 'title': 'Key 20', 'position': 20, 'live': True})
            page.locator('.picker-sheet .chip', has_text='Modifiers').click()
            page.screenshot(path=str(SHOTS / 'wp3-live-timing.png'))
            page.keyboard.press('Escape')
        fails += [f'totem: {e}' for e in errors]
        ctx.close()

        # ---------------- Imprint ----------------
        ctx, page, errors = H.new_context(browser, seeds=())
        H.open_workspace(page, 'Cyboard Imprint (ZMK)')
        page.evaluate(OPEN, {'surface': 'zmk.typedOutput', 'host': 'sheet', 'title': 'Gesture E', 'position': None, 'live': False})
        page.locator('.picker-sheet .chip', has_text='Run').click()
        run = page.locator('.picker-sheet .bp-entry').evaluate_all('xs => xs.map(x => x.dataset.entry)')
        check(run == ['macro'], f'imprint gesture Run {run}')
        page.keyboard.press('Escape')
        fails += [f'imprint: {e}' for e in errors]
        ctx.close()
        browser.close()
    for f in fails:
        print('FAIL', f)
    print('picker:', 'FAIL' if fails else 'PASS')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
