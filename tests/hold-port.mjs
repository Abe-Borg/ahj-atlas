// Hold the legacy source-server port while an installed desktop app launches.
import http from 'node:http';
const server=http.createServer((_request,response)=>response.end('occupied'));
server.listen(4318,'127.0.0.1',()=>console.log('Holding 127.0.0.1:4318'));
process.on('SIGTERM',()=>server.close());
