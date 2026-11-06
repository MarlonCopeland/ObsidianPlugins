// ─────────────────────────────────────────────────────────────────────────────
// CredentialModal.ts — Add / Edit credential form
// ─────────────────────────────────────────────────────────────────────────────

import { App, Notice } from "obsidian";
import type { CredentialEntry, PluginSettings } from "../types";
import type { CredentialStore } from "../store";
import { checkStrength, generatePassword } from "../password-gen";
import { createPasswordField, createTagChip, renderStrengthBar, SecretModal } from "./components";
import { PasswordGenModal } from "./PasswordGenModal";

type SaveCallback = (entry: CredentialEntry) => void;

export class CredentialModal extends SecretModal {
    private store: CredentialStore;
    private settings: PluginSettings;
    private existingEntry?: CredentialEntry;
    private onSave: SaveCallback;
    private sessionKey: CryptoKey;
    private tags: string[] = [];

    constructor(
        app: App,
        store: CredentialStore,
        sessionKey: CryptoKey,
        settings: PluginSettings,
        onSave: SaveCallback,
        existingEntry?: CredentialEntry
    ) {
        super(app);
        this.store = store;
        this.sessionKey = sessionKey;
        this.settings = settings;
        this.onSave = onSave;
        this.existingEntry = existingEntry;
        this.tags = [...(existingEntry?.tags ?? [])];
        this.modalEl.addClass("lv-credential-modal");
    }

    onOpen(): void {
        const { contentEl } = this;
        const isEdit = !!this.existingEntry;
        this.titleEl.setText(isEdit ? "Edit credential" : "Add credential");

        const form = contentEl.createDiv("lv-form");

        // Title
        const titleInput = this.field(form, "Title *", "text", "GitHub");
        titleInput.value = this.existingEntry?.title ?? "";

        // Username
        const userInput = this.field(form, "Username *", "text", "email or username");
        userInput.value = this.existingEntry?.username ?? "";

        // Password
        form.createEl("label", { text: "Password *", cls: "lv-field-label" });
        const pwWrap = form.createDiv("lv-pw-field-outer");
        const { input: pwInput } = createPasswordField(pwWrap, this.existingEntry?.password ?? "");

        // Strength meter
        const strengthWrap = form.createDiv("lv-strength-container");
        const strengthBar = strengthWrap.createDiv("lv-strength-bar-wrap");
        const strengthLabel = strengthWrap.createEl("span", { cls: "lv-strength-label" });

        pwInput.addEventListener("input", () => {
            const r = checkStrength(pwInput.value);
            renderStrengthBar(strengthBar, r.score);
            strengthLabel.setText(pwInput.value ? `${r.label}${r.feedback ? " — " + r.feedback : ""}` : "");
        });

        if (this.existingEntry?.password) {
            const r = checkStrength(this.existingEntry.password);
            renderStrengthBar(strengthBar, r.score);
            strengthLabel.setText(r.label);
        }

        // Generate button
        const genBtn = form.createEl("button", { text: "Generate password", cls: "lv-btn-secondary" });
        genBtn.onclick = () => {
            new PasswordGenModal(this.app, this.settings.passwordGenDefaults, (pw) => {
                pwInput.value = pw;
                const r = checkStrength(pw);
                renderStrengthBar(strengthBar, r.score);
                strengthLabel.setText(r.label);
            }, this.settings.clipboardClearSeconds).open();
        };

        // URL
        const urlInput = this.field(form, "URL", "url", "https://example.com");
        urlInput.value = this.existingEntry?.url ?? "";

        // Notes
        form.createEl("label", { text: "Notes", cls: "lv-field-label" });
        const notesInput = form.createEl("textarea", { cls: "lv-notes-input", placeholder: "Optional notes…" });
        notesInput.value = this.existingEntry?.notes ?? "";

        // Tags
        form.createEl("label", { text: "Tags", cls: "lv-field-label" });
        const tagContainer = form.createDiv("lv-tag-container");
        const tagChipArea = tagContainer.createDiv("lv-tag-chips");
        const tagInput = tagContainer.createEl("input", {
            type: "text",
            placeholder: "Add tag, press Enter",
            cls: "lv-tag-input",
        });
        this.renderTagChips(tagChipArea, tagInput);

        tagInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                const tag = tagInput.value.trim().replace(/,/g, "");
                if (tag && !this.tags.includes(tag)) {
                    this.tags.push(tag);
                    this.renderTagChips(tagChipArea, tagInput);
                }
                tagInput.value = "";
            }
        });

        // Buttons
        const btnRow = form.createDiv("lv-btn-row");
        const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "lv-btn-ghost" });
        const saveBtn = btnRow.createEl("button", { text: isEdit ? "Save Changes" : "Add Credential", cls: "lv-btn-primary" });

        cancelBtn.onclick = () => this.close();
        saveBtn.onclick = async () => {
            if (!titleInput.value.trim()) { new Notice("Title is required"); return; }
            if (!userInput.value.trim()) { new Notice("Username is required"); return; }
            if (!pwInput.value) { new Notice("Password is required"); return; }

            saveBtn.disabled = true;
            saveBtn.setText("Saving…");

            try {
                let saved: CredentialEntry | null;
                if (this.existingEntry) {
                    saved = await this.store.updateCredential(
                        this.existingEntry.id,
                        {
                            title: titleInput.value.trim(),
                            username: userInput.value.trim(),
                            password: pwInput.value,
                            url: urlInput.value.trim() || undefined,
                            notes: notesInput.value.trim() || undefined,
                            tags: this.tags,
                        },
                        this.sessionKey
                    );
                    if (!saved) {
                        new Notice("This entry was deleted on another device, so it couldn't be saved.");
                        this.close();
                        return;
                    }
                } else {
                    saved = await this.store.addCredential(
                        {
                            title: titleInput.value.trim(),
                            username: userInput.value.trim(),
                            password: pwInput.value,
                            url: urlInput.value.trim() || undefined,
                            notes: notesInput.value.trim() || undefined,
                            tags: this.tags,
                        },
                        this.sessionKey
                    );
                }
                this.onSave(saved);
                this.close();
            } catch (e) {
                new Notice("Save failed: " + (e as Error).message);
                saveBtn.disabled = false;
                saveBtn.setText(isEdit ? "Save Changes" : "Add Credential");
            }
        };
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private field(container: HTMLElement, label: string, type: string, placeholder: string): HTMLInputElement {
        container.createEl("label", { text: label, cls: "lv-field-label" });
        return container.createEl("input", {
            type,
            placeholder,
            cls: "lv-text-input",
            attr: { autocomplete: "off", autocapitalize: "off", spellcheck: "false" },
        });
    }

    private renderTagChips(area: HTMLElement, input: HTMLInputElement): void {
        area.empty();
        for (const tag of this.tags) {
            createTagChip(area, tag, () => {
                this.tags = this.tags.filter((t) => t !== tag);
                this.renderTagChips(area, input);
            });
        }
    }
}
