/** SMTP delivery with no dependency.
 *
 * The email notification channel used to need an HTTP gateway you ran yourself
 * (`EMAIL_RELAY_URL`); the app did not speak SMTP. That left every operator to
 * write the same fifteen-line relay. This module is the fifteen lines, in the
 * process, on `node:net` and `node:tls`.
 *
 * Deliberate limits, all of them on purpose:
 * - One recipient per message. Notifications are per user, so a Cc/Bcc list is
 *   a feature nobody asked for.
 * - TLS is required unless the operator turns it off. A missing `STARTTLS` is
 *   an error, not a downgrade, because the next thing on the wire is AUTH.
 *   `SMTP_REQUIRE_TLS=0` exists for a relay on the operator's own network.
 * - Certificate verification is never disabled. There is no knob for it.
 * - The body is base64, which is also why no dot-stuffing is needed: no line
 *   can begin with ".". CRLF line endings are produced per RFC 5322.
 * - A failure throws with the server's own reply, so the queue retries. Nothing
 *   here ever reports a message as sent that did not leave.
 */
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

const MAX_REPLY_CHARS = 20000;

/** Read the SMTP settings, or `null` when no host is configured. Throws only on
 * a value that cannot work at all, so a typo shows up at boot instead of at the
 * first notification. */
export function smtpConfig(env = process.env) {
  const host = String(env.SMTP_HOST || '').trim();
  if (!host) return null;
  const secure = String(env.SMTP_SECURE || '') === '1';
  const rawPort = String(env.SMTP_PORT || '').trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : (secure ? 465 : 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a port number between 1 and 65535.');
  }
  const timeout = Number(env.SMTP_TIMEOUT_MS);
  return {
    host,
    port,
    // 465 is implicit TLS; 587 and 25 start plaintext and upgrade with STARTTLS.
    secure,
    requireTls: secure || String(env.SMTP_REQUIRE_TLS ?? '1') !== '0',
    user: String(env.SMTP_USER || '').trim(),
    pass: String(env.SMTP_PASS ?? env.SMTP_PASSWORD ?? ''),
    from: String(env.SMTP_FROM || env.SMTP_USER || '').trim(),
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : 20 * 1000,
  };
}

/** `Name <a@b>` or `a@b` to the bare address, refusing anything that could end a
 * header line or an SMTP command. */
function addressOf(value, setting) {
  const text = String(value || '').trim();
  const address = (/<([^<>]+)>/.exec(text)?.[1] || text).trim();
  if (!/^[^\s@<>",;:]+@[^\s@<>",;:]+$/.test(address)) {
    throw new Error(`${setting} must hold an email address, e.g. agent@example.com or "Agent Control <agent@example.com>".`);
  }
  return address;
}

/** One header value: control characters out, RFC 2047 words for anything that
 * is not printable ASCII, folded at 45 bytes so no encoded word exceeds 75. */
function headerValue(value, limit = 400) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, limit);
  return /^[\x20-\x7e]*$/.test(text) ? text : encodeWords(text);
}

/** RFC 2047 encoded words for one run of text, folded so no word exceeds 75
 * bytes. A character is never split across two words. */
function encodeWords(text) {
  const words = [];
  let rest = Buffer.from(text, 'utf8');
  while (rest.length) {
    let take = Math.min(45, rest.length);
    // Never split a multi-byte character across two encoded words.
    while (take > 1 && (rest[take] & 0xc0) === 0x80) take--;
    words.push(`=?UTF-8?B?${rest.subarray(0, take).toString('base64')}?=`);
    rest = rest.subarray(take);
  }
  return words.join('\r\n ');
}

/** `Name <a@b>` as a From/To header. RFC 2047 allows an encoded *display name*
 * and forbids encoding the addr-spec: mailing it as one encoded word makes some
 * servers reject the message and others show the address as garbage. */
function addressHeader(value, limit = 400) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, limit);
  const match = /^(.*?)<([^<>]+)>$/.exec(text);
  if (!match) return headerValue(text, limit);
  const address = match[2].trim();
  const name = match[1].trim().replace(/^"(.*)"$/, '$1').trim();
  if (!name) return address;
  // A plain ASCII name is left alone unless it needs quoting to stay one word.
  if (/^[\x20-\x7e]*$/.test(name) && !/["(),.:;<>@\[\\\]]/.test(name)) return `${name} <${address}>`;
  return `${/^[\x20-\x7e]*$/.test(name) ? `"${name}"` : encodeWords(name)} <${address}>`;
}

function heloName() {
  const name = String(os.hostname() || '').replace(/[^A-Za-z0-9.-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
  return name || 'localhost';
}

/** The whole message, headers and base64 body. Pure, so a test could check it
 * without a socket. */
export function buildMessage({from, to, subject, text, date = new Date(), messageId = crypto.randomUUID()}) {
  const body = Buffer.from(String(text ?? '').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8')
    .toString('base64').replace(/.{1,76}/g, '$&\r\n');
  const headers = [
    `From: ${addressHeader(from)}`,
    `To: ${addressHeader(to)}`,
    `Subject: ${headerValue(subject || 'Agent Control')}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}@${heloName()}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    // An auto-reply to this mailbox will not bounce back into the queue.
    'Auto-Submitted: auto-generated',
    'X-Agent-Control: notification',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/** Sequential line reader over one socket. SMTP is request/response with a
 * multi-line reply format, so a waiting line is the whole concurrency model. */
function lines(socket) {
  let buffer = '';
  let failure = null;
  const queue = [];
  let waiting = null;
  const pump = () => {
    while (waiting && (queue.length || failure)) {
      const current = waiting;
      waiting = null;
      if (queue.length) current.resolve(queue.shift());
      else current.reject(failure);
    }
  };
  const onData = chunk => {
    buffer += chunk;
    if (buffer.length > MAX_REPLY_CHARS) {
      failure = new Error('SMTP sent a reply that is too large.');
      socket.destroy();
    }
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      queue.push(buffer.slice(0, at).replace(/\r$/, ''));
      buffer = buffer.slice(at + 1);
    }
    pump();
  };
  const onError = error => { failure = error; pump(); };
  const onClose = () => { failure = failure || new Error('SMTP connection closed.'); pump(); };
  socket.setEncoding('utf8');
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  return {
    next: () => new Promise((resolve, reject) => {
      if (failure && !queue.length) return reject(failure);
      waiting = {resolve, reject};
      pump();
    }),
    // Before wrapping the socket in TLS: the raw listeners must stop, or the
    // encrypted bytes would arrive as garbage reply lines.
    detach: () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

/** A multi-line reply is `250-something`, `250-something`, `250 last`. */
async function reply(next, what) {
  const collected = [];
  for (;;) {
    const line = await next();
    if (!/^\d{3}[ -]/.test(line)) throw new Error(`SMTP sent an unexpected ${what} reply: ${line.slice(0, 120)}`);
    collected.push(line);
    if (line[3] === ' ') break;
  }
  return {
    code: Number(collected[0].slice(0, 3)),
    text: collected.map(line => line.slice(4)).join(' ').slice(0, 400),
  };
}

function expect(replyValue, codes, what) {
  if (!codes.includes(replyValue.code)) throw new Error(`SMTP ${what} failed: ${replyValue.code} ${replyValue.text}`.trim());
  return replyValue;
}

function dial(config) {
  return new Promise((resolve, reject) => {
    const options = {host: config.host, port: config.port, timeout: config.timeoutMs};
    const socket = config.secure
      ? tls.connect({...options, servername: net.isIP(config.host) ? undefined : config.host}, () => resolve(socket))
      : net.connect(options, () => resolve(socket));
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error(`SMTP timed out after ${Math.round(config.timeoutMs / 1000)}s.`)));
  });
}

function upgrade(socket, config) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: net.isIP(config.host) ? undefined : config.host,
      timeout: config.timeoutMs,
    });
    secure.once('secureConnect', () => { secure.removeListener('error', reject); resolve(secure); });
    secure.once('error', reject);
    secure.once('timeout', () => secure.destroy(new Error(`SMTP timed out after ${Math.round(config.timeoutMs / 1000)}s.`)));
  });
}

const say = (socket, line) => socket.write(`${line}\r\n`);
const b64 = value => Buffer.from(String(value), 'utf8').toString('base64');

/** Send one plain-text message. Resolves `{sent: true}` or throws, and the
 * caller's queue retries on the throw. */
export async function sendMail({to, subject, text}, config = smtpConfig()) {
  if (!config) throw new Error('No SMTP host is configured.');
  const from = addressOf(config.from, 'SMTP_FROM');
  const recipient = addressOf(to, 'The recipient address');
  let socket = await dial(config);
  let stream = lines(socket);
  const quit = () => {
    if (socket.destroyed) return;
    try { say(socket, 'QUIT'); } catch { /* the socket is going away */ }
    // `end` flushes the QUIT; a server that hangs up without answering must not
    // keep this socket (or the process) alive.
    socket.end();
    socket.setTimeout(1000, () => socket.destroy());
  };
  try {
    expect(await reply(stream.next, 'greeting'), [220], 'greeting');
    let capabilities = '';
    const hello = async () => {
      say(socket, `EHLO ${heloName()}`);
      capabilities = expect(await reply(stream.next, 'EHLO'), [250], 'EHLO').text.toUpperCase();
    };
    await hello();
    if (!config.secure) {
      if (!/\bSTARTTLS\b/.test(capabilities)) {
        if (config.requireTls) {
          throw new Error('The SMTP server does not offer STARTTLS, so nothing was sent. Set SMTP_REQUIRE_TLS=0 only for a relay on your own network.');
        }
      } else {
        say(socket, 'STARTTLS');
        const offered = await reply(stream.next, 'STARTTLS');
        // A server can advertise STARTTLS and still refuse the command (454 is
        // common when its own certificate is broken). With the explicit
        // SMTP_REQUIRE_TLS=0 opt-out the operator asked to send anyway, so a
        // refusal falls back to the cleartext session instead of blocking the
        // notification. The default (TLS required) still fails loudly.
        if (offered.code === 220) {
          stream.detach();
          socket = await upgrade(socket, config);
          stream = lines(socket);
          await hello();
        } else if (config.requireTls) {
          throw new Error(`The SMTP server offered STARTTLS but refused it (${offered.code} ${offered.text}), so nothing was sent. Fix the relay's certificate, or set SMTP_REQUIRE_TLS=0 only for a relay on your own network.`.trim());
        } else {
          console.warn(`[mail] SMTP offered STARTTLS but refused it (${offered.code}); continuing without TLS because SMTP_REQUIRE_TLS=0.`);
        }
      }
    }
    if (config.user) {
      const loginOffered = /\bAUTH\b[^\r\n]*\bLOGIN\b/.test(capabilities);
      const plainOffered = /\bAUTH\b[^\r\n]*\bPLAIN\b/.test(capabilities);
      if (loginOffered && !plainOffered) {
        say(socket, 'AUTH LOGIN');
        expect(await reply(stream.next, 'AUTH LOGIN'), [334], 'AUTH LOGIN');
        say(socket, b64(config.user));
        expect(await reply(stream.next, 'AUTH user'), [334], 'AUTH username');
        say(socket, b64(config.pass));
      } else {
        say(socket, `AUTH PLAIN ${b64(`\u0000${config.user}\u0000${config.pass}`)}`);
      }
      const auth = await reply(stream.next, 'AUTH');
      if (auth.code === 535) throw new Error('SMTP authentication was refused. Check SMTP_USER and SMTP_PASS.');
      expect(auth, [235], 'AUTH');
    }
    say(socket, `MAIL FROM:<${from}>`);
    expect(await reply(stream.next, 'MAIL FROM'), [250], 'MAIL FROM');
    say(socket, `RCPT TO:<${recipient}>`);
    expect(await reply(stream.next, 'RCPT TO'), [250, 251], 'RCPT TO');
    say(socket, 'DATA');
    expect(await reply(stream.next, 'DATA'), [354], 'DATA');
    // The terminating line is the message plus a bare dot on its own line. The
    // base64 body cannot produce a line that starts with a dot.
    say(socket, `${buildMessage({from, to: recipient, subject, text})}\r\n.`);
    expect(await reply(stream.next, 'message body'), [250], 'message body');
    quit();
    return {sent: true};
  } catch (error) {
    quit();
    // The password only ever travels inside a base64 argument; make sure a
    // server that echoes a command back cannot put it in an error message.
    const message = String(error?.message || 'SMTP delivery failed.');
    throw new Error(config.pass ? message.split(config.pass).join('[redacted]').split(b64(config.pass)).join('[redacted]') : message);
  }
}
