import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the shared-test realm uses the approved eight-character password minimum", async () => {
  const template = await readFile(new URL("../../template.yaml", import.meta.url), "utf8");
  const realmSecurityScript = await readFile(
    new URL("../../scripts/configure-test-realm-security.sh", import.meta.url),
    "utf8",
  );
  const approvedPolicy =
    "passwordPolicy=length(8) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1)";

  assert.match(
    template,
    /"passwordPolicy": "length\(8\) and upperCase\(1\) and lowerCase\(1\) and digits\(1\) and specialChars\(1\)"/,
  );
  assert.match(realmSecurityScript, new RegExp(approvedPolicy.replace(/[()]/g, "\\$&")));
});
