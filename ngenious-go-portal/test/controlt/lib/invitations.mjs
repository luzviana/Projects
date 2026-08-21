import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CODE = /^[A-Za-z0-9_-]{22}$/;

const hash = (value) => createHash("sha256").update(value).digest("hex");

function equalText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

export class InvitationStore {
  constructor(config, { now = () => Date.now() } = {}) {
    this.directory = config.invitationDirectory;
    this.publicOrigin = config.invitationPublicOrigin;
    this.realm = config.realm;
    this.ttlMs = config.invitationLifespanSeconds * 1000;
    this.key = Buffer.from(config.invitationSecret, "hex");
    this.now = now;
    if (this.key.length !== 32) throw new Error("CONTROLT_INVITATION_SECRET must contain exactly 32 bytes encoded as hexadecimal");
  }

  validateActionUrl(value) {
    let url;
    try { url = new URL(value); }
    catch { throw new Error("The identity action URL is invalid"); }
    const expected = new URL(this.publicOrigin);
    const actionPrefix = `/realms/${encodeURIComponent(this.realm)}/login-actions/action-token`;
    if (url.protocol !== "https:" || url.origin !== expected.origin || url.pathname !== actionPrefix || !url.searchParams.get("key")) {
      throw new Error("The identity action URL is outside the approved Keycloak action endpoint");
    }
    return url.href;
  }

  async create(actionUrl) {
    const approvedUrl = this.validateActionUrl(actionUrl);
    const code = randomBytes(16).toString("base64url");
    const id = hash(code);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const expiresAt = this.now() + this.ttlMs;
    const ciphertext = Buffer.concat([cipher.update(approvedUrl, "utf8"), cipher.final()]);
    const record = {
      version: 1,
      expiresAt,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${id}.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, join(this.directory, `${id}.json`));
    return {
      code,
      url: new URL(`/invite/${code}`, this.publicOrigin).href,
      expiresAt,
    };
  }

  async resolve(code) {
    if (!CODE.test(String(code || ""))) return null;
    let record;
    const path = join(this.directory, `${hash(code)}.json`);
    try { record = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
    if (record.version !== 1 || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= this.now()) {
      try { await unlink(path); } catch {}
      return null;
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(record.iv, "base64url"));
      decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
      const value = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return { actionUrl: this.validateActionUrl(value), expiresAt: record.expiresAt };
    } catch {
      return null;
    }
  }

  confirmation(code) {
    return createHmac("sha256", this.key).update(`continue:${code}`).digest("base64url");
  }

  verifyConfirmation(code, supplied) {
    return CODE.test(String(code || "")) && equalText(this.confirmation(code), supplied);
  }

  async cleanup() {
    let names;
    try { names = await readdir(this.directory); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        const record = JSON.parse(await readFile(join(this.directory, name), "utf8"));
        if (!Number.isSafeInteger(record.expiresAt) || record.expiresAt <= this.now()) await unlink(join(this.directory, name));
      } catch {}
    }));
  }
}

export function invitationPage({ code, confirmation, expired = false }) {
  const title = expired ? "Invitation unavailable" : "Finish setting up your account";
  const description = expired
    ? "This invitation is invalid or has expired. Ask your administrator to send a new invitation."
    : "Continue to the secure ngenious identity service to verify your email and create your password.";
  const action = `/invite/${encodeURIComponent(code)}/continue`;
  const form = expired ? "" : `<form method="post" action="${action}"><input type="hidden" name="confirmation" value="${confirmation}"><button type="submit">Continue setup</button></form>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | ngenious</title><link rel="stylesheet" href="/invite/invitation.css"></head><body><main class="shell"><div class="brand">ngenious</div><section class="card"><p class="eyebrow">Secure account setup</p><h1>${title}</h1><p>${description}</p>${form}</section><small>Need help? Contact your administrator.</small></main></body></html>`;
}

export const invitationCss = `:root{color-scheme:light;font-family:Arial,Helvetica,sans-serif;color:#102239;background:#123f53}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px}.shell{width:min(560px,100%)}.brand{color:#22bec7;font-size:30px;font-weight:800;letter-spacing:1px;text-align:center;margin:0 0 22px}.card{background:#fff;border-top:5px solid #22bec7;border-radius:18px;padding:42px 40px;box-shadow:0 24px 60px #062b3c66}.eyebrow{color:#087f78;font-size:13px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;margin:0 0 10px}h1{font-size:32px;line-height:1.16;margin:0 0 18px}p{color:#52677b;font-size:16px;line-height:1.55;margin:0 0 28px}button{border:0;border-radius:10px;background:#22bec7;color:#102239;font:inherit;font-weight:800;padding:15px 24px;cursor:pointer}button:hover{background:#36ccd4}small{display:block;color:#d5e3e8;text-align:center;margin-top:18px}@media(max-width:520px){.card{padding:32px 24px}h1{font-size:27px}}`;
