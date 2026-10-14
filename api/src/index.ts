import Fastify from "fastify";

const fastify = Fastify({ logger: true });

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
    const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
    await fastify.listen({ port, host: "0.0.0.0" });
    console.log(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();