import net from "node:net";

const ACTION_URL = /https:\/\/id\.ngenious\.app\/realms\/[^\s"'<>]+\/login-actions\/action-token\?key=[^\s"'<>]+/g;

function unfoldHeaders(value) {
  const result = new Map();
  for (const line of value.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const content = line.slice(separator + 1).trim();
    if (!result.has(name)) result.set(name, content);
  }
  return result;
}

function decodeQuotedPrintable(value) {
  const compact = value.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let index = 0; index < compact.length; index += 1) {
    if (compact[index] === "=" && /^[0-9a-f]{2}$/i.test(compact.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(compact.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(compact[index], "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeBody(body, encoding) {
  if (encoding === "base64") return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return body;
}

function parsePart(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  if (split < 0) return { headers: new Map(), body: raw };
  const separator = raw.slice(split).match(/^\r?\n\r?\n/)[0];
  return { headers: unfoldHeaders(raw.slice(0, split)), body: raw.slice(split + separator.length) };
}

export function parseIdentityEmail(raw) {
  const root = parsePart(raw);
  const contentType = root.headers.get("content-type") || "text/plain";
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  const bodies = { text: "", html: "" };
  const parts = boundary ? root.body.split(`--${boundary}`).slice(1, -1).map(parsePart) : [root];
  for (const part of parts) {
    const type = (part.headers.get("content-type") || contentType).toLowerCase();
    const encoding = (part.headers.get("content-transfer-encoding") || "").toLowerCase();
    const decoded = decodeBody(part.body.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), encoding);
    if (type.startsWith("text/plain") && !bodies.text) bodies.text = decoded;
    if (type.startsWith("text/html") && !bodies.html) bodies.html = decoded;
  }
  return {
    from: root.headers.get("from") || "",
    to: root.headers.get("to") || "",
    subject: root.headers.get("subject") || "",
    textBody: bodies.text,
    htmlBody: bodies.html,
  };
}

function actionLinks(message) {
  const normalizedHtml = message.htmlBody.replaceAll("&#61;", "=").replaceAll("&amp;", "&");
  return [...new Set([...message.textBody.matchAll(ACTION_URL), ...normalizedHtml.matchAll(ACTION_URL)].map((match) => match[0]))];
}

function replaceLink(value, actionUrl, shortUrl) {
  return value
    .replaceAll(actionUrl, shortUrl)
    .replaceAll(actionUrl.replaceAll("&", "&amp;").replaceAll("=", "&#61;"), shortUrl);
}

export class IdentityMailRelay {
  constructor(config, invitations, fetchImpl = fetch) {
    this.config = config;
    this.invitations = invitations;
    this.fetch = fetchImpl;
  }

  async deliver(raw) {
    const message = parseIdentityEmail(raw);
    if (!message.from.toLowerCase().includes("@ngenious.app") || !message.to || !message.subject || (!message.textBody && !message.htmlBody)) {
      throw new Error("The identity email is missing an approved sender, recipient, subject, or body");
    }
    const links = actionLinks(message);
    if (links.length > 1) throw new Error("The identity email contains multiple action URLs");
    if (links.length === 1) {
      const invitation = await this.invitations.create(links[0]);
      message.textBody = replaceLink(message.textBody, links[0], invitation.url);
      message.htmlBody = replaceLink(message.htmlBody, links[0], invitation.url);
    }
    const response = await this.fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-postmark-server-token": this.config.postmarkServerToken,
      },
      body: JSON.stringify({
        From: message.from,
        To: message.to,
        Subject: message.subject,
        TextBody: message.textBody || undefined,
        HtmlBody: message.htmlBody || undefined,
        MessageStream: this.config.postmarkMessageStream,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ErrorCode !== 0) throw new Error(`Postmark delivery failed with HTTP ${response.status}`);
    return { messageId: result.MessageID, shortened: links.length === 1 };
  }
}

export function createIdentitySmtpServer(config, relay, { logError = (record) => process.stderr.write(`${JSON.stringify(record)}\n`) } = {}) {
  return net.createServer((socket) => {
    socket.setTimeout(30_000);
    socket.setEncoding("utf8");
    socket.write("220 controlt identity relay ready\r\n");
    let buffer = "";
    let data = false;
    let message = "";
    let recipient = false;

    const reply = (line) => socket.write(`${line}\r\n`);
    const reset = () => { data = false; message = ""; recipient = false; };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const drain = async () => {
        while (true) {
          if (data) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) {
              if (message.length + buffer.length > config.identityRelayMaxBytes) throw new Error("Identity email exceeds the relay size limit");
              message += buffer;
              buffer = "";
              return;
            }
            message += buffer.slice(0, end + 2).replace(/\r\n\.\./g, "\r\n.");
            buffer = buffer.slice(end + 5);
            data = false;
            try {
              const result = await relay.deliver(message);
              reply(`250 2.0.0 accepted ${result.messageId}`);
            } catch (error) {
              logError({ type: "controlt.identity_relay_error", time: new Date().toISOString(), message: error?.message || "Relay failure" });
              reply("451 4.3.0 identity email could not be delivered");
            }
            reset();
            continue;
          }
          const end = buffer.indexOf("\r\n");
          if (end < 0) return;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const command = line.split(/\s+/, 1)[0].toUpperCase();
          if (command === "EHLO" || command === "HELO") reply("250-controlt\r\n250 SIZE 524288");
          else if (command === "MAIL") { reset(); reply("250 2.1.0 sender accepted"); }
          else if (command === "RCPT") { recipient = true; reply("250 2.1.5 recipient accepted"); }
          else if (command === "DATA" && recipient) { data = true; reply("354 end with <CRLF>.<CRLF>"); }
          else if (command === "RSET") { reset(); reply("250 2.0.0 reset"); }
          else if (command === "NOOP") reply("250 2.0.0 ok");
          else if (command === "QUIT") { reply("221 2.0.0 bye"); socket.end(); return; }
          else reply("502 5.5.2 command not supported");
        }
      };
      drain().catch((error) => {
        logError({ type: "controlt.identity_relay_error", time: new Date().toISOString(), message: error?.message || "Relay failure" });
        if (!socket.destroyed) { reply("421 4.3.0 relay unavailable"); socket.end(); }
      });
    });
    socket.on("timeout", () => socket.end("421 4.4.2 timeout\r\n"));
    socket.on("error", () => {});
  });
}
