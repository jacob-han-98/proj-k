// Tiny HTTP collector that receives Klaud main-process logs (POST /log) and
// appends each entry as one line to a file Claude can tail.
//
// Klaud's log-push.ts auto-pushes to http://localhost:8772/log when
// mcpBridgeEnabled !== false (dev default). Run this in a separate terminal
// before clicking sheets.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8772);
const OUT = process.env.OUT || path.join(process.env.TEMP || 'C:/temp', 'klaud-dev.log');

fs.writeFileSync(OUT, `=== klaud-log-collector started ${new Date().toISOString()} ===\n`);
console.log(`Writing to ${OUT}`);

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && (req.url === '/log' || req.url === '/log/')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const entry = JSON.parse(body);
        const line = `${new Date(entry.ts || Date.now()).toISOString()} [${entry.level || 'log'}] ${entry.tag ? '[' + entry.tag + '] ' : ''}${entry.message || ''}\n`;
        fs.appendFileSync(OUT, line);
      } catch (e) {
        fs.appendFileSync(OUT, `[parse-error] ${body}\n`);
      }
      res.statusCode = 204;
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`klaud-log-collector listening on http://127.0.0.1:${PORT}`);
  console.log(`tail -f ${OUT}`);
});
