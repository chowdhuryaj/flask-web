// ⌘K — type where you want to go.
//
// Grouping the tabs made every destination reachable without scrolling, but it
// still costs you knowing WHICH group a thing is in. This does not: type
// "chords", "layer 3", "unlock" and press Return.
//
// It matters more here than on the desktop, which has a menu bar to fall back
// on. Port of AdeptCompanion's CommandPalette.swift, minus the keycode
// assignment — that one needs a selected key, and on the web the selection
// lives inside the Keymap tab rather than in shared state.

import { el } from './ui.js?v=49';

const MAX_RESULTS = 40;

export class CommandPalette {
    /**
     * @param app    the shared app object
     * @param deps   { tabs, showTab, groupOf, unlock }
     */
    constructor(app, deps) {
        this.app = app;
        this.deps = deps;
        this.open = false;
        this.cursor = 0;
        this.matches = [];
        document.addEventListener('keydown', (e) => this.#onGlobalKey(e));
    }

    #onGlobalKey(e) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
            // The trainer owns plain keystrokes while it has focus, but not
            // this one — it is modified, so it can never be a lesson character.
            e.preventDefault();
            this.toggle();
        } else if (this.open && e.key === 'Escape') {
            e.preventDefault();
            this.close();
        }
    }

    toggle() { this.open ? this.close() : this.show(); }

    close() {
        this.open = false;
        this.root?.remove();
        this.root = null;
        // Give focus back to whatever had it — losing it mid-lesson means the
        // next keystroke goes nowhere.
        this.previousFocus?.focus?.();
    }

    show() {
        if (this.open) return;
        this.open = true;
        this.previousFocus = document.activeElement;
        this.cursor = 0;

        this.input = el('input', {
            class: 'cp-input', type: 'text', placeholder: 'Go to a tab, a layer, an action…',
            oninput: () => { this.cursor = 0; this.#renderList(); },
            onkeydown: (e) => this.#onInputKey(e),
        });
        this.list = el('div', { class: 'cp-list' });
        this.root = el('div', {
            class: 'cp-backdrop',
            onclick: (e) => { if (e.target === this.root) this.close(); },
        }, el('div', { class: 'cp-panel' }, this.input, this.list));

        document.body.append(this.root);
        this.#renderList();
        this.input.focus();
    }

    #onInputKey(e) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.cursor = Math.min(this.matches.length - 1, this.cursor + 1);
            this.#renderList();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.cursor = Math.max(0, this.cursor - 1);
            this.#renderList();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            this.#run(this.matches[this.cursor]);
        }
    }

    #run(command) {
        if (command == null) return;
        this.close();
        command.run();
    }

    #renderList() {
        this.matches = this.#match(this.input.value);
        if (this.matches.length === 0) {
            this.list.replaceChildren(el('div', { class: 'cp-empty' },
                this.input.value ? `Nothing matches “${this.input.value}”.` : 'Type to search.'));
            return;
        }
        this.list.replaceChildren(...this.matches.map((command, i) =>
            el('div', {
                class: `cp-row${i === this.cursor ? ' on' : ''}`,
                onclick: () => this.#run(command),
                onmousemove: () => {
                    if (this.cursor === i) return;
                    this.cursor = i;
                    this.#renderList();
                },
            },
            el('span', { class: 'cp-title', text: command.title }),
            el('span', { class: 'cp-sub', text: command.subtitle }))));
        this.list.children[this.cursor]?.scrollIntoView({ block: 'nearest' });
    }

    /** Prefix hits before contains-hits, so "lay" reaches "Layers" first. */
    #match(query) {
        const q = query.trim().toLowerCase();
        const all = this.#commands();
        if (!q) return all.slice(0, MAX_RESULTS);
        const prefix = [];
        const contains = [];
        for (const command of all) {
            const title = command.title.toLowerCase();
            if (title.startsWith(q)) prefix.push(command);
            else if (title.includes(q) || command.subtitle.toLowerCase().includes(q)) contains.push(command);
        }
        return [...prefix, ...contains].slice(0, MAX_RESULTS);
    }

    #commands() {
        const { app, deps } = this;
        const out = [];
        for (const tab of deps.tabs()) {
            out.push({
                title: tab.label,
                subtitle: deps.groupLabel(tab.id),
                run: () => deps.showTab(tab.id),
            });
        }
        // Layers, when the keymap tab is present and has read one.
        const keymap = deps.tabs().find((t) => t.id === 'keymap')?.instance;
        if (keymap && app.layerCount) {
            for (let i = 0; i < app.layerCount; i++) {
                out.push({
                    title: `Layer ${i}`,
                    subtitle: app.profile?.layerNames?.[i] ?? '',
                    run: () => {
                        deps.showTab('keymap');
                        keymap.layer = i;
                        keymap.selected = null;
                        keymap.showEmptyLayers = true;
                        keymap.renderStrip();
                        keymap.renderBoard();
                    },
                });
            }
        }
        if (app.hid?.connected) {
            out.push({
                title: app.unlocked ? 'Lock the keyboard' : 'Unlock the keyboard',
                subtitle: 'macros, matrix reads, bootloader',
                run: () => deps.unlock(),
            });
            out.push({
                title: 'Pop out the board',
                subtitle: 'float the live keymap over other apps',
                run: () => app.hud?.toggle(),
            });
        }
        return out;
    }
}
