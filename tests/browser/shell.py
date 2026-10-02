#!/usr/bin/env python3
"""WP1 shell checks. Run:  PORT=8141 python3 serve.py  then
PORT=8141 python3 tests/browser/shell.py

Hardware is stubbed (see harness.py). Checks, per offline workspace:
group chips (spec 1.4), no <header>, the board slot stays put while the
palette scrolls, caption text follows hover, screenshots at 1440x1000 and
900x1000. Plus: keybr Dark is the default, theme and text size persist across
reload, and the command palette offers "Assign to selected key" when a key
is selected. Screenshots land in tests/artifacts/shell/.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness as h  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = h.ROOT / 'tests' / 'artifacts' / 'shell'
GROUPS = ['Keys', 'Behaviour', 'Device', 'Trainer']
SUBSET = {  # tab labels that must exist per group (1.4); WP4 adds more later
    'totem': {'Behaviour': {'Combos', 'Macros', 'Tap Dance', 'Shift Keys', 'Leader'},
              'Device': {'Modes', 'Test', 'Keyboard'}},
    'imprint': {'Behaviour': {'Combos', 'Macros', 'Tap Dance', 'Shift Keys', 'Leader'},
                'Device': {'Mouse', 'Gestures', 'RGB', 'Modes', 'Test', 'Keyboard'}},
    'svalboard': {'Behaviour': {'Macros', 'Tap Dance', 'Combos', 'Key Overrides'},
                  'Device': {'Mouse', 'QMK Settings', 'Keyboard'}},
    'adept': {'Behaviour': {'Macros', 'Tap Dance', 'Combos', 'Key Overrides'},
              'Device': {'QMK Settings', 'Keyboard'}},
}


def tabs_in(page, group):
    page.locator('.tab-groups button', has_text=group).click()
    return set(page.locator('.tab-row button[data-tab]').all_inner_texts())


def check_workspace(browser, name, label, failures):
    for size in ((1440, 1000), (900, 1000)):
        ctx, page, errors = h.new_context(browser, viewport=size)
        h.open_workspace(page, label)
        tag = f'{name}@{size[0]}'
        if size[0] == 1440:
            chips = page.locator('.tab-groups button').all_inner_texts()
            if chips != GROUPS:
                failures.append(f'{tag}: chips {chips} != {GROUPS}')
            for g, want in SUBSET[name].items():
                have = tabs_in(page, g)
                if not want <= have:
                    failures.append(f'{tag}: {g} missing {sorted(want - have)} (have {sorted(have)})')
            page.locator('.tab-groups button', has_text='Keys').click()
            if page.locator('header').count():
                failures.append(f'{tag}: <header> still present')
            if page.locator('#app-frame button#diag-btn, #app-frame #theme-sel, #app-frame #zoom-sel').count():
                failures.append(f'{tag}: old header controls remain')

            # Board slot stays put while the palette scrolls. WP2 fills the
            # slot; until then a stand-in proves the layout pins it.
            page.evaluate("""() => {
              document.getElementById('board-slot').innerHTML = '<div id="stand-in" style="height:120px"></div>';
              const p = document.querySelector('.panel.active');
              p.insertAdjacentHTML('beforeend', '<div style="height:2400px"></div>');
            }""")
            before = page.locator('#board-slot').bounding_box()
            page.evaluate("() => { const b = document.getElementById('palette-body'); b.scrollTop = b.scrollHeight; }")
            if not page.evaluate("() => document.getElementById('palette-body').scrollTop > 100"):
                failures.append(f'{tag}: palette did not scroll')
            after = page.locator('#board-slot').bounding_box()
            if before != after:
                failures.append(f'{tag}: board slot moved {before} -> {after}')
            if page.evaluate("() => document.documentElement.scrollTop") != 0:
                failures.append(f'{tag}: page itself scrolled')
            page.evaluate("() => document.getElementById('board-slot').replaceChildren()")

            # Caption follows hover and restores on leave.
            page.mouse.move(1000, 30)   # off the chip the last click left it on
            page.wait_for_timeout(150)
            default = page.locator('#caption-bar').inner_text()
            page.locator('#zoom-in').hover()
            hovered = page.locator('#caption-bar').inner_text()
            page.mouse.move(1000, 30)
            page.wait_for_timeout(150)
            if hovered == default or 'bigger' not in hovered:
                failures.append(f'{tag}: caption did not change on hover ({hovered!r})')
            if page.locator('#caption-bar').inner_text() != default:
                failures.append(f'{tag}: caption did not restore')
        page.screenshot(path=str(OUT / f'{name}-{size[0]}.png'))
        failures += [f'{tag}: {e}' for e in errors]
        ctx.close()


def check_appearance(browser, failures):
    ctx, page, errors = h.new_context(browser)
    page.goto(h.URL)
    page.wait_for_selector('#landing')
    bg = page.evaluate("() => document.documentElement.style.getPropertyValue('--bg')")
    if bg != '#2b2b2b':
        failures.append(f'default theme is not keybr Dark (--bg={bg!r})')
    fs = page.evaluate("() => getComputedStyle(document.documentElement).fontSize")
    if fs != '18.4px':
        failures.append(f'text scale default: font-size {fs} != 18.4px')
    page.locator('#offline-list .dev-item').filter(has_text='TOTEM').first.click()
    page.locator('#panels .panel.active').wait_for()
    page.locator('.tab-groups button', has_text='Device').click()
    page.locator('.tab-row button[data-tab=keyboard]').click()
    page.locator('.kb-theme[data-theme-id=nord]').click()
    page.locator('.kb-tab input[type=range]').fill('1.3')
    page.locator('#zoom-in').click()
    page.reload()
    page.wait_for_selector('#landing')
    got = page.evaluate("""() => [document.documentElement.style.getPropertyValue('--bg'),
        getComputedStyle(document.documentElement).fontSize,
        document.documentElement.style.getPropertyValue('--board-zoom')]""")
    if got != ['#2e3440', '20.8px', '1.1']:
        failures.append(f'appearance did not persist: {got}')
    failures += [f'appearance: {e}' for e in errors]
    ctx.close()


def check_assign_command(browser, failures):
    ctx, page, errors = h.new_context(browser)
    h.open_workspace(page, 'TOTEM (ZMK)')

    def labels():
        page.keyboard.press('Control+k')
        page.locator('.cp-input').fill('assign')
        out = page.locator('.cp-title').all_inner_texts()
        page.keyboard.press('Escape')
        return out
    if labels():
        failures.append('palette offers Assign with no key selected')
    page.evaluate("""async () => {
      const { board } = await import('./board.js?v=1');
      board.selectedKey = () => ({ layer: 0, pos: 1 });
    }""")
    if 'Assign to selected key…' not in labels():
        failures.append('palette lacks "Assign to selected key…" with a key selected')
    # Status bar Save segment follows saveState.
    page.evaluate("""async () => {
      const { saveState } = await import('./save-state.js?v=1');
      saveState.markDirty('studio-keymap', 'keymap', async () => {});
    }""")
    txt = page.locator('#save-btn').inner_text()
    if '1 unsaved' not in txt:
        failures.append(f'status bar save text: {txt!r}')
    failures += [f'assign: {e}' for e in errors]
    ctx.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    failures = []
    with sync_playwright() as p:
        browser = h.launch(p)
        for name, (label, _) in h.WORKSPACES.items():
            try:
                check_workspace(browser, name, label, failures)
            except Exception as e:  # noqa: BLE001
                failures.append(f'{name}: {e}')
            print(f'{name}: done')
        for fn in (check_appearance, check_assign_command):
            try:
                fn(browser, failures)
            except Exception as e:  # noqa: BLE001
                failures.append(f'{fn.__name__}: {e}')
        browser.close()
    for f in failures:
        print('FAIL', f)
    print('shell:', 'FAIL' if failures else 'PASS')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
