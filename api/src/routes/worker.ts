import { FastifyInstance, FastifyRequest } from 'fastify';
import { Receiver } from '@upstash/qstash';
import { db } from '../services/firebase.js';
import { getSpotifyAppToken } from '../services/spotify.js';
import { publishQStashMessage } from '../services/qstash.js';
import { SpotifyAdapter, AppleMusicAdapter } from '@bridgetunes/adapters';

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || '',
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || '',
});

export async function workerRoutes(fastify: FastifyInstance) {
  // Middleware/Hook to verify QStash requests
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/jobs')) {
      const signature = request.headers['upstash-signature'];
      const body = (request as FastifyRequest & { rawBody?: string }).rawBody;
      const workerBaseUrl = process.env.RENDER_EXTERNAL_URL;
      if (typeof signature !== 'string' || typeof body !== 'string' || !workerBaseUrl) {
        return reply.status(401).send({ error: 'Missing QStash signature or request body' });
      }
      
      try {
        const isValid = await receiver.verify({
          signature,
          body,
          url: `${workerBaseUrl.replace(/\/$/, '')}${request.url}`,
        });
        if (!isValid) {
          return reply.status(401).send({ error: 'Invalid QStash signature' });
        }
      } catch (err) {
        return reply.status(401).send({ error: 'Signature verification failed' });
      }
    }
  });

  // Worker 1: Fetch source playlist tracks & split into chunks
  fastify.post('/api/jobs/fetch', async (request: FastifyRequest<{ Body: { playlistId: string; cleanUrl: string; service: string } }>, reply) => {
    const { playlistId, cleanUrl, service } = request.body;

    // Instantiate correct adapter based on source service
    if (!['spotify', 'apple'].includes(service)) {
      await db.collection('playlists').doc(playlistId).update({ status: 'failed', error: 'Unsupported music service' });
      return reply.status(400).send({ error: 'Unsupported music service' });
    }
    const adapter = service === 'spotify' ? new SpotifyAdapter() : new AppleMusicAdapter();
    const parsed = adapter.parseUrl(cleanUrl);

    if (!parsed) {
      await db.collection('playlists').doc(playlistId).update({ status: 'failed', error: 'Invalid playlist URL' });
      return reply.send({ success: false });
    }

    try {
      const accessToken = service === 'spotify'
        ? await getSpotifyAppToken()
        : process.env.APPLE_DEVELOPER_TOKEN || '';
      const rawTracks = await adapter.getPlaylistTracks(accessToken, parsed.playlistId);

      // Chunk tracks into groups of 25 to respect free-tier CPU/memory constraints
      const chunkSize = 25;
      const chunks: any[][] = [];
      for (let i = 0; i < rawTracks.length; i += chunkSize) {
        chunks.push(rawTracks.slice(i, i + chunkSize));
      }

      // Update total chunks in Firestore
      await db.collection('playlists').doc(playlistId).update({
        'progress.totalChunks': chunks.length,
        tracks: rawTracks.map((t, idx) => ({ ...t, position: idx, availability: {} })),
      });

      if (chunks.length === 0) {
        await db.collection('playlists').doc(playlistId).update({ status: 'failed', error: 'No tracks were found in this playlist' });
        return reply.send({ success: false, error: 'No tracks found' });
      }

      // Enqueue chunk matching jobs to QStash
      const qstashToken = process.env.QSTASH_TOKEN;
      const workerBaseUrl = process.env.RENDER_EXTERNAL_URL;
      if (!qstashToken || !workerBaseUrl) throw new Error('QStash publishing is not configured');

      for (let i = 0; i < chunks.length; i++) {
        await publishQStashMessage(
          `${workerBaseUrl}/api/jobs/match-chunk`,
          { playlistId, chunkIndex: i, tracks: chunks[i] },
          `match-${playlistId}-${i}`,
        );
      }

      return reply.send({ success: true, chunks: chunks.length });
    } catch (err: any) {
      await db.collection('playlists').doc(playlistId).update({ status: 'failed', error: err.message });
      return reply.status(500).send({ error: err.message });
    }
  });

  // Worker 2: Match chunk tracks against target platforms
  fastify.post('/api/jobs/match-chunk', async (request: FastifyRequest<{ Body: { playlistId: string; chunkIndex: number; runId?: string; tracks: any[] } }>, reply) => {
    const { playlistId, chunkIndex, runId, tracks } = request.body;

    const playlistRef = db.collection('playlists').doc(playlistId);
    const doc = await playlistRef.get();
    if (!doc.exists) return reply.send({ success: false });

    const playlistData = doc.data()!;
    if (runId && playlistData.processingRunId !== runId) return reply.send({ success: true, stale: true });
    const completedChunkIndexes: number[] = playlistData.completedChunkIndexes || [];
    if (completedChunkIndexes.includes(chunkIndex)) return reply.send({ success: true, duplicate: true });

    // Process matching for this chunk (ISRC lookup / fuzzy fallback)
    const spotifyAdapter = new SpotifyAdapter();
    const appleAdapter = new AppleMusicAdapter();
    const spotifyToken = await getSpotifyAppToken();
    const appleToken = process.env.APPLE_DEVELOPER_TOKEN || '';
    const sourceIsSpotify = playlistData.sourceService === 'spotify';

    const resolvedTracks = [] as Array<{ position: number; availability: { spotify: string | null; apple: string | null } }>;
    for (const [offset, track] of tracks.entries()) {
      const position = chunkIndex * 25 + offset;
      // Spotify-sourced tracks already carry their canonical Spotify URI; searching
      // them again can fail or return a different recording unnecessarily.
      const spotifyId = sourceIsSpotify && typeof track.id === 'string' && track.id.startsWith('spotify:track:')
        ? track.id
        : await spotifyAdapter.searchTrack(spotifyToken, track, 'US').catch(() => null);
      const appleId = appleToken ? await appleAdapter.searchTrack(appleToken, track, 'us').catch(() => null) : null;
      resolvedTracks.push({ position, availability: { spotify: spotifyId, apple: appleId } });
    }

    const result = await db.runTransaction(async (transaction) => {
      const latestDoc = await transaction.get(playlistRef);
      const latest = latestDoc.data()!;
      if (runId && latest.processingRunId !== runId) {
        return { completedChunks: latest.progress?.completedChunks || 0, stale: true };
      }
      const completedIndexes: number[] = latest.completedChunkIndexes || [];
      if (completedIndexes.includes(chunkIndex)) {
        return { completedChunks: latest.progress?.completedChunks || 0, duplicate: true };
      }
      const allTracks = latest.tracks || [];
      for (const resolved of resolvedTracks) {
        if (allTracks[resolved.position]) allTracks[resolved.position].availability = resolved.availability;
      }
      const completedChunks = (latest.progress?.completedChunks || 0) + 1;
      const totalChunks = latest.progress?.totalChunks || 1;
      transaction.update(playlistRef, {
        tracks: allTracks,
        completedChunkIndexes: [...completedIndexes, chunkIndex],
        'progress.completedChunks': completedChunks,
        status: completedChunks >= totalChunks ? 'ready' : 'processing',
      });
      return { completedChunks, duplicate: false, stale: false };
    });

    return reply.send({ success: true, ...result });
  });
}
