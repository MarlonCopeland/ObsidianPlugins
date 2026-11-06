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
            "Select the + button to add a credential: title, username, password, and optionally a URL, notes, and tags.",
            "Select an entry to view it, reveal the password, edit it, or delete it. Each row also has buttons to copy the username or password and a menu for more actions.",
            "Use the search bar or tag filters at the top to find an entry quickly.",
        ],
    },
    {
        heading: "Locking & unlocking",
        items: [
            "Unlock with your master password, or with a PIN if you've set one up on this device in Settings. After 5 wrong PINs the PIN is turned off.",
            "Use the lock button in the header, or run \"Lock Login Vault\" from the command palette, to lock immediately.",
            "The vault also auto-locks after a period of inactivity (configurable in Settings), and open dialogs close when it locks.",
        ],
    },
    {
        heading: "Copying passwords",
        items: [
            "Copy buttons put the value on your clipboard and, if enabled in Settings, clear it after a delay (only if you haven't copied something else since).",
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
        heading: "Syncing and backups",
        items: [
            "The vault is one encrypted file, login-vault.enc. With Obsidian Sync, turn on \"Sync all other types\" (Settings → Sync → Selective sync) on every device — it is off by default.",
            "Changes made on another device are merged in automatically while the vault is open.",
            "Encrypted backups of the vault file are kept in the plugin's backups folder on this device. If the vault file is ever damaged, the unlock screen offers to restore the latest one.",
        ],
    },
    {
        heading: "If you forget your password",
        items: [
            "There is no recovery — the master password is never stored. \"Forgot password? Reset vault…\" on the unlock screen removes the vault and starts over. An encrypted copy stays in the vault trash and the plugin's backups folder.",
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
        this.titleEl.setText("Login Vault help");

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
