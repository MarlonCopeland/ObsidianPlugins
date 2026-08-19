// ─────────────────────────────────────────────────────────────────────────────
// crypto.ts — All cryptographic operations via the Web Crypto API
//
// Algorithm:  AES-256-GCM  (authenticated encryption)
// Key Derive: PBKDF2-SHA256, 310,000 iterations, 16-byte random salt
// IV:         12-byte random per encryption
// Verification: SHA-256(password + salt) stored alongside ciphertext
// ─────────────────────────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 310_000;
const KEY_LENGTH_BITS = 256;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toBase64(buf: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
}

/** Generate cryptographically random bytes, returned as base64 */
export function generateSalt(): string {
    const buf = new Uint8Array(16);
    window.crypto.getRandomValues(buf);
    return toBase64(buf.buffer);
}

export function generateIV(): string {
    const buf = new Uint8Array(12);
    window.crypto.getRandomValues(buf);
    return toBase64(buf.buffer);
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derives an AES-256-GCM CryptoKey from a password and base64-encoded salt.
 *
 * Extractable: quick-unlock (PIN) needs to wrap/unwrap the raw key bytes with
 * a separately-derived key (see wrapKeyRaw/unwrapKeyRaw below), which requires
 * an extractable CryptoKey. The raw bytes are only ever exported transiently
 * in memory to produce that wrapped blob — they are never persisted directly.
 */
export async function deriveKey(password: string, saltB64: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const salt = fromBase64(saltB64);

    const baseKey = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(password),
        "PBKDF2",
        false,
        ["deriveKey"]
    );

    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt as unknown as ArrayBuffer,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256",
        },
        baseKey,
        { name: "AES-GCM", length: KEY_LENGTH_BITS },
        true,        // extractable — required to wrap for PIN quick-unlock
        ["encrypt", "decrypt"]
    );
}

// ── Key wrapping (for PIN quick-unlock) ─────────────────────────────────────

/**
 * Exports `key`'s raw bytes and encrypts them with `wrapperKey`.
 * Used to let a PIN-derived key "wrap" the real vault key, so the PIN can
 * recover the real key from cold start without ever storing it unencrypted.
 */
export async function wrapKeyRaw(key: CryptoKey, wrapperKey: CryptoKey): Promise<EncryptedPayload> {
    const raw = await window.crypto.subtle.exportKey("raw", key);
    return encryptData(wrapperKey, toBase64(raw));
}

/** Reverses wrapKeyRaw: decrypts the wrapped blob and imports it as a non-extractable AES-GCM key. */
export async function unwrapKeyRaw(payload: EncryptedPayload, wrapperKey: CryptoKey): Promise<CryptoKey> {
    const rawB64 = await decryptData(wrapperKey, payload.iv, payload.ciphertext);
    const raw = fromBase64(rawB64);
    return window.crypto.subtle.importKey(
        "raw",
        raw as unknown as ArrayBuffer,
        "AES-GCM",
        false,       // not extractable
        ["encrypt", "decrypt"]
    );
}

// ── Verification hash ─────────────────────────────────────────────────────────

/**
 * Returns SHA-256(utf8(password) ++ salt_bytes) as base64.
 * Used to verify the master password on unlock without storing the password itself.
 */
export async function hashForVerification(password: string, saltB64: string): Promise<string> {
    const enc = new TextEncoder();
    const salt = fromBase64(saltB64);
    const combined = new Uint8Array(enc.encode(password).length + salt.length);
    combined.set(enc.encode(password), 0);
    combined.set(salt, enc.encode(password).length);

    const hash = await window.crypto.subtle.digest("SHA-256", combined);
    return toBase64(hash);
}

/**
 * Verifies a password against a stored verification hash.
 * Uses constant-time comparison (via subtle.verify) to resist timing attacks.
 */
export async function verifyPassword(
    password: string,
    saltB64: string,
    storedHashB64: string
): Promise<boolean> {
    try {
        const computed = await hashForVerification(password, saltB64);
        // Constant-time string comparison via typed array
        const a = fromBase64(computed);
        const b = fromBase64(storedHashB64);
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
    } catch {
        return false;
    }
}

// ── Encryption / Decryption ───────────────────────────────────────────────────

export interface EncryptedPayload {
    iv: string;         // base64
    ciphertext: string; // base64
}

/**
 * Encrypts a UTF-8 plaintext string with AES-256-GCM.
 * A fresh IV is generated on every call.
 */
export async function encryptData(
    key: CryptoKey,
    plaintext: string
): Promise<EncryptedPayload> {
    const enc = new TextEncoder();
    const ivB64 = generateIV();
    const iv = fromBase64(ivB64);

    const ciphertextBuf = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
        key,
        enc.encode(plaintext)
    );

    return {
        iv: ivB64,
        ciphertext: toBase64(ciphertextBuf),
    };
}

/**
 * Decrypts an AES-256-GCM ciphertext.
 * Throws if the ciphertext has been tampered with (GCM authentication tag failure).
 */
export async function decryptData(
    key: CryptoKey,
    ivB64: string,
    ciphertextB64: string
): Promise<string> {
    const iv = fromBase64(ivB64);
    const ciphertext = fromBase64(ciphertextB64);

    const plaintextBuf = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
        key,
        ciphertext
    );

    return new TextDecoder().decode(plaintextBuf);
}

// ── PIN hash helpers ──────────────────────────────────────────────────────────

/** Hash a PIN for storage. Same mechanism as password verification hash. */
export async function hashPIN(pin: string, saltB64: string): Promise<string> {
    return hashForVerification(pin, saltB64);
}

export async function verifyPIN(
    pin: string,
    saltB64: string,
    storedHashB64: string
): Promise<boolean> {
    return verifyPassword(pin, saltB64, storedHashB64);
}
