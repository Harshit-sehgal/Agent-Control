import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {smtpConfig, sendMail, buildMessage} from '../src/mail.js';

/** A scripted SMTP server on loopback: enough of the protocol to prove the
 * client's handshake, and it records what actually went over the wire. */
async function fakeSmtp({
  capabilities = ['AUTH PLAIN LOGIN', 'SIZE 10240000'],
  user = 'bot@example.com',
  pass = 'hunter2',
  rejectRecipient = false,
  starttls = false,
  echoAuth = false,
} = {}) {
  const state = {commands: [], auth: null, mailFrom: null, recipient: null, message: null};
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.write('220 test.local ESMTP agent-control\r\n');
    let buffer = '';
    let mode = 'command';
    let message = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (mode === 'data') {
          if (line === '.') {
            mode = 'command';
            state.message = message;
            socket.write('250 2.0.0 queued\r\n');
          } else message += `${line.replace(/^\.\./, '.')}\r\n`;
          continue;
        }
        if (mode === 'login-user' || mode === 'login-pass') {
          const decoded = Buffer.from(line, 'base64').toString('utf8');
          state.auth = mode === 'login-user' ? {user: decoded, pass: ''} : {...state.auth, pass: decoded};
          if (mode === 'login-user') { mode = 'login-pass'; socket.write('334 UGFzc3dvcmQ6\r\n'); }
          else {
            mode = 'command';
            const ok = state.auth.user === user && state.auth.pass === pass;
            socket.write(echoAuth ? `534 5.7.9 refused: ${line}\r\n` : ok ? '235 2.7.0 accepted\r\n' : '535 5.7.8 authentication failed\r\n');
          }
          continue;
        }
        state.commands.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          const rows = ['test.local'];
          if (starttls) rows.push('STARTTLS');
          if (capabilities.length) rows.push(...capabilities);
          socket.write(rows.map((row, i) => `250${i === rows.length - 1 ? ' ' : '-'}${row}`).join('\r\n') + '\r\n');
        } else if (verb === 'STARTTLS') {
          // Not exercised: a real upgrade needs a certificate. The client's TLS
          // path is the same code either way; the refusal path is what matters.
          socket.write('454 4.7.0 TLS not available\r\n');
        } else if (verb === 'AUTH') {
          const [, mechanism, argument] = line.split(' ');
          if (mechanism.toUpperCase() === 'PLAIN') {
            const parts = Buffer.from(argument || '', 'base64').toString('utf8').split('\u0000');
            state.auth = {user: parts[1] || '', pass: parts[2] || ''};
            const ok = state.auth.user === user && state.auth.pass === pass;
            // A relay that quotes the command it did not like: the exact shape
            // that put an AUTH PLAIN argument into a stored error.
            socket.write(echoAuth ? `534 5.7.9 refused: ${line}\r\n` : ok ? '235 2.7.0 accepted\r\n' : '535 5.7.8 authentication failed\r\n');
          } else {
            mode = 'login-user';
            socket.write('334 VXNlcm5hbWU6\r\n');
          }
        } else if (verb === 'MAIL') {
          state.mailFrom = line;
          socket.write('250 2.1.0 ok\r\n');
        } else if (verb === 'RCPT') {
          state.recipient = line;
          socket.write(rejectRecipient ? '550 5.1.1 no such user\r\n' : '250 2.1.5 ok\r\n');
        } else if (verb === 'DATA') {
          mode = 'data';
          socket.write('354 end with a single dot\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else {
          socket.write('500 5.5.2 unrecognised\r\n');
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    state,
    close: () => new Promise(resolve => {

      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

const config = port => ({
  host: '127.0.0.1', port, secure: false, requireTls: false,
  user: 'bot@example.com', pass: 'hunter2', from: 'Agent Control <bot@example.com>', timeoutMs: 5000,
});

test('smtpConfig reads a mailbox, defaults the port and refuses a nonsense one', () => {
  assert.equal(smtpConfig({}), null);
  const plain = smtpConfig({SMTP_HOST: 'mail.example.com', SMTP_USER: 'u', SMTP_PASS: 'p'});
  assert.equal(plain.port, 587, 'submission port by default');
  assert.equal(plain.secure, false);
  assert.equal(plain.requireTls, true, 'TLS is required unless it is explicitly switched off');
  assert.equal(plain.from, 'u', 'the user doubles as the sender');
  const implicit = smtpConfig({SMTP_HOST: 'mail.example.com', SMTP_SECURE: '1'});
  assert.equal(implicit.port, 465);
  assert.equal(implicit.secure, true);
  assert.equal(implicit.requireTls, true);
  assert.equal(smtpConfig({SMTP_HOST: 'h', SMTP_REQUIRE_TLS: '0'}).requireTls, false);
  assert.throws(() => smtpConfig({SMTP_HOST: 'h', SMTP_PORT: '99999'}), /SMTP_PORT/);
});

test('a message has the headers, the encoded subject and a readable body', () => {
  const message = buildMessage({
    from: 'Agent Control <bot@example.com>', to: 'ops@example.com',
    subject: 'Updated → draft waiting', text: 'Line one.\nLine two.',
    date: new Date('2026-01-02T03:04:05Z'), messageId: 'fixed-id',
  });
  assert.match(message, /^From: Agent Control <bot@example\.com>\r\nTo: ops@example\.com\r\n/);
  assert.match(message, /^Subject: =\?UTF-8\?B\?/m, 'a non-ASCII subject is an encoded word');
  assert.match(message, /^Date: Fri, 02 Jan 2026 03:04:05 GMT$/m);
  assert.match(message, /^Message-ID: <fixed-id@/m);
  assert.match(message, /^MIME-Version: 1\.0$/m);
  assert.match(message, /^Content-Transfer-Encoding: base64$/m);
  assert.match(message, /^Auto-Submitted: auto-generated$/m, 'an auto-reply cannot bounce back into the queue');
  const body = message.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  assert.equal(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'), 'Line one.\r\nLine two.');
  // A header can never be split by a newline typed into the subject.
  const injected = buildMessage({from: 'a@b.co', to: 'c@d.co', subject: 'hello\r\nBcc: victim@example.com', text: ''});
  assert.doesNotMatch(injected, /^Bcc:/m);
});

test('sendMail speaks the handshake, authenticates and delivers the message', async () => {
  const server = await fakeSmtp();
  try {
    assert.deepEqual(await sendMail({to: 'ops@example.com', subject: 'Draft waiting', text: 'Two drafts need you.'}, config(server.port)), {sent: true});
    assert.equal(server.state.auth.user, 'bot@example.com');
    assert.equal(server.state.auth.pass, 'hunter2');
    assert.match(server.state.mailFrom, /^MAIL FROM:<bot@example\.com>$/);
    assert.match(server.state.recipient, /^RCPT TO:<ops@example\.com>$/);
    const message = server.state.message;
    assert.match(message, /^To: ops@example\.com$/m);
    assert.match(message, /^Subject: Draft waiting$/m);
    const body = message.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    assert.equal(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'), 'Two drafts need you.');
  } finally { await server.close(); }
});

test('AUTH LOGIN is used when the server does not offer PLAIN', async () => {
  const server = await fakeSmtp({capabilities: ['AUTH LOGIN']});
  try {
    await sendMail({to: 'ops@example.com', subject: 's', text: 'b'}, config(server.port));
    assert.ok(server.state.commands.some(line => line === 'AUTH LOGIN'));
    assert.equal(server.state.auth.pass, 'hunter2');
  } finally { await server.close(); }
});

test('a server without STARTTLS is refused before any credential is sent', async () => {
  const server = await fakeSmtp();
  try {
    await assert.rejects(
      sendMail({to: 'ops@example.com', subject: 's', text: 'b'}, {...config(server.port), requireTls: true}),
      /STARTTLS/);
    assert.equal(server.state.auth, null, 'Nothing authenticated over a cleartext socket.');
    assert.equal(server.state.message, null, 'And nothing was delivered.');
  } finally { await server.close(); }
});

test('a refused recipient and a refused password both fail loudly, without leaking the secret', async () => {
  const refusedRecipient = await fakeSmtp({rejectRecipient: true});
  try {
    await assert.rejects(sendMail({to: 'ops@example.com', subject: 's', text: 'b'}, config(refusedRecipient.port)), error => {
      assert.match(error.message, /RCPT TO failed: 550/);
      assert.equal(refusedRecipient.state.message, null, 'No message body after a refused recipient.');
      return true;
    });
  } finally { await refusedRecipient.close(); }

  const wrongPassword = await fakeSmtp();
  try {
    await assert.rejects(
      sendMail({to: 'ops@example.com', subject: 's', text: 'b'}, {...config(wrongPassword.port), pass: 'not-the-password'}),
      error => {
        assert.match(error.message, /authentication was refused/);
        assert.doesNotMatch(error.message, /not-the-password/);
        assert.ok(!error.message.includes(Buffer.from('not-the-password').toString('base64')), 'not even the encoded form');
        return true;
      });
  } finally { await wrongPassword.close(); }
});

test('a server that offers STARTTLS and then refuses it fails loudly when TLS is required', async () => {
  const server = await fakeSmtp({starttls: true});
  try {
    await assert.rejects(
      sendMail({to: 'ops@example.com', subject: 's', text: 'b'}, {...config(server.port), requireTls: true}),
      error => {
        assert.match(error.message, /offered STARTTLS but refused it \(454/);
        assert.match(error.message, /SMTP_REQUIRE_TLS=0/, 'the message should name the way out');
        return true;
      });
    assert.equal(server.state.auth, null, 'Nothing authenticated after a refused upgrade.');
    assert.equal(server.state.message, null, 'And nothing was delivered.');
  } finally { await server.close(); }
});

test('with SMTP_REQUIRE_TLS=0 a refused upgrade still sends, since that is what was asked for', async () => {
  const server = await fakeSmtp({starttls: true});
  try {
    assert.deepEqual(
      await sendMail({to: 'ops@example.com', subject: 's', text: 'b'}, {...config(server.port), requireTls: false}),
      {sent: true});
    assert.ok(server.state.commands.includes('STARTTLS'), 'it should try the upgrade first');
    assert.equal(server.state.auth.pass, 'hunter2', 'then fall back to the cleartext session');
    assert.match(server.state.message, /^To: ops@example\.com$/m);
  } finally { await server.close(); }
});

test('an address header encodes the display name and never the address', () => {
  const message = (from, to = 'ops@example.com') => buildMessage({from, to, subject: 's', text: 'b'});
  const header = (text, name) => text.split('\r\n\r\n')[0].split('\r\n').find(line => line.startsWith(`${name}: `));

  // RFC 2047 forbids encoding the addr-spec. The address stays literal, so the
  // server can route the message even when the name is in another script.
  const international = header(message('Café Crème <bot@example.com>'), 'From');
  assert.match(international, /<bot@example\.com>$/);
  assert.match(international, /^From: =\?UTF-8\?B\?/);
  assert.equal(
    Buffer.from(/=\?UTF-8\?B\?([^?]+)\?=/.exec(international)[1], 'base64').toString('utf8'), 'Café Crème');

  // A bare address stays bare; a quoted ASCII name loses the quotes but keeps
  // the address, and a name with a comma is quoted so it stays one entry.
  assert.equal(header(message('bot@example.com'), 'From'), 'From: bot@example.com');
  assert.equal(header(message('"Agent Control" <bot@example.com>'), 'From'), 'From: Agent Control <bot@example.com>');
  assert.equal(header(message('Agent, Control <bot@example.com>'), 'From'), 'From: "Agent, Control" <bot@example.com>');
});

test('a header value cannot inject another header, and encoded words never split a character', () => {
  const message = buildMessage({
    from: 'bot@example.com',
    to: 'ops@example.com\r\nBcc: silent@evil.example',
    subject: 'Draft waiting\r\nX-Injected: yes\nBcc: silent@evil.example',
    text: 'b',
  });
  const head = message.split('\r\n\r\n')[0];
  // The newline is flattened into the value, so the words survive as text and
  // never become a header of their own.
  assert.doesNotMatch(head, /^Bcc:/m, 'no injected Bcc line');
  assert.doesNotMatch(head, /^X-Injected:/m, 'no injected header line');
  assert.match(head, /^Subject: Draft waiting X-Injected: yes Bcc: silent@evil\.example$/m,
    'the attempted header is part of the subject text, one line');
  assert.equal(head.split('\r\n').filter(line => /^\w[\w-]*: /.test(line)).length, 10,
    'exactly the ten headers the builder writes, one line each');

  // A four-byte emoji must survive the 45-byte word split whole: the words
  // must decode back to the exact subject, and none may exceed its limit.
  const subject = 'x'.repeat(43) + '🙂' + 'y'.repeat(40);
  const encoded = /^Subject: ([\s\S]*?)\r\n(?:[A-Z][\w-]*: |\r\n)/m.exec(
    buildMessage({from: 'a@b.c', to: 'd@e.f', subject, text: 'b'}))?.[1];
  assert.ok(encoded, 'the subject header is there');
  const words = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(m => Buffer.from(m[1], 'base64'));
  assert.equal(Buffer.concat(words).toString('utf8'), subject, 'the subject decodes back to itself');
  for (const word of words) assert.ok(word.length <= 45, 'no encoded word exceeds its limit');
  assert.doesNotMatch(encoded.replace(/=\?UTF-8\?B\?[^?]+\?=|\r\n /g, ''), /[^\s]/, 'nothing outside the encoded words');
});

/** A server that answers however the test says, for the cases where the right
 * answer is "the client must give up rather than hang or leak". */
async function rawSmtp(onConnect) {
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    onConnect(socket);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  return {port, close: () => new Promise(resolve => server.close(resolve)), server};
}

const configFor = (port, extra = {}) => ({
  host: '127.0.0.1', port, secure: false, requireTls: true,
  user: 'bot@example.com', pass: 'hunter2', from: 'bot@example.com', timeoutMs: 1000, ...extra,
});
const mail = {to: 'ops@example.com', subject: 's', text: 'b'};

test('a reply that never ends fails instead of growing the buffer forever', async () => {
  const sink = await rawSmtp(socket => socket.write(`220 ${'x'.repeat(200 * 1024)}`));
  try {
    await assert.rejects(sendMail(mail, configFor(sink.port)), /too large/);
  } finally { await sink.close(); }
});

test('a server that never greets times out, and says how long it waited', async () => {
  const sink = await rawSmtp(() => {});
  try {
    await assert.rejects(sendMail(mail, configFor(sink.port, {timeoutMs: 1000})), /timed out after 1s/);
  } finally { await sink.close(); }
});

test('a server that lies about STARTTLS fails at the handshake, before any credential', async () => {
  // It advertises STARTTLS, accepts the command, then speaks plaintext at the
  // TLS client. The client must not fall back on its own: that would put the
  // password on a cleartext socket while the notification claimed to be sent.
  const seen = [];
  let lying = false;
  const sink = await rawSmtp(socket => {
    socket.write('220 test.local ESMTP\r\n');
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (lying) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        seen.push(line);
        if (/^EHLO/i.test(line)) socket.write('250-test.local\r\n250 STARTTLS\r\n');
        else if (/^STARTTLS$/i.test(line)) { lying = true; socket.write('220 go ahead\r\n'); }
      }
    });
  });
  try {
    await assert.rejects(sendMail(mail, configFor(sink.port, {timeoutMs: 3000})));
    assert.ok(seen.some(line => /^STARTTLS$/i.test(line)), 'the upgrade was attempted');
    assert.ok(!seen.some(line => /^AUTH\b/i.test(line)) && !seen.some(line => /^MAIL FROM/i.test(line)),
      'nothing past the handshake was sent, so no credential crossed the socket');
  } finally { await sink.close(); }
});

test('an echoed AUTH line cannot leak the credentials, plain or encoded', async () => {
  const user = 'x@y.zz', pass = 'S3cr3t-pass-value';
  const server = await fakeSmtp({user, pass, echoAuth: true, capabilities: ['AUTH PLAIN LOGIN']});
  try {
    // AUTH PLAIN's argument is b64("\0user\0pass"); its length is not a
    // multiple of three here, so b64(pass) alone is not a substring of it and
    // redacting the plain password left a decodable blob in the message.
    const error = await sendMail({to: 'ops@example.com', subject: 's', text: 'b'},
      {...config(server.port), user, pass}).catch(e => e);
    const b64 = value => Buffer.from(value, 'utf8').toString('base64');
    const message = String(error.message);
    for (const secret of [pass, b64(pass), b64(`\u0000${user}\u0000${pass}`)]) {
      assert.equal(message.includes(secret), false, `the error still carries ${secret}: ${message}`);
    }
    assert.match(message, /534/);
  } finally { await server.close(); }
});

test('a long capability list is read to the end, so STARTTLS is found where it is offered', async () => {
  // The reply is one line per capability. A client that truncates the joined
  // text before looking for STARTTLS reports "the server does not offer it" for
  // a server that does, and the mail is never sent.
  const long = Array.from({length: 13}, (_, i) => `250-X-EXTENSION-${String(i).padStart(2, '0')}-ABCDEFGHIJKLMNOPQRSTUVWXYZ`);
  const server = await fakeSmtp({capabilities: [...long.map(row => row.slice(4)), 'STARTTLS'], requireTls: false});
  try {
    assert.ok(long.join(' ').length > 400, 'the list has to overflow the old 400-character cut');
    const error = await sendMail({to: 'ops@example.com', subject: 's', text: 'b'}, {...config(server.port), requireTls: true}).catch(e => e);
    assert.match(String(error.message), /offered STARTTLS but refused/);
    assert.ok(server.state.commands.includes('STARTTLS'), 'the client asked for the upgrade it was offered');
  } finally { await server.close(); }
});
