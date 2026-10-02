#!/usr/bin/env python3
"""WP4b browser checks: QMK/Nape Behaviour tabs on the Svalboard fixture and
the Adept workspace.

Run:  PORT=8152 python3 serve.py
      PORT=8152 python3 tests/browser/qmk-behaviour.py

No hardware: harness.py stubs navigator.hid/serial. The offline sim has no
corner-chord geometry, so offline.js is served with a small patch that gives
channel 0x28 four chords. Screenshots: tests/artifacts/qmk-behaviour/ and,
with WP4B_SHOTS=dir, copies named wp4b-*.png for the report.
"""
import json
import os
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness as H  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = H.ROOT / 'tests' / 'artifacts' / 'qmk-behaviour'
SHOTS = Path(os.environ['WP4B_SHOTS']) if os.environ.get('WP4B_SHOTS') else None
fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)
        print('FAIL', msg)


def shot(page, name):
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / f'{name}.png'
    page.screenshot(path=str(p))
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        shutil.copy(p, SHOTS / f'wp4b-{name}.png')


CHORD_PATCH = """
;{
  const _gb = OfflineFlask.prototype.getBytes, _gu = OfflineFlask.prototype.getU16;
  OfflineFlask.prototype.getU16 = async function (ch, id) {
    if (ch === CH.corner && id === V.ccDefCount) return 4;
    return _gu.call(this, ch, id);
  };
  OfflineFlask.prototype.getBytes = async function (ch, id, payload = []) {
    if (ch === CH.corner && id === V.ccDef) { const d = payload[0]; return [d, (d << 3) | 1, (d << 3) | 2, 0]; }
    if (ch === CH.corner && id === V.ccLayers) return [payload[0], 0, 0];
    if (ch === CH.corner && id === V.ccOut) return [payload[0], payload[1], 0x00, 0x04 + payload[0]];
    return _gb.call(this, ch, id, payload);
  };
}
"""


def patch_offline(ctx):
    def handler(route):
        body = (H.ROOT / 'offline.js').read_text() + CHORD_PATCH
        route.fulfill(status=200, content_type='text/javascript', body=body)
    ctx.route(re.compile(r'.*/offline\.js(\?.*)?$'), handler)


def goto_tab(page, group, tab):
    page.locator('.tab-groups button', has_text=group).click()
    page.locator(f'.tab-row button[data-tab="{tab}"]').click()
    page.wait_for_timeout(300)


def labels(page, group):
    page.locator('.tab-groups button', has_text=group).click()
    return page.locator('.tab-row button[data-tab]').evaluate_all('xs => xs.map(x => x.textContent)')


def ws_state(page, key):
    return page.evaluate('(k) => JSON.parse(localStorage.getItem("flask-offline-" + k))', key)


def select_key(page, n=0):
    page.locator('.kb-svg .keycap').nth(n).click()


def svalboard(browser):
    ctx, page, errors = H.new_context(browser)
    patch_offline(ctx)
    H.open_workspace(page, H.SVAL['label'])
    key = H.SVAL['key']

    # --- tab sets (spec 1.4) ---
    beh = labels(page, 'Behaviour')
    check(beh == ['Macros', 'Tap Dance', 'Combos', 'Key Overrides', 'Chords', 'Leader', 'Shift Keys'], f'svalboard behaviour tabs: {beh}')
    dev = labels(page, 'Device')
    check(dev == ['Mouse Chords', 'Mouse', 'Typing', 'QMK Settings', 'Keyboard'], f'svalboard device tabs: {dev}')

    # --- Typing: no leader/CSK cards, two links that work ---
    goto_tab(page, 'Device', 'typing')
    titles = page.locator('[data-panel="typing"] .card h3').evaluate_all('xs => xs.map(x => x.firstChild.textContent)')
    check(not any(re.search(r'leader sequences|custom shift|^leader key|super leader', t, re.I) for t in titles), f'typing still has leader/csk cards: {titles}')
    check(page.locator('[data-panel="typing"] [data-goto]').count() == 2, 'typing: two link buttons')
    shot(page, 'svalboard-typing-links')
    page.locator('[data-panel="typing"] [data-goto="qmk-leader"]').click()
    page.wait_for_timeout(500)
    check(page.locator('[data-panel="qmk-leader"].active').count() == 1, 'typing link -> Leader tab did not open')
    shot(page, 'svalboard-leader')
    goto_tab(page, 'Device', 'typing')
    page.locator('[data-panel="typing"] [data-goto="qmk-shift"]').click()
    page.wait_for_timeout(500)
    check(page.locator('[data-panel="qmk-shift"].active').count() == 1, 'typing link -> Shift Keys tab did not open')
    # shift preset writes a pair and registers the channel for the one Save
    page.locator('[data-panel="qmk-shift"] button', has_text='⌫ → ⌦').click()
    page.wait_for_timeout(300)
    check(page.locator('[data-panel="qmk-shift"] .csk-pair').count() >= 1, 'shift preset added no pair')
    shot(page, 'svalboard-shift')

    # --- Tap dance: tile click pastes TD(0) onto the selected key ---
    select_key(page, 3)
    goto_tab(page, 'Behaviour', 'tapdance')
    check(page.locator('[data-panel="tapdance"] .tile').count() == 32, 'tapdance: 32 tiles')
    page.locator('[data-panel="tapdance"] .tile').first.click()
    page.wait_for_timeout(300)
    km = ws_state(page, key)['dirty']['km']
    check(any(v == 0x5700 for v in km.values()), f'TD0 not pasted (dirty.km={km})')
    shot(page, 'svalboard-tapdance')
    # pencil: rows are the four fixed tap-count rows, step picked via the sheet picker
    page.locator('[data-panel="tapdance"] .tile .tile-edit').nth(1).click()
    check(page.locator('.sheet [data-td-row]').count() == 4, 'td sheet: four rows')
    page.locator('.sheet [data-td-row="onTap"] button.code').click()
    page.locator('.modal-back').last.locator('.bp-search').fill('esc')
    page.wait_for_timeout(200)
    page.locator('.modal-back').last.locator('.bp-grid button, .bp-body button.kp, .bp-body button').filter(has_text=re.compile(r'^Esc$')).first.click()
    page.wait_for_timeout(300)
    td = ws_state(page, key)['entries']['td']
    check(td.get('1', {}).get('onTap') == 0x29, f'td1 onTap != Esc: {td}')
    shot(page, 'svalboard-td-sheet')
    page.keyboard.press('Escape')

    # --- Macros: tile grid + sheet adds Type text, Tap, Delay ---
    goto_tab(page, 'Behaviour', 'macros')
    check(page.locator('[data-panel="macros"] .tile').count() == 16, 'macros: 16 tiles')
    page.locator('[data-panel="macros"] .tile .tile-edit').first.click()
    page.locator('.sheet [data-add="text"]').click()
    page.locator('.sheet input.step-text').fill('hello world')
    page.locator('.sheet [data-add="tap"]').click()
    page.locator('.modal-back').last.locator('.bp-search').fill('a')
    page.wait_for_timeout(200)
    page.locator('.modal-back').last.locator('.bp-body button').filter(has_text=re.compile(r'^A$')).first.click()
    page.wait_for_timeout(300)
    page.locator('.sheet [data-add="delay"]').click()
    check(page.locator('.sheet [data-step]').count() == 3, 'macro sheet: three steps')
    shot(page, 'svalboard-macro-sheet')
    page.locator('.sheet [data-save]').click()
    page.wait_for_timeout(400)
    lst = ws_state(page, key)['macros']['list']
    check(lst and [a['t'] for a in lst[0]] == ['text', 'tap', 'delay'], f'macro 0 saved wrong: {lst and lst[0]}')
    check('types' in page.locator('[data-panel="macros"] .tile').first.inner_text() or '3 steps' in page.locator('[data-panel="macros"] .tile').first.inner_text(), 'macro tile summary')
    shot(page, 'svalboard-macros')

    # --- Combos / overrides tiles open sheets ---
    goto_tab(page, 'Behaviour', 'combos')
    page.locator('[data-panel="combos"] .tile').first.click()
    check(page.locator('.sheet').count() == 1, 'combo tile click should open its sheet')
    page.keyboard.press('Escape')
    goto_tab(page, 'Behaviour', 'overrides')
    check(page.locator('[data-panel="overrides"] .tile').count() == 32, 'overrides: 32 tiles')

    # --- Chords: boxes on the board while the tab is open, gone after ---
    goto_tab(page, 'Behaviour', 'corner')
    page.wait_for_timeout(500)
    check(page.locator('.kb-svg .chord-box').count() == 4, f'chord boxes on board: {page.locator(".kb-svg .chord-box").count()}')
    check(page.locator('.bd-layerbar .bd-note').count() == 1, 'layer bar note while Chords is open')
    shot(page, 'svalboard-chords')
    page.locator('.kb-svg .chord-box').first.click()
    page.wait_for_timeout(300)
    check(page.locator('.modal-back').count() == 1, 'clicking a chord box opens its picker')
    page.keyboard.press('Escape')
    # channel 0x28 must never reach the one Save
    dirty = page.evaluate('async () => (await import("./save-state.js?v=60")).saveState.dirty().map(d => d.source)')
    check(0x28 not in dirty, f'0x28 registered: {dirty}')
    goto_tab(page, 'Behaviour', 'macros')
    check(page.locator('.kb-svg .chord-box').count() == 0, 'chord boxes should clear when leaving the tab')

    errors = [e for e in errors if 'Hardware disabled' not in e]
    check(not errors, f'svalboard errors: {errors}')
    ctx.close()


def adept(browser):
    ctx, page, errors = H.new_context(browser)
    H.open_workspace(page, 'Ploopy Adept')
    check(labels(page, 'Behaviour') == ['Macros', 'Tap Dance', 'Combos', 'Key Overrides', 'Leader', 'Shift Keys'], f'adept behaviour tabs')
    # v11 firmware: gesture slots fire via tap_code16, so Layers and Run are hidden
    goto_tab(page, 'Device', 'gestures')
    page.locator('[data-panel="gestures"] button.code').first.click()
    page.wait_for_timeout(300)
    chips = page.locator('.modal-back .bp-groups .chip').evaluate_all('xs => xs.map(x => x.textContent.trim())')
    check(chips and 'Layers' not in chips and 'Run' not in chips, f'adept gesture picker groups: {chips}')
    shot(page, 'adept-gesture-picker')
    page.keyboard.press('Escape')
    goto_tab(page, 'Behaviour', 'qmk-leader')
    check(page.locator('[data-panel="qmk-leader"] .card').count() >= 1, 'adept leader renders')
    shot(page, 'adept-leader')
    errors = [e for e in errors if 'Hardware disabled' not in e]
    check(not errors, f'adept errors: {errors}')
    ctx.close()


def dev_harness(browser):
    ctx, page, errors = H.new_context(browser)
    page.goto(H.URL + 'dev-sval-harness.html')
    page.wait_for_function('document.getElementById("result").textContent !== "running…"', timeout=20000)
    text = page.locator('#result').inner_text()
    check(text.startswith('all tabs rendered'), f'dev harness: {text[:300]}')
    errors = [e for e in errors if 'Failed to load resource' not in e]   # favicon
    check(not errors, f'dev harness errors: {errors}')
    ctx.close()


def main():
    with sync_playwright() as p:
        browser = H.launch(p)
        for fn in (svalboard, adept, dev_harness):
            try:
                fn(browser)
            except Exception as e:  # noqa: BLE001
                fails.append(f'{fn.__name__}: {e}')
                print('FAIL', fn.__name__, e)
        browser.close()
    print('qmk-behaviour:', 'FAIL' if fails else 'PASS')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
