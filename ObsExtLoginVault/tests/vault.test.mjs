// Run with: npm test
// Bundles the real source with esbuild (stubbing the `obsidian` module with an
// in-memory vault) and exercises the sync-critical paths: merge, large
// payloads, concurrent edits from two "devices", password change elsewhere,
// legacy file migration, and PIN attempt limiting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "lv-test-"));

// Browser globals the plugin expects.
globalThis.window = globalThis;

const obsidianStub = join(dir, "obsidian-stub.js");
writeFileSync(
    obsidianStub,
    `export const normalizePath = (p) => p;
export class TFile { constructor(path) { this.path = path; } }
export class App {}
export class Modal {}
export const setIcon = () => {};
`
);

const entry = join(dir, "entry.ts");
writeFileSync(
    entry,
    `export * from ${JSON.stringify(join(here, "../src/merge.ts").replace(/\\/g, "/"))};
export * from ${JSON.stringify(join(here, "../src/crypto.ts").replace(/\\/g, "/"))};
export * from ${JSON.stringify(join(here, "../src/store.ts").replace(/\\/g, "/"))};
export * from ${JSON.stringify(join(here, "../src/auth.ts").replace(/\\/g, "/"))};
export { TFile } from "obsidian";
`
);
const out = join(dir, "bundle.mjs");
await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "esm",
    platform: "node",
    alias: { obsidian: obsidianStub },
    logLevel: "silent",
});
const lib = await import(pathToFileURL(out).href);
const { merge, snapshot, deriveKey, generateSalt, encryptData, decryptData, CredentialStore, AuthManager, TFile } = lib;

// ── In-memory stand-in for the Obsidian vault (shared by "devices") ──────────

function makeVault() {
    const files = new Map(); // path -> { file, content }
    const raw = new Map(); // adapter files
    const dirs = new Set();
    return {
        files,
        vault: {
            getAbstractFileByPath: (p) => files.get(p)?.file ?? null,
            read: async (f) => files.get(f.path).content,
            modify: async (f, c) => { files.get(f.path).content = c; },
            create: async (p, c) => { const file = new TFile(p); files.set(p, { file, content: c }); return file; },
            getName: () => "test",
            adapter: {
                exists: async (p) => dirs.has(p) || raw.has(p),
                mkdir: async (p) => { dirs.add(p); },
                write: async (p, c) => { raw.set(p, c); },
                read: async (p) => raw.get(p),
                remove: async (p) => { raw.delete(p); },
                list: async (p) => ({ files: [...raw.keys()].filter((k) => k.startsWith(p + "/")), folders: [] }),
            },
        },
    };
}

const entryOf = (id, title, updatedAt = 1) => ({ id, title, username: "u", password: "p", createdAt: 1, updatedAt });

class MemDevice {
    constructor() { this.m = new Map(); }
    get(k) { return this.m.has(k) ? JSON.parse(this.m.get(k)) : null; }
    set(k, v) { if (v === null) this.m.delete(k); else this.m.set(k, JSON.stringify(v)); }
}

async function newDevice(shared) {
    const store = new CredentialStore({ vault: shared.vault }, "backups");
    const host = { settings: { autoLockMinutes: 0, clipboardClearSeconds: 30 }, app: { vault: shared.vault }, saveData: async () => {} };
    const auth = new AuthManager(host, store, new MemDevice());
    return { store, auth, host };
}

// ── merge ───────────────────────────────────────────────────────────────────

test("merge: entries added on both sides are both kept", () => {
    const base = snapshot([entryOf("a", "A")]);
    const local = [entryOf("a", "A"), entryOf("x", "X")];
    const remote = [entryOf("a", "A"), entryOf("y", "Y")];
    assert.deepEqual(merge(base, local, remote).map((e) => e.id).sort(), ["a", "x", "y"]);
});

test("merge: deletion elsewhere wins over an untouched local copy", () => {
    const base = snapshot([entryOf("a", "A"), entryOf("b", "B")]);
    const local = [entryOf("a", "A"), entryOf("b", "B")];
    const remote = [entryOf("a", "A")];
    assert.deepEqual(merge(base, local, remote).map((e) => e.id), ["a"]);
});

test("merge: local deletion is not resurrected by a stale remote copy", () => {
    const base = snapshot([entryOf("a", "A"), entryOf("b", "B")]);
    const local = [entryOf("a", "A")];
    const remote = [entryOf("a", "A"), entryOf("b", "B")];
    assert.deepEqual(merge(base, local, remote).map((e) => e.id), ["a"]);
});

test("merge: an edit beats a deletion made elsewhere", () => {
    const base = snapshot([entryOf("a", "A", 1)]);
    const local = [entryOf("a", "A edited", 5)];
    assert.deepEqual(merge(base, local, []).map((e) => e.title), ["A edited"]);
});

test("merge: the newer edit wins when both sides changed the same entry", () => {
    const base = snapshot([entryOf("a", "A", 1)]);
    const out = merge(base, [entryOf("a", "local", 3)], [entryOf("a", "remote", 4)]);
    assert.equal(out[0].title, "remote");
});

// ── crypto ──────────────────────────────────────────────────────────────────

test("crypto: large payloads round-trip (the old base64 helper overflowed the call stack)", async () => {
    const key = await deriveKey("pw", generateSalt());
    const big = "x".repeat(2_000_000);
    const { iv, ciphertext } = await encryptData(key, big);
    assert.equal((await decryptData(key, iv, ciphertext)).length, big.length);
});

test("crypto: a wrong key fails authentication", async () => {
    const salt = generateSalt();
    const good = await deriveKey("right", salt);
    const bad = await deriveKey("wrong", salt);
    const { iv, ciphertext } = await encryptData(good, "secret");
    await assert.rejects(decryptData(bad, iv, ciphertext));
});

// ── two devices sharing one vault file ──────────────────────────────────────

async function setupVault(password = "correct horse battery staple") {
    const shared = makeVault();
    const a = await newDevice(shared);
    await a.auth.setupMasterPassword(password);
    const b = await newDevice(shared);
    assert.equal(await b.auth.unlock(password), true);
    return { shared, a, b, password };
}

test("sync: a stale device does not erase entries added on another device", async () => {
    const { shared, a, b } = await setupVault();
    await a.store.addCredential({ title: "X", username: "u", password: "p" }, a.auth.getSessionKey());
    // B never reloaded, yet saves its own change:
    await b.store.addCredential({ title: "Y", username: "u", password: "p" }, b.auth.getSessionKey());

    const c = await newDevice(shared);
    assert.equal(await c.auth.unlock("correct horse battery staple"), true);
    assert.deepEqual(c.store.getAllCredentials().map((e) => e.title).sort(), ["X", "Y"]);
});

test("sync: syncFromDisk pulls in another device's changes", async () => {
    const { a, b } = await setupVault();
    await a.store.addCredential({ title: "X", username: "u", password: "p" }, a.auth.getSessionKey());
    assert.equal(await b.store.hasExternalChange(), true);
    assert.equal(await b.store.syncFromDisk(b.auth.getSessionKey()), true);
    assert.deepEqual(b.store.getAllCredentials().map((e) => e.title), ["X"]);
});

test("sync: own writes are not reported as external changes", async () => {
    const { a } = await setupVault();
    await a.store.addCredential({ title: "X", username: "u", password: "p" }, a.auth.getSessionKey());
    assert.equal(await a.store.hasExternalChange(), false);
});

test("sync: after a password change elsewhere, a stale device refuses to write and locks", async () => {
    const { shared, a, b, password } = await setupVault();
    let invalidated = null;
    b.store.onInvalidated = (r) => { invalidated = r; };

    assert.equal(await a.auth.changeMasterPassword(password, "a brand new passphrase 123"), true);

    await assert.rejects(
        b.store.addCredential({ title: "Y", username: "u", password: "p" }, b.auth.getSessionKey()),
        { name: "VaultKeyChangedError" }
    );
    assert.equal(invalidated, "key-changed");

    // The vault is still intact and opens with the new password only.
    const c = await newDevice(shared);
    assert.equal(await c.auth.unlock(password), false);
    assert.equal(await c.auth.unlock("a brand new passphrase 123"), true);
});

test("sync: the first-run wizard cannot overwrite a vault that already exists", async () => {
    const { shared } = await setupVault();
    const fresh = await newDevice(shared);
    await assert.rejects(fresh.auth.setupMasterPassword("another long passphrase 1"), /already exists/);
});

test("sync: a vault file removed by sync is re-created from memory on the next change", async () => {
    const { shared, a } = await setupVault();
    await a.store.addCredential({ title: "X", username: "u", password: "p" }, a.auth.getSessionKey());
    shared.files.delete("login-vault.enc");
    let recreated = false;
    a.store.onFileRecreated = () => { recreated = true; };
    await a.store.addCredential({ title: "Y", username: "u", password: "p" }, a.auth.getSessionKey());
    assert.equal(recreated, true);
    assert.deepEqual(a.store.getAllCredentials().map((e) => e.title).sort(), ["X", "Y"]);
});

test("store: concurrent saves are serialized and none is lost", async () => {
    const { a } = await setupVault();
    const key = a.auth.getSessionKey();
    await Promise.all(
        ["1", "2", "3", "4", "5"].map((t) => a.store.addCredential({ title: t, username: "u", password: "p" }, key))
    );
    assert.equal(a.store.getAllCredentials().length, 5);
});

// ── legacy files, corruption, backups ───────────────────────────────────────

test("migration: a v1.1 file with a verification hash unlocks and the hash is dropped", async () => {
    const shared = makeVault();
    const salt = generateSalt();
    const key = await deriveKey("legacy password 1", salt);
    const { iv, ciphertext } = await encryptData(key, JSON.stringify([entryOf("a", "Old")]));
    await shared.vault.create("login-vault.enc", JSON.stringify({ version: 1, salt, verificationHash: "AAAA", iv, ciphertext }));

    const d = await newDevice(shared);
    assert.equal(await d.auth.unlock("legacy password 1"), true);
    await d.store.save(d.auth.getSessionKey()); // flush any pending rewrite
    const onDisk = JSON.parse(shared.files.get("login-vault.enc").content);
    assert.equal("verificationHash" in onDisk, false);
    assert.deepEqual(d.store.getAllCredentials().map((e) => e.title), ["Old"]);
});

test("unlock: a corrupt file is reported as corrupt, not as a wrong password", async () => {
    const { shared, password } = await setupVault();
    shared.files.get("login-vault.enc").content = "{ not json";
    const d = await newDevice(shared);
    assert.equal(await d.auth.unlock(password), false);
    assert.equal(d.auth.lastFailure, "corrupt");
});

test("backups: the latest backup restores a damaged vault", async () => {
    const { shared, a, password } = await setupVault();
    await a.store.addCredential({ title: "X", username: "u", password: "p" }, a.auth.getSessionKey());
    await a.store.backupNow();
    shared.files.get("login-vault.enc").content = "garbage";
    assert.equal(await a.store.restoreLatestBackup(), true);
    const d = await newDevice(shared);
    assert.equal(await d.auth.unlock(password), true);
    assert.deepEqual(d.store.getAllCredentials().map((e) => e.title), ["X"]);
});

// ── PIN ─────────────────────────────────────────────────────────────────────

test("pin: unlocks from a cold start, rejects short PINs, and erases itself after 5 wrong tries", async () => {
    const { shared, a, password } = await setupVault();
    await assert.rejects(a.auth.setupPIN("1234"));
    await a.auth.setupPIN("482916");

    // Same device slot, fresh process: reuse a's device store.
    const store = new CredentialStore({ vault: shared.vault }, "backups");
    const cold = new AuthManager(a.host, store, a.auth.device);
    assert.equal(await cold.unlockWithPIN("111111"), false);
    assert.equal(cold.lastFailure, "wrong-pin");
    assert.equal(await cold.unlockWithPIN("482916"), true);
    cold.lock();

    for (let i = 0; i < 5; i++) await cold.unlockWithPIN("000000");
    assert.equal(cold.hasPIN(), false);
    assert.equal(await cold.unlockWithPIN("482916"), false);
    assert.equal(cold.lastFailure, "pin-disabled");

    // The master password still works.
    assert.equal(await cold.unlock(password), true);
});

test("pin: a master-password change invalidates the device PIN", async () => {
    const { a, password } = await setupVault();
    await a.auth.setupPIN("482916");
    assert.equal(await a.auth.changeMasterPassword(password, "a brand new passphrase 123"), true);
    assert.equal(a.auth.hasPIN(), false);
});

test("auto-lock: the deadline is checked against the clock, not just a timer", async () => {
    const { a } = await setupVault();
    a.host.settings.autoLockMinutes = 1;
    a.auth.resetAutoLock(1);
    assert.equal(a.auth.isLocked(), false);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000; // the app was suspended past the deadline
    try {
        assert.equal(a.auth.isLocked(), true);
    } finally {
        Date.now = realNow;
    }
});
