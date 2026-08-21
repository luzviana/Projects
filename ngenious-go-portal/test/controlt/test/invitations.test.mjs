import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdentityMailRelay, parseIdentityEmail } from "../lib/identity-mail-relay.mjs";
import { InvitationStore } from "../lib/invitations.mjs";

const actionUrl = "https://id.ngenious.app/realms/go-portal-test/login-actions/action-token?key=secret.keycloak.jwt";

async function temporaryStore(now = () => Date.now()) {
  const directory = await mkdtemp(join(tmpdir(), "controlt-invitations-"));
  const config = {
    invitationDirectory: directory,
    invitationPublicOrigin: "https://id.ngenious.app",
    invitationLifespanSeconds: 43_200,
    invitationSecret: "11".repeat(32),
    realm: "go-portal-test",
  };
  return { directory, config, store: new InvitationStore(config, { now }) };
}

test("invitation records encrypt the Keycloak action and resolve through an opaque short code", async () => {
  const fixture = await temporaryStore();
  try {
    const created = await fixture.store.create(actionUrl);
    assert.match(created.url, /^https:\/\/id\.ngenious\.app\/invite\/[A-Za-z0-9_-]{22}$/);
    const files = await readdir(fixture.directory);
    assert.equal(files.length, 1);
    const stored = await readFile(join(fixture.directory, files[0]), "utf8");
    assert.doesNotMatch(stored, /secret\.keycloak\.jwt/);
    assert.deepEqual(await fixture.store.resolve(created.code), { actionUrl, expiresAt: created.expiresAt });
    assert.equal(fixture.store.verifyConfirmation(created.code, fixture.store.confirmation(created.code)), true);
    assert.equal(fixture.store.verifyConfirmation(created.code, "forged"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("expired invitations cannot resolve and are removed", async () => {
  let now = 1_000;
  const fixture = await temporaryStore(() => now);
  try {
    const created = await fixture.store.create(actionUrl);
    now = created.expiresAt + 1;
    assert.equal(await fixture.store.resolve(created.code), null);
    assert.deepEqual(await readdir(fixture.directory), []);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

const rawEmail = `From: ngenious <no-reply@ngenious.app>\r
To: person@example.test\r
Subject: Set up your ngenious account\r
MIME-Version: 1.0\r
Content-Type: multipart/alternative; boundary="invite-boundary"\r
\r
--invite-boundary\r
Content-Type: text/plain; charset=UTF-8\r
Content-Transfer-Encoding: quoted-printable\r
\r
Continue here: https://id.ngenious.app/realms/go-portal-test/login-actions/action-token?key=3Dsecret.keycloak.jwt\r
--invite-boundary\r
Content-Type: text/html; charset=UTF-8\r
Content-Transfer-Encoding: quoted-printable\r
\r
<a href=3D"https://id.ngenious.app/realms/go-portal-test/login-actions/action-token?key&#61;secret.keycloak.jwt">Continue</a>\r
--invite-boundary--\r
`;

test("the identity email parser decodes Keycloak multipart content", () => {
  const parsed = parseIdentityEmail(rawEmail);
  assert.equal(parsed.from, "ngenious <no-reply@ngenious.app>");
  assert.equal(parsed.to, "person@example.test");
  assert.match(parsed.textBody, /key=secret\.keycloak\.jwt/);
  assert.match(parsed.htmlBody, /key&#61;secret\.keycloak\.jwt/);
});

test("the relay replaces the raw action URL and forwards only the short ngenious link", async () => {
  const fixture = await temporaryStore();
  const requests = [];
  try {
    const relay = new IdentityMailRelay({
      ...fixture.config,
      postmarkServerToken: "test-token",
      postmarkMessageStream: "outbound",
    }, fixture.store, async (url, options) => {
      requests.push([url, JSON.parse(options.body)]);
      return new Response(JSON.stringify({ ErrorCode: 0, MessageID: "message-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await relay.deliver(rawEmail);
    assert.equal(result.shortened, true);
    assert.equal(result.messageId, "message-1");
    const body = requests[0][1];
    assert.doesNotMatch(`${body.TextBody}${body.HtmlBody}`, /secret\.keycloak\.jwt/);
    assert.match(body.TextBody, /https:\/\/id\.ngenious\.app\/invite\/[A-Za-z0-9_-]{22}/);
    assert.match(body.HtmlBody, /https:\/\/id\.ngenious\.app\/invite\/[A-Za-z0-9_-]{22}/);
    assert.equal(body.ReplyTo, undefined);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
