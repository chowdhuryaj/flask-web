// Vial unlock flow. Gotcha (hardware-verified in the Swift app): once
// unlock_start fires, the device only answers unlock commands until the
// combo completes — there is NO abort; replug recovers. So: pause all other
// traffic (HUD included) for the duration, and if the user closes the modal
// mid-flow, keep polling in the background and say "replug to recover".

import { el, modal, toast } from './ui.js?v=13';
import { keyName } from './profiles.js?v=13';

export async function runUnlockFlow(app, onDone) {
    const { vial, hid, profile } = app;
    let status;
    try { status = await vial.unlockStatus(); }
    catch (e) { toast(`Unlock status failed: ${e.message}`, true); return; }
    if (status.unlocked) { onDone?.(true); return; }

    const keyList = status.keys.map((k) => keyName(profile, k.row, k.col));
    const progress = el('progress', { max: 50, value: 0, style: 'width:100%' });
    const msg = el('p', {}, 'Hold ', el('b', { text: keyList.join(' + ') || 'the unlock keys' }),
        ' on the keyboard until the bar completes.');
    const note = el('p', { class: 'faint', text:
        'While unlocking, the keyboard answers nothing else. There is no cancel — if you stop now, replug the keyboard to recover.' });

    const back = modal('Unlock keyboard', el('div', {}, msg, progress, note));

    hid.pause(); // freeze HUD/tab traffic — device won't answer it anyway
    let done = false;
    try {
        // unlockStart + polls must bypass the paused queue: use a transaction.
        await hid.transaction(async (direct) => {
            const vialCmd = (cmd) => direct.rawCommand([0xFE, cmd]);
            await vialCmd(0x06); // unlockStart
            for (;;) {
                const r = await vialCmd(0x07); // unlockPoll
                const unlocked = r[0] !== 0, inProgress = r[1] !== 0, counter = r[2];
                progress.value = 50 - counter;
                if (unlocked) { done = true; break; }
                if (!inProgress) {
                    // Firmware gave up (keys released) — restart the hold.
                    await vialCmd(0x06);
                }
                await new Promise((res) => setTimeout(res, 200));
                if (!back.isConnected) break; // user closed the modal
                if (!hid.device) break;       // unplugged
            }
        });
    } catch (e) {
        toast(`Unlock failed: ${e.message}`, true);
    } finally {
        hid.resume();
        back.remove();
    }
    if (done) { toast('Unlocked'); onDone?.(true); }
    else if (hid.device) toast('Unlock not completed — replug the keyboard if it stops responding', true);
}

export async function lockKeyboard(app, onDone) {
    try {
        await app.vial.lock();
        toast('Locked');
        onDone?.(false);
    } catch (e) {
        toast(`Lock failed: ${e.message}`, true);
    }
}
