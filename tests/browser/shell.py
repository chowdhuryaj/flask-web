#!/usr/bin/env python3
"""Shell checks (WP1, updated for look-shell). Run:  PORT=8141 python3 serve.py  then
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
    'totem': {'Behaviour': {'Combos', 'Macros', 'Tap Dance', 'Mod Morph', 'Leader'},
              'Device': {'Modes', 'Test', 'Keyboard'}},
    'imprint': {'Behaviour': {'Combos', 'Macros', 'Tap Dance', 'Mod Morph', 'Leader'},
                'Device': {'Mouse', 'Gestures', 'RGB', 'Modes', 'Test', 'Keyboard'}},
}


SCREENS = ['Keymap', 'Combos', 'Behaviours', 'Macros', 'Device', 'Test', 'Trainer']
SUBTABS = {  # screen -> sub-tab labels that must exist (look-shell: the second row is the screens)
    'totem': {'Behaviours': {'Tap Dance', 'Mod Morph', 'Leader'}, 'Device': {'Modes', 'Keyboard'}},
    'imprint': {'Behaviours': {'Tap Dance', 'Mod Morph', 'Leader'}, 'Device': {'Mouse', 'Gestures', 'RGB', 'Modes', 'Keyboard'}},
}


def subtabs_in(page, screen):
    page.locator('.maintab', has_text=screen).click()
    page.wait_for_timeout(200)
    return set(page.locator('.subtab').all_inner_texts())


def check_workspace(browser, name, label, failures):
    for size in ((1440, 1000), (1024, 768), (768, 1024)):
        ctx, page, errors = h.new_context(browser, viewport=size)
        h.open_workspace(page, label)
        tag = f'{name}@{size[0]}'
        labels = [t.split('\n')[0] for t in page.locator('.maintab').all_inner_texts()]
        if labels != SCREENS:
            failures.append(f'{tag}: screens {labels} != {SCREENS}')
        if page.locator('.tab-groups').count():
            failures.append(f'{tag}: the old palette tab strip is still there')
        if page.evaluate('document.documentElement.scrollWidth > innerWidth'):
            failures.append(f'{tag}: horizontal page scroll')
        if size[0] == 1440:
            for screen, want in SUBTABS[name].items():
                have = subtabs_in(page, screen)
                if not want <= have:
                    failures.append(f'{tag}: {screen} missing {sorted(want - have)} (have {sorted(have)})')
            page.locator('.maintab', has_text='Keymap').click()
            # The board is one frame element; the Keymap screen keeps it while the dock scrolls.
            before = page.locator('#board-slot').bounding_box()
            page.evaluate("() => { const g = document.querySelector('.dock-grid'); g.scrollTop = g.scrollHeight; }")
            if page.locator('#board-slot').bounding_box() != before:
                failures.append(f'{tag}: board moved while the dock scrolled')
            # Caption follows hover and restores on leave.
            page.mouse.move(700, 10)
            page.wait_for_timeout(150)
            default = page.locator('#caption-bar').inner_text()
            page.locator('#zoom-in').hover()
            hovered = page.locator('#caption-bar').inner_text()
            page.mouse.move(700, 10)
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
    if bg != '#121212':
        failures.append(f'default theme is not Graphite (--bg={bg!r})')
    fs = page.evaluate("() => getComputedStyle(document.documentElement).fontSize")
    if fs != '18.4px':
        failures.append(f'text scale default: font-size {fs} != 18.4px')
    page.locator('#offline-list .dev-item').filter(has_text='TOTEM').first.click()
    page.locator('#panels .panel.active').wait_for()
    page.locator('.maintab', has_text='Device').click()
    page.locator('.subtab[data-tab=keyboard]').click()
    page.locator('.kb-theme[data-theme-id=nord]').click()
    page.locator('.kb-tab input[type=range]').fill('1.3')
    page.locator('.maintab', has_text='Keymap').click()
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
      const { board } = await import('./board.js?v=71');
      board.selectedKey = () => ({ layer: 0, pos: 1 });
    }""")
    if 'Assign to selected key…' not in labels():
        failures.append('palette lacks "Assign to selected key…" with a key selected')
    # Status bar Save segment follows saveState.
    page.evaluate("""async () => {
      const { saveState } = await import('./save-state.js?v=71');
      saveState.markDirty('studio-keymap', 'keymap', async () => {});
    }""")
    txt = page.locator('#save-btn').inner_text()
    if '1 unsaved' not in txt:
        failures.append(f'top bar save text: {txt!r}')
    if page.locator('#save-btn').is_disabled():
        failures.append('Save stays disabled with something unsaved')
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
