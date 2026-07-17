/*
 * Copyright 2026 Notessensei
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const express = require('express');
const http = require('http');
const net = require('net');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Methods Node's HTTP parser (llhttp) accepts. Anything else gets killed at
// the socket level before Express ever sees it — hence the shim below.
const KNOWN_METHODS = new Set(http.METHODS);

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/submit', (req, res) => {
  // The method as it actually crossed the wire: either Node parsed it
  // natively, or the shim stashed the fictitious one in a header.
  const method = req.get('x-httpfun-method') || req.method;

  const raw = req.body?.message ?? req.query.message;
  const message = typeof raw === 'string' ? raw.trim() : '';
  if (!message) {
    return res.status(400).json({ error: '"message" is required.' });
  }

  res.json({ method, message, receivedAt: new Date().toISOString() });
});

// Express listens privately; the public port is a raw TCP shim that lets
// fictitious HTTP methods through. It rewrites the request line to POST and
// carries the original method in X-Httpfun-Method, so "both ends understand"
// even though llhttp would reject the method outright. It also forces
// Connection: close so each socket carries exactly one request and the
// first-line rewrite is all that's ever needed.
const internal = http.createServer(app);

internal.listen(0, '127.0.0.1', () => {
  const internalPort = internal.address().port;

  const shim = net.createServer((client) => {
    const upstream = net.connect(internalPort, '127.0.0.1');
    let head = Buffer.alloc(0);
    let rewritten = false;

    client.on('data', (chunk) => {
      if (rewritten) return upstream.write(chunk);

      head = Buffer.concat([head, chunk]);
      const eol = head.indexOf('\r\n');
      if (eol === -1) {
        if (head.length > 8192) client.destroy();
        return;
      }
      rewritten = true;

      const line = head.subarray(0, eol).toString('latin1');
      const rest = head.subarray(eol + 2);
      const space = line.indexOf(' ');
      const method = space === -1 ? '' : line.slice(0, space);

      const injected = ['Connection: close'];
      let requestLine = line;
      if (method && !KNOWN_METHODS.has(method)) {
        requestLine = 'POST' + line.slice(space);
        injected.push(`X-Httpfun-Method: ${method}`);
      }

      upstream.write(Buffer.concat([
        Buffer.from(`${requestLine}\r\n${injected.join('\r\n')}\r\n`, 'latin1'),
        rest
      ]));
    });

    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });

  shim.listen(PORT, () => {
    console.log(`httpfun listening on http://localhost:${PORT} (express on 127.0.0.1:${internalPort} behind the method shim)`);
  });
});
