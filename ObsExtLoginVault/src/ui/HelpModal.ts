// ─────────────────────────────────────────────────────────────────────────────
// HelpModal.ts — Quick-reference instructions, opened from the "?" button
// ─────────────────────────────────────────────────────────────────────────────

import { App, Modal } from "obsidian";

interface HelpSection {
    heading: string;
    items: string[];
}

const SECTIONS: HelpSection[] = [
    {
        heading: "Getting started",
        items: [
            "Click the + button to add a credential: title, username, password, and optionally a URL, notes, and tags.",
            "Click any entry to view it, reveal or copy the password, edit it, or delete it.",
            "Use the search bar or tag filters at the top to find an entry quickly.",
        ],
    },
    {
        heading: "Locking & unlocking",
        items: [
            "Unlock with your master password, or with a PIN if you've set one up in Settings.",
            "Click the 🔒 button in the header, or run \"Lock Login Vault\" from the command palette, to lock immediately.",
            "The vault also auto-locks after a period of inactivity — configurable in Settings.",
        ],
    },
    {
        heading: "Copying passwords",
        items: [
            "The 📋 Copy button copies to your clipboard and, if enabled in Settings, clears it automatically after a delay.",
        ],
    },
    {
        heading: "Export & import",
        items: [
            "Export all credentials to CSV directly from this view, or as JSON/CSV from Settings → Export & Import.",
            "CSV and plaintext JSON exports are unencrypted — store the file somewhere secure and delete it when you're done.",
            "Import merges a previous JSON export back in, keeping the newer copy of any entry that exists in both.",
        ],
    },
    {
        heading: "If you forget your password",
        items: [
            "There is no recovery — the master password is never stored. \"Forgot password? Reset vault…\" on the unlock screen deletes all stored credentials and starts over.",
        ],
    },
];

export class HelpModal extends Modal {
    constructor(app: App) {
        super(app);
        this.modalEl.addClass("lv-help-modal");
    }

    onOpen(): void {
        const { contentEl } = this;
        this.titleEl.setText("🔐 Login Vault — Help");

        for (const section of SECTIONS) {
            contentEl.createEl("h4", { text: section.heading, cls: "lv-help-heading" });
            const list = contentEl.createEl("ul", { cls: "lv-help-list" });
            for (const item of section.items) {
                list.createEl("li", { text: item });
            }
        }

        const closeBtn = contentEl.createEl("button", { text: "Close", cls: "lv-btn-primary lv-help-close" });
        closeBtn.onclick = () => this.close();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
