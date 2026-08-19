// ─────────────────────────────────────────────────────────────────────────────
// password-gen.ts — Password generation and strength checking
// ─────────────────────────────────────────────────────────────────────────────

import type { PasswordGenOptions, StrengthResult, StrengthScore } from "./types";
import zxcvbn from "zxcvbn";

// Character sets
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const NUMS = "0123456789";
const SYMS = "!@#$%^&*()-_=+[]{}|;:,.<>?";

const AMBIGUOUS = /[0Ol1I]/g;

/**
 * Generates a cryptographically random password based on the given options.
 * Uses window.crypto.getRandomValues for unbiased character selection.
 */
export function generatePassword(options: PasswordGenOptions): string {
    let charset = "";
    if (options.uppercase) charset += UPPER;
    if (options.lowercase) charset += LOWER;
    if (options.numbers) charset += NUMS;
    if (options.symbols) charset += SYMS;

    if (options.excludeAmbiguous) {
        charset = charset.replace(AMBIGUOUS, "");
    }

    if (charset.length === 0) {
        charset = LOWER; // fallback
    }

    const length = Math.max(8, Math.min(128, options.length));
    let password = "";

    // Guarantee at least one char from each selected class
    const required: string[] = [];
    if (options.uppercase) {
        const src = options.excludeAmbiguous ? UPPER.replace(AMBIGUOUS, "") : UPPER;
        if (src.length > 0) required.push(randomChar(src));
    }
    if (options.lowercase) {
        const src = options.excludeAmbiguous ? LOWER.replace(AMBIGUOUS, "") : LOWER;
        if (src.length > 0) required.push(randomChar(src));
    }
    if (options.numbers) {
        const src = options.excludeAmbiguous ? NUMS.replace(AMBIGUOUS, "") : NUMS;
        if (src.length > 0) required.push(randomChar(src));
    }
    if (options.symbols) required.push(randomChar(SYMS));

    // Fill remaining length
    const remaining = length - required.length;
    for (let i = 0; i < Math.max(0, remaining); i++) {
        password += randomChar(charset);
    }

    // Combine and shuffle
    const combined = (required.join("") + password).split("");
    shuffleArray(combined);
    return combined.join("");
}

function randomChar(str: string): string {
    const arr = new Uint32Array(1);
    let index: number;
    // Rejection sampling for unbiased selection
    do {
        window.crypto.getRandomValues(arr);
        index = arr[0] % str.length;
    } while (arr[0] >= Math.floor(0xffffffff / str.length) * str.length);
    return str[index];
}

function shuffleArray(arr: string[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
        const rng = new Uint32Array(1);
        window.crypto.getRandomValues(rng);
        const j = rng[0] % (i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

// ── Strength checking (zxcvbn) ────────────────────────────────────────────────

const SCORE_LABELS: Record<StrengthScore, string> = {
    0: "Very Weak",
    1: "Weak",
    2: "Fair",
    3: "Strong",
    4: "Very Strong",
};

/**
 * Checks password strength using zxcvbn.
 * Returns a numeric score 0–4 plus a human-readable label and feedback string.
 */
export function checkStrength(password: string): StrengthResult {
    if (!password) {
        return { score: 0, label: "Very Weak", feedback: "" };
    }

    const result = zxcvbn(password);
    const score = result.score as StrengthScore;
    const suggestions = result.feedback?.suggestions ?? [];
    const warning = result.feedback?.warning ?? "";

    const feedbackParts = [warning, ...suggestions].filter(Boolean);
    const feedback = feedbackParts.slice(0, 2).join(" ");

    return {
        score,
        label: SCORE_LABELS[score],
        feedback,
    };
}
