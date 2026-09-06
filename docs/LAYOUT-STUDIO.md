# Layout Studio appearance

Select **Layout Studio** in the existing Theme menu. It applies the selected concept's warm paper surfaces, charcoal header, cobalt selection, subtle panel shadows and key depth to the current configurator. Existing theme preferences and Classic's default auto light/dark behavior are preserved. Switching back clears all optional finish tokens.

This is a visual integration, not the prototype editor: group/tab ordering, capability gates, Vial-defined keyboard geometry, picker/composer, zoom, live edits and save vocabulary, offline journals, .vil workflows, diagnostics, HUD and QMK/ZMK/Nape boundaries retain their existing implementation. No device protocols or transport modules changed.

The CSS remains one stylesheet so the HUD's existing stylesheet/root-style clone carries the theme. Runtime changes are confined to main.js's theme registry/token clearing, styles.css and index.html cache stamps. No deployment has occurred.

## Validation

Run the app with `PORT=8140 python3 serve.py`, then `node tests/layout-studio-theme-test.mjs`. Override FLASK_TEST_URL, PLAYWRIGHT_MODULE and CHROME_PATH as needed. Set FLASK_THEME_CAPTURE=0 to skip captures. The test compares all eight prior palettes to main/style sources at d0b34f4, including select hover; checks unchanged SVG geometry/navigation, offline key edits and .vil export, layer switching, theme reset/persistence, zoom persistence, small-label contrast, and desktop/tablet/mobile document overflow. It never calls device connection APIs; test contexts stub HID/Serial discovery/request methods.

The fixture uses a unique non-device workspace key in a fresh browser context. Its matrix geometry comes from the Svalboard Vial definition observed at firmware source 84570f52; its alphabetic assignments are synthetic. It is not a captured user layout and is not added to the app's offline templates. It cannot match the normal Svalboard reconnect journal key.

The preserved baseline/captures describe a v23 web fixture; protocol parity with firmware v27 is still a separate task. In particular, the original app places Mouse Chords in Behaviour; tests take that list directly from the original runtime rather than relying on an early inventory assumption.

The independent [source review](reviews/layout-studio-appearance-review.md) found only the new faint coordinate-label contrast issue. That token is now #596473, with explicit regression assertions for normal, selected and pressed fills. Other theme palettes are unchanged. Earlier captures predate this small label-only correction; the final nonvisual tests cover the corrected source.

Final result: **74 appearance/preservation assertions passed** at 1440×1000, 900×1000 and 390×844; the existing `zmk-studio-test.mjs` suite passed **340 checks**. The mechanical detector was limited to regex matching because its optional parsers were unavailable; its sole finding is the unchanged macro progress-bar width transition. No unrelated animation was altered.

Program state is maintained in the sibling firmware [STATUS dashboard](../../svalboard-vial-qmk/docs/STATUS.md). This page documents only this visual change and its verification.
