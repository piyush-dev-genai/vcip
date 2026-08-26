import { createHealthServer } from './health.js';

const port = Number(process.env.EGRESS_PORT ?? 3003);
const server = createHealthServer();

server.listen(port);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
