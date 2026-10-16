import Fastify from "fastify";
import { playlistRoutes } from './routes/playlists.js';
import { workerRoutes } from './routes/worker.js';

const fastify = Fastify({ logger: true });
const allowedOrigins = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  ...(process.env.FRONTEND_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean),
]);

fastify.removeContentTypeParser('application/json');
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
  const rawBody = typeof body === 'string' ? body : body.toString('utf8');
  (request as typeof request & { rawBody?: string }).rawBody = rawBody;
  try {
    done(null, JSON.parse(rawBody));
  } catch (error) {
    done(error as Error, undefined);
  }
});

fastify.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Upstash-Signature');
  }
  if (request.method === 'OPTIONS') return reply.code(204).send();
});

// Root welcome endpoint
fastify.get('/', async (request, reply) => {
  return { 
    service: 'bridetunes-api', 
    status: 'online', 
    version: '1.0.0',
    timestamp: new Date().toISOString() 
  };
});

// Health check endpoint for Render
fastify.get("/health", async (request, reply) => {
  return { status: "healthy", service: "bridetunes-api" };
});

const start = async () => {
  try {
    await fastify.register(playlistRoutes);
    await fastify.register(workerRoutes);
    const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
    await fastify.listen({ port, host: "0.0.0.0" });
    console.log(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
