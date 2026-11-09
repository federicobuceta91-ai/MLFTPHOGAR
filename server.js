const http = require('http');
const port = process.env.PORT || 3000;
const host = '0.0.0.0';

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ML con More - en construcción. Ruta: ' + req.url);
}).listen(port, host, () => {
  console.log(`Server corriendo en ${host}:${port}`);
});
