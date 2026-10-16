import { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { SpotifyAdapter } from '@bridgetunes/adapters';
import type { Track } from '@bridgetunes/adapters';
import { db } from '../services/firebase.js';
import { getSpotifyAppToken } from '../services/spotify.js';
import { publishQStashMessage } from '../services/qstash.js';

const chunkSize = 25;

async function queueMatchingTracks(playlistId: string, tracks: Track[]): Promise<void> {
  const qstashToken = process.env.QSTASH_TOKEN;
  const workerBaseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!qstashToken || !workerBaseUrl) throw new Error('Background job service is not configured');

  const playlistRef = db.collection('playlists').doc(playlistId);
  const chunks: Track[][] = [];
  for (let i = 0; i < tracks.length; i += chunkSize) chunks.push(tracks.slice(i, i + chunkSize));
  await playlistRef.update({
    'progress.totalChunks': chunks.length,
    tracks: tracks.map((track, position) => ({ ...track, position, availability: {} })),
  });

  for (let i = 0; i < chunks.length; i++) {
    await publishQStashMessage(
      `${workerBaseUrl}/api/jobs/match-chunk`,
      { playlistId, chunkIndex: i, tracks: chunks[i] },
      `match-${playlistId}-${i}`,
    );
  }
}

export async function playlistRoutes(fastify: FastifyInstance) {
  fastify.post('/api/playlists', async (request: FastifyRequest<{ Body: { url: string; service: string } }>, reply) => {
    const { url, service } = request.body || {};
    if (typeof url !== 'string' || !url.trim() || !['spotify', 'apple'].includes(service)) {
      return reply.status(400).send({ error: 'Missing url or service' });
    }

    const cleanUrl = url.trim();
    const playlistId = crypto.createHash('sha256').update(cleanUrl).digest('hex').substring(0, 16);
    const playlistRef = db.collection('playlists').doc(playlistId);
    const existing = await playlistRef.get();
    if (existing.exists && ['ready', 'processing'].includes(existing.data()?.status)) {
      return reply.status(202).send({ playlistId, status: existing.data()?.status });
    }

    let spotifyTracks: Track[] | undefined;
    if (service === 'spotify') {
      const adapter = new SpotifyAdapter();
      const parsed = adapter.parseUrl(cleanUrl);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Spotify playlist URL' });

      const authorization = request.headers.authorization;
      const userToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      try {
        const accessToken = userToken || await getSpotifyAppToken();
        spotifyTracks = await adapter.getPlaylistTracks(accessToken, parsed.playlistId);
      } catch (error) {
        const status = (error as Error & { status?: number }).status;
        if (!userToken && (status === 401 || status === 403 || status === 404)) {
          return reply.status(401).send({ authRequired: true });
        }
        if (userToken && status === 401) return reply.status(401).send({ authRequired: true });
        if (!userToken && (error as Error).message.includes('credentials are not configured')) {
          return reply.status(503).send({ error: 'Spotify credentials are not configured on the API.' });
        }
        request.log.error(error, 'Failed to read Spotify playlist');
        return reply.status(status === 403 ? 403 : 502).send({ error: 'Could not read this Spotify playlist.' });
      }

      if (spotifyTracks.length === 0) {
        return reply.status(422).send({ error: 'No tracks were found in this Spotify playlist.' });
      }
    }

    await playlistRef.set({
      id: playlistId,
      sourceUrl: cleanUrl,
      sourceService: service,
      status: 'processing',
      progress: { completedChunks: 0, totalChunks: 0 },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      tracks: [],
    });

    try {
      if (spotifyTracks) {
        await queueMatchingTracks(playlistId, spotifyTracks);
      } else {
        const qstashToken = process.env.QSTASH_TOKEN;
        const workerBaseUrl = process.env.RENDER_EXTERNAL_URL;
        if (!qstashToken || !workerBaseUrl) throw new Error('Background job service is not configured');
        await publishQStashMessage(
          `${workerBaseUrl}/api/jobs/fetch`,
          { playlistId, cleanUrl, service },
          `fetch-${playlistId}`,
        );
      }
    } catch (error) {
      await playlistRef.update({ status: 'failed', error: 'Could not queue playlist processing' });
      request.log.error(error, 'Failed to enqueue playlist processing');
      return reply.status(502).send({ error: 'Could not queue playlist processing' });
    }

    return reply.status(202).send({ playlistId, status: 'processing' });
  });

  fastify.get('/api/playlists/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const { id } = request.params;
    const doc = await db.collection('playlists').doc(id).get();
    if (!doc.exists) return reply.status(404).send({ error: 'Playlist not found' });
    const data = doc.data();
    if (data?.status === 'ready') reply.header('Cache-Control', 'public, max-age=60');
    return reply.send(data);
  });
}
