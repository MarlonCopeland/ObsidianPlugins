// ─────────────────────────────────────────────────────────────────────────────
// components.ts — Reusable UI helpers shared across modals
// ─────────────────────────────────────────────────────────────────────────────

import { Modal, setIcon } from "obsidian";
import type { StrengthScore } from "../types";

const STRENGTH_CLASSES = ["lv-s0", "lv-s1", "lv-s2", "lv-s3", "lv-s4"];

/** Renders a 5-segment strength bar inside the given container element */
export function renderStrengthBar(container: HTMLElement, score: StrengthScore): void {
    container.empty();
    for (let i = 0; i < 5; i++) {
        const seg = container.createDiv("lv-strength-seg");
        if (i <= score) {
            seg.addClass(STRENGTH_CLASSES[score]);
        }
    }
}

/**
 * Creates a button that shows an Obsidian (Lucide) icon and has an accessible
 * name. Emoji are avoided: they render differently per OS and have no label.
 */
export function createIconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    cls = "lv-icon-btn"
): HTMLButtonElement {
    const btn = parent.createEl("button", { cls, attr: { "aria-label": label, title: label, type: "button" } });
    setIcon(btn, icon);
    iconFallback(btn, label);
    return btn;
}

/** If an icon name isn't known to this Obsidian version, show a word instead of a blank button. */
function iconFallback(btn: HTMLElement, label: string): void {
    if (!btn.querySelector("svg")) btn.setText(label.split(" ")[0]);
}

/** Swaps the icon shown inside a button created with createIconButton. */
export function setButtonIcon(btn: HTMLElement, icon: string): void {
    btn.empty();
    setIcon(btn, icon);
    iconFallback(btn, btn.getAttribute("aria-label") ?? "");
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

// Only one clear-countdown should ever be pending at a time: the clipboard can
// only hold one value, so a later copy supersedes an earlier one's countdown.
let pendingClear: { interval: ReturnType<typeof setInterval>; text: string } | null = null;

/**
 * Clears the clipboard, but only if it still holds `text` — a clear must not
 * wipe something the user copied since. If the clipboard can't be read
 * (permission, mobile), clear anyway.
 */
async function clearClipboardIfUnchanged(text: string): Promise<void> {
    try {
        const current = await navigator.clipboard.readText();
        if (current !== text) return;
    } catch {
        // can't inspect it: fall through and clear
    }
    await navigator.clipboard.writeText("").catch(() => { });
}

/** Copies text to clipboard and optionally clears it after a delay */
export function copyWithTimeout(
    text: string,
    clearSecs: number,
    onCountdown?: (remaining: number) => void,
    onClear?: () => void
): void {
    navigator.clipboard.writeText(text).catch(() => {
        // Fallback for environments where clipboard API isn't available
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
    });

    if (pendingClear !== null) {
        clearInterval(pendingClear.interval);
        pendingClear = null;
    }

    if (clearSecs <= 0) return;

    let remaining = clearSecs;
    onCountdown?.(remaining);

    const interval = setInterval(() => {
        remaining--;
        onCountdown?.(remaining);
        if (remaining <= 0) {
            clearInterval(interval);
            if (pendingClear?.interval === interval) pendingClear = null;
            void clearClipboardIfUnchanged(text);
            onClear?.();
        }
    }, 1000);
    pendingClear = { interval, text };
}

/** Clears a copied secret immediately (called when the vault locks). */
export function flushPendingClipboardClear(): void {
    if (pendingClear === null) return;
    clearInterval(pendingClear.interval);
    const { text } = pendingClear;
    pendingClear = null;
    void clearClipboardIfUnchanged(text);
}

// ── Forms ─────────────────────────────────────────────────────────────────────

/** Attributes that stop mobile keyboards from learning / suggesting secrets. */
export const SECRET_INPUT_ATTRS = {
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
};

/** Creates a masked text field with a show/hide toggle button */
export function createPasswordField(
    container: HTMLElement,
    value: string,
    placeholder = "Password"
): { input: HTMLInputElement; toggleBtn: HTMLButtonElement } {
    const wrap = container.createDiv("lv-pw-field-wrap");

    const input = wrap.createEl("input", {
        type: "password",
        placeholder,
        value,
        cls: "lv-password-input lv-pw-field-input",
        attr: SECRET_INPUT_ATTRS,
    });

    const toggleBtn = createIconButton(wrap, "eye", "Show password", "lv-pw-toggle-btn");
    toggleBtn.onclick = () => {
        const shown = input.type === "text";
        input.type = shown ? "password" : "text";
        setButtonIcon(toggleBtn, shown ? "eye" : "eye-off");
        toggleBtn.setAttribute("aria-label", shown ? "Show password" : "Hide password");
    };

    return { input, toggleBtn };
}

/** Triggers a browser download of `content` as a file named `filename` */
export function downloadText(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/** Creates a tag chip for the tag list */
export function createTagChip(
    container: HTMLElement,
    tag: string,
    onRemove?: () => void
): HTMLElement {
    const chip = container.createDiv("lv-tag-chip");
    chip.createSpan({ text: tag });
    if (onRemove) {
        const x = chip.createEl("button", {
            text: "×",
            cls: "lv-tag-remove",
            attr: { "aria-label": `Remove tag ${tag}`, type: "button" },
        });
        x.onclick = (e) => { e.stopPropagation(); onRemove(); };
    }
    return chip;
}

// ── Lock-aware modals ─────────────────────────────────────────────────────────

/**
 * Base class for any modal that shows or edits secrets. When the vault locks
 * (manually, by timer, or because it was invalidated) every open SecretModal
 * is closed so no plaintext stays on screen after the lock.
 */
export class SecretModal extends Modal {
    private static openModals = new Set<SecretModal>();

    open(): void {
        SecretModal.openModals.add(this);
        super.open();
    }

    close(): void {
        SecretModal.openModals.delete(this);
        super.close();
    }

    static closeAll(): void {
        for (const modal of [...SecretModal.openModals]) modal.close();
    }
}
