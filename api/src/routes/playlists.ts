import { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../services/firebase.js';
import crypto from 'crypto';

export async function playlistRoutes(fastify: FastifyInstance) {
  fastify.post('/api/playlists', async (request: FastifyRequest<{ Body: { url: string; service: string } }>, reply) => {
    const { url, service } = request.body || {};
    if (typeof url !== 'string' || !url.trim() || !['spotify', 'apple'].includes(service)) {
      return reply.status(400).send({ error: 'Missing url or service' });
    }

    // 1. Generate a deterministic ID by hashing the clean URL (ensures idempotency)
    const cleanUrl = url.trim();
    const playlistId = crypto.createHash('sha256').update(cleanUrl).digest('hex').substring(0, 16);

    const playlistRef = db.collection('playlists').doc(playlistId);
    const doc = await playlistRef.get();

    // If it already exists and is ready/processing, don't re-trigger
    if (doc.exists) {
      return reply.status(202).send({ playlistId, status: doc.data()?.status });
    }

    // 2. Save initial processing record to Firestore
    await playlistRef.set({
      id: playlistId,
      sourceUrl: cleanUrl,
      sourceService: service,
      status: 'processing',
      progress: { completedChunks: 0, totalChunks: 0 },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30-day TTL rule
      tracks: [],
    });

    // 3. Publish initial fetch job to Upstash QStash
    const qstashToken = process.env.QSTASH_TOKEN;
    const workerBaseUrl = process.env.RENDER_EXTERNAL_URL; // e.g. https://bridetunes-api.onrender.com

    if (!qstashToken || !workerBaseUrl) {
      await playlistRef.update({ status: 'failed', error: 'Background job service is not configured' });
      return reply.status(503).send({ error: 'Playlist processing is not configured' });
    }

    try {
      const publishResponse = await fetch(`https://qstash.upstash.io/v1/publish/${workerBaseUrl}/api/jobs/fetch`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${qstashToken}`,
          'Content-Type': 'application/json',
          'Upstash-Deduplication-Id': `fetch-${playlistId}`,
        },
        body: JSON.stringify({ playlistId, cleanUrl, service }),
      });
      if (!publishResponse.ok) {
        throw new Error(`QStash rejected the job (${publishResponse.status})`);
      }
    } catch (error) {
      await playlistRef.update({ status: 'failed', error: 'Could not queue playlist processing' });
      request.log.error(error, 'Failed to enqueue playlist fetch job');
      return reply.status(502).send({ error: 'Could not queue playlist processing' });
    }

    return reply.status(202).send({ playlistId, status: 'processing' });
  });

  // GET Smart Link Playlist Data
  fastify.get('/api/playlists/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const { id } = request.params;
    const doc = await db.collection('playlists').doc(id).get();

    if (!doc.exists) {
      return reply.status(404).send({ error: 'Playlist not found' });
    }

    const data = doc.data();
    // Cache ready playlists for browser performance
    if (data?.status === 'ready') {
      reply.header('Cache-Control', 'public, max-age=60');
    }

    return reply.send(data);
  });
}
