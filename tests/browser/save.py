#!/usr/bin/env python3
"""WP6 browser checks: reloadBar -> saveState wiring, unload
guard, and Save layout / Load on the ZMK line (Imprint offline workspace).

Run:  PORT=8146 python3 serve.py   then   PORT=8146 python3 tests/browser/save.py
No hardware: harness.py stubs navigator.hid / serial.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness as h  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

RELOAD_BAR = """async () => {
  const ui = await import('./ui.js?v=69');
  const { saveState } = await import('./save-state.js?v=69');
  saveState.reset();
  let saves = 0, reloads = 0;
  const bar = ui.reloadBar(0x05, { label: 'DPI', save: async () => { saves++; }, reload: async () => { reloads++; } });
  const row = ui.toggleRow({ label: 't', value: false, onChange: async (v) => v });
  document.body.append(ui.card('probe', null, row, bar));
  window.__probe = { saveState, bar, counts: () => ({ saves, reloads }) };
  return bar.querySelector('.state').textContent;
}"""

OUT = []
def check(cond, msg):
    if not cond:
        OUT.append(msg)


def main():
    with sync_playwright() as p:
        browser = h.launch(p)
        ctx, page, errors = h.new_context(browser)
        h.open_workspace(page, h.WORKSPACES['imprint'][0])

        # reloadBar: a live edit in its card registers the channel with the one Save.
        check(page.evaluate(RELOAD_BAR) == 'Edits apply live — Save to keep them', 'neutral state text')
        page.locator('.card:has-text("probe") .toggle').click()
        page.wait_for_timeout(100)
        check(page.evaluate("window.__probe.saveState.dirty().map(d => d.source)") == [5], 'edit registers channel 5')
        check(page.evaluate("window.__probe.saveState.summary()") == 'Save 1 unsaved', 'summary text')
        check(page.locator('.card:has-text("probe") .state').inner_text() == 'Unsaved — Save is in the top bar', 'live state wording')
        # beforeunload guard is armed while dirty and gone after.
        check(page.evaluate("(() => { const e = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(e); return e.defaultPrevented; })()"), 'unload guard armed')
        # Reload does not clear dirty (the edit is still unsaved on the device).
        page.locator('.card:has-text("probe") button:has-text("Reload from device")').click()
        page.wait_for_timeout(100)
        check(page.evaluate("window.__probe.counts().reloads") == 1, 'reload ran')
        check(page.evaluate("window.__probe.saveState.dirty().length") == 1, 'reload leaves it dirty')
        r = page.evaluate("window.__probe.saveState.saveAll().then(r => [r.saved, r.failed])")
        check(r == [[5], None], f'saveAll result {r}')
        page.wait_for_timeout(100)
        check(page.evaluate("window.__probe.counts().saves") == 1, 'channel save ran once')
        check(page.locator('.card:has-text("probe") .state').inner_text() == 'Saved ✓', 'saved state wording')
        check(not page.evaluate("(() => { const e = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(e); return e.defaultPrevented; })()"), 'unload guard released')

        # ZMK tap dance 0x28 registers like any channel (it has a save step).
        res = page.evaluate("""async () => {
          const { saveState } = await import('./save-state.js?v=69');
          saveState.reset();
          let r = 'no throw'; try { saveState.markDirty(0x28, 'tap dance', async () => {}); } catch (e) { r = e.message; }
          saveState.reset();
          return r;
        }""")
        check(res == 'no throw', f'zmk 0x28 should register: {res}')

        # Save layout / Load (main.js drives these two on the live keymap tab):
        # v2 JSON with family, round trip.
        EXPORT = "import('./zmk-keymap-tab.js?v=69').then(m => m.zmkLiveKeymapTab().exportKeymap())"
        with page.expect_download() as dl:
            page.evaluate(EXPORT)
        path = dl.value.path()
        data = json.loads(Path(path).read_text())
        check([data.get('kind'), data.get('version'), data.get('family')] == ['flask-zmk-keymap', 2, 'imprint'],
              f'export header {[data.get("kind"), data.get("version"), data.get("family")]}')
        check(len(data.get('layers', [])) > 0, 'export has layers')
        page.evaluate("""async (text) => {
          const m = await import('./zmk-keymap-tab.js?v=69');
          await m.zmkLiveKeymapTab().importKeymap(new File([text], 'k.json'));
        }""", json.dumps(data))
        with page.expect_download() as dl2:
            page.evaluate(EXPORT)
        again = json.loads(Path(dl2.value.path()).read_text())
        check(again['layers'] == data['layers'], 'layers survive Save layout -> Load -> Save layout')

        OUT.extend(f'page: {e}' for e in errors)
        browser.close()
    for m in OUT:
        print('FAIL', m)
    print('save.py:', 'FAIL' if OUT else 'PASS')
    return 1 if OUT else 0


if __name__ == '__main__':
    sys.exit(main())
