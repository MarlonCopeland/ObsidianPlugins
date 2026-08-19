// ─────────────────────────────────────────────────────────────────────────────
// components.ts — Reusable UI helpers shared across modals
// ─────────────────────────────────────────────────────────────────────────────

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

// Only one clear-countdown should ever be pending at a time: the clipboard can
// only hold one value, so a later copy supersedes an earlier one's countdown.
let pendingClearInterval: ReturnType<typeof setInterval> | null = null;

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

    if (pendingClearInterval !== null) {
        clearInterval(pendingClearInterval);
        pendingClearInterval = null;
    }

    if (clearSecs <= 0) return;

    let remaining = clearSecs;
    onCountdown?.(remaining);

    pendingClearInterval = setInterval(() => {
        remaining--;
        onCountdown?.(remaining);
        if (remaining <= 0) {
            if (pendingClearInterval !== null) clearInterval(pendingClearInterval);
            pendingClearInterval = null;
            navigator.clipboard.writeText("").catch(() => { });
            onClear?.();
        }
    }, 1000);
}

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
    });

    const toggleBtn = wrap.createEl("button", { cls: "lv-pw-toggle-btn", text: "👁" });
    toggleBtn.title = "Show/hide password";
    toggleBtn.onclick = () => {
        const shown = input.type === "text";
        input.type = shown ? "password" : "text";
        toggleBtn.setText(shown ? "👁" : "🙈");
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
        const x = chip.createEl("button", { text: "×", cls: "lv-tag-remove" });
        x.onclick = (e) => { e.stopPropagation(); onRemove(); };
    }
    return chip;
}
