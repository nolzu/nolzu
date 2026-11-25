import { createServer } from 'node:http';
import { listRecipes } from './recipes/list.ts';

const port = 8787;

const server = createServer((request, response) => {
  if (request.url === '/recipes') {
    // The web page runs from a file, so it reaches this server from another origin.
    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    response.end(JSON.stringify(listRecipes()));
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end(`No route for ${request.url ?? '/'}`);
});

server.listen(port, () => {
  console.log(`The recipe api is on http://localhost:${port}/recipes`);
});
