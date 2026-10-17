import { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { AppleMusicAdapter, SpotifyAdapter } from '@bridgetunes/adapters';
import type { Track } from '@bridgetunes/adapters';
import { db } from '../services/firebase.js';
import { getSpotifyAppToken, getSpotifyPlaylistOwnerId, getSpotifyUserId } from '../services/spotify.js';
import { publishQStashMessage } from '../services/qstash.js';

const chunkSize = 25;

function hashOwnerKey(ownerKey: string): Buffer {
  return crypto.createHash('sha256').update(ownerKey).digest();
}

function isValidOwnerKey(candidate: string | undefined, storedHash: string | undefined): boolean {
  if (!candidate || !storedHash) return false;
  const candidateHash = hashOwnerKey(candidate);
  const expectedHash = Buffer.from(storedHash, 'hex');
  return candidateHash.length === expectedHash.length && crypto.timingSafeEqual(candidateHash, expectedHash);
}

async function queueMatchingTracks(playlistId: string, tracks: Track[], runId = crypto.randomUUID()): Promise<void> {
  const qstashToken = process.env.QSTASH_TOKEN;
  const workerBaseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!qstashToken || !workerBaseUrl) throw new Error('Background job service is not configured');

  const playlistRef = db.collection('playlists').doc(playlistId);
  const chunks: Track[][] = [];
  for (let i = 0; i < tracks.length; i += chunkSize) chunks.push(tracks.slice(i, i + chunkSize));
  await playlistRef.update({
    status: 'processing',
    processingRunId: runId,
    completedChunkIndexes: [],
    'progress.completedChunks': 0,
    'progress.totalChunks': chunks.length,
    tracks: tracks.map((track, position) => ({ ...track, position, availability: {} })),
  });

  for (let i = 0; i < chunks.length; i++) {
    await publishQStashMessage(
      `${workerBaseUrl}/api/jobs/match-chunk`,
      { playlistId, chunkIndex: i, runId, tracks: chunks[i] },
      `match-${playlistId}-${runId}-${i}`,
    );
  }
}

export async function playlistRoutes(fastify: FastifyInstance) {
  fastify.get('/api/apple/developer-token', async (_request, reply) => {
    const developerToken = process.env.APPLE_DEVELOPER_TOKEN;
    if (!developerToken) return reply.status(503).send({ error: 'Apple Music is not configured on the API.' });
    reply.header('Cache-Control', 'no-store');
    return reply.send({ developerToken });
  });

  fastify.post('/api/playlists', async (request: FastifyRequest<{ Body: { url: string; service: string; expiresInDays?: number } }>, reply) => {
    const { url, service, expiresInDays = 1 } = request.body || {};
    if (typeof url !== 'string' || !url.trim() || !['spotify', 'apple'].includes(service)) {
      return reply.status(400).send({ error: 'Missing url or service' });
    }
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
      return reply.status(400).send({ error: 'Link duration must be between 1 and 30 days.' });
    }

    const cleanUrl = url.trim();
    const sourceKey = crypto.createHash('sha256').update(cleanUrl).digest('hex');
    const sourceRef = db.collection('playlistSources').doc(sourceKey);
    const mapping = await sourceRef.get();
    const legacyPlaylistId = sourceKey.substring(0, 16);
    let playlistId = mapping.data()?.playlistId || legacyPlaylistId;
    let playlistRef = db.collection('playlists').doc(playlistId);
    let existing = await playlistRef.get();
    let existingData = existing.data();
    const ownerKey = request.headers['x-playlist-owner-key'];
    if (typeof ownerKey !== 'string' || ownerKey.length !== 64 || !/^[a-f0-9]{64}$/i.test(ownerKey)) {
      return reply.status(401).send({ error: 'This browser does not have the playlist owner key. Reopen the link from the browser that created it.' });
    }
    if (existing.exists && existingData?.expiresAt && Date.parse(existingData.expiresAt) <= Date.now()) {
      playlistId = await db.runTransaction(async (transaction) => {
        const currentMapping = await transaction.get(sourceRef);
        const currentId = currentMapping.data()?.playlistId || legacyPlaylistId;
        const currentRef = db.collection('playlists').doc(currentId);
        const currentPlaylist = await transaction.get(currentRef);
        const currentExpiresAt = currentPlaylist.data()?.expiresAt;
        if (currentMapping.exists && currentId !== legacyPlaylistId && !currentPlaylist.exists) return currentId;
        if (currentPlaylist.exists && (!currentExpiresAt || Date.parse(currentExpiresAt) > Date.now())) return currentId;
        const replacementId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
        transaction.set(sourceRef, { playlistId: replacementId, sourceKey, updatedAt: new Date().toISOString() });
        return replacementId;
      });
      playlistRef = db.collection('playlists').doc(playlistId);
      existing = await playlistRef.get();
      existingData = existing.data();
    }
    if (existing.exists && existingData?.status === 'processing') {
      if (!isValidOwnerKey(ownerKey, existingData.ownerKeyHash)) {
        return reply.status(403).send({ error: 'Only the browser that created this link can replace it.' });
      }
      return reply.status(202).send({ playlistId, status: 'processing' });
    }
    if (existing.exists && existingData?.sourceService === 'spotify' && existingData?.status !== 'processing') {
      if (existingData.sourceService !== service) {
        return reply.status(409).send({ error: 'This playlist link already exists under a different source service.' });
      }
      if (service !== 'spotify') return reply.status(409).send({ error: 'This link was created from a Spotify playlist.' });

      const hasOwnerKey = isValidOwnerKey(ownerKey, existingData.ownerKeyHash);
      if (existingData.ownerKeyHash && !hasOwnerKey) {
        return reply.status(403).send({ error: 'Only the browser that created this link can replace it.' });
      }

      const authorization = request.headers.authorization;
      const userToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

      const adapter = new SpotifyAdapter();
      const parsed = adapter.parseUrl(cleanUrl);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Spotify playlist URL' });

      if (!hasOwnerKey) {
        if (!userToken) return reply.status(401).send({ authRequired: true });
        let spotifyUserId: string;
        try {
          spotifyUserId = await getSpotifyUserId(userToken);
        } catch (error) {
          const status = (error as Error & { status?: number }).status;
          if (status === 401 || status === 403) return reply.status(401).send({ authRequired: true });
          request.log.error(error, 'Failed to verify Spotify account for a legacy link');
          return reply.status(502).send({ error: 'Could not verify access to this older playlist link.' });
        }

        let ownerId: string;
        try {
          ownerId = await getSpotifyPlaylistOwnerId(userToken, parsed.playlistId);
        } catch (error) {
          const status = (error as Error & { status?: number }).status;
          if (status === 401) return reply.status(401).send({ authRequired: true });
          request.log.error(error, 'Failed to check Spotify playlist ownership for a legacy link');
          return reply.status(status === 403 ? 403 : 502).send({ error: 'Could not verify access to this older playlist link.' });
        }
        if (spotifyUserId !== ownerId) {
          return reply.status(403).send({ error: 'Only the Spotify playlist owner can replace this older BridgeTunes link.' });
        }
      }

      let updatedTracks: Track[];
      try {
        const readToken = userToken || await getSpotifyAppToken();
        updatedTracks = await adapter.getPlaylistTracks(readToken, parsed.playlistId);
      } catch (error) {
        const status = (error as Error & { status?: number }).status;
        if (status === 401 || (!userToken && (status === 403 || status === 404))) return reply.status(401).send({ authRequired: true });
        request.log.error(error, 'Failed to reread Spotify playlist');
        if (status === 403) {
          return reply.status(403).send({ error: 'Spotify denied access to this playlist. Reconnect with an account that can read it and approve private playlist access.' });
        }
        return reply.status(status === 403 ? 403 : 502).send({ error: 'Could not reread this Spotify playlist.' });
      }
      if (updatedTracks.length === 0) return reply.status(422).send({ error: 'No tracks were found in this Spotify playlist.' });

      try {
        await queueMatchingTracks(playlistId, updatedTracks);
        await playlistRef.update({
          error: null,
          ownerKeyHash: hashOwnerKey(ownerKey).toString('hex'),
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
          expiresInDays,
        });
      } catch (error) {
        await playlistRef.update({ status: 'failed', error: 'Could not queue playlist replacement' });
        request.log.error(error, 'Failed to enqueue Spotify playlist replacement');
        return reply.status(502).send({ error: 'Could not queue playlist replacement' });
      }
      return reply.status(202).send({ playlistId, status: 'processing', replaced: true });
    }
    if (existing.exists && existingData?.sourceService === 'apple' && existingData?.status !== 'processing') {
      if (existingData.ownerKeyHash && !isValidOwnerKey(ownerKey, existingData.ownerKeyHash)) {
        return reply.status(403).send({ error: 'Only the browser that created this link can replace it.' });
      }
      const adapter = new AppleMusicAdapter();
      const parsed = adapter.parseUrl(cleanUrl);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Apple Music playlist URL' });
      const developerToken = process.env.APPLE_DEVELOPER_TOKEN;
      if (!developerToken) return reply.status(503).send({ error: 'Apple Music is not configured on the API.' });

      let updatedTracks: Track[];
      try {
        updatedTracks = await adapter.getPlaylistTracks(developerToken, parsed.playlistId);
      } catch (error) {
        request.log.error(error, 'Failed to reread Apple Music playlist');
        return reply.status(502).send({ error: 'Could not reread this Apple Music playlist.' });
      }
      if (updatedTracks.length === 0) return reply.status(422).send({ error: 'No tracks were found in this Apple Music playlist.' });

      try {
        await queueMatchingTracks(playlistId, updatedTracks);
        await playlistRef.update({
          error: null,
          ownerKeyHash: hashOwnerKey(ownerKey).toString('hex'),
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
          expiresInDays,
        });
      } catch (error) {
        await playlistRef.update({ status: 'failed', error: 'Could not queue playlist replacement' });
        request.log.error(error, 'Failed to enqueue Apple Music playlist replacement');
        return reply.status(502).send({ error: 'Could not queue playlist replacement' });
      }
      return reply.status(202).send({ playlistId, status: 'processing', replaced: true });
    }
    if (existing.exists && existingData?.status === 'ready') {
      if (!isValidOwnerKey(ownerKey, existingData.ownerKeyHash)) {
        return reply.status(403).send({ error: 'Only the browser that created this link can replace it.' });
      }
      if (existingData.sourceService !== service) {
        return reply.status(409).send({ error: 'This playlist link already exists under a different source service.' });
      }
      return reply.status(202).send({ playlistId, status: 'ready' });
    }
    if (existing.exists) {
      return reply.status(409).send({ error: 'This existing playlist link cannot be replaced from the selected source.' });
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

    try {
      await playlistRef.create({
        id: playlistId,
        ownerKeyHash: hashOwnerKey(ownerKey).toString('hex'),
        sourceUrl: cleanUrl,
        sourceService: service,
        status: 'processing',
        progress: { completedChunks: 0, totalChunks: 0 },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
        expiresInDays,
        tracks: [],
      });
    } catch (error) {
      request.log.warn(error, 'Playlist link was created by another request first');
      return reply.status(409).send({ error: 'This playlist link was just created in another request. Submit it again from its creator browser to update it.' });
    }

    await sourceRef.set({ playlistId, sourceKey, updatedAt: new Date().toISOString() });

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
    reply.header('Cache-Control', 'no-store');
    if (!data) return reply.status(404).send({ error: 'Playlist not found' });
    if (data.expiresAt && Date.parse(data.expiresAt) <= Date.now()) {
      return reply.status(410).send({ error: 'This playlist link has expired.' });
    }
    const { visitCount: _visitCount, lastVisitedAt: _lastVisitedAt, ownerKeyHash: _ownerKeyHash, ...publicData } = data;
    return reply.send(publicData);
  });

  fastify.post('/api/playlists/:id/visit', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const playlistRef = db.collection('playlists').doc(request.params.id);
    const visitedAt = new Date().toISOString();
    const status = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(playlistRef);
      if (!snapshot.exists) return 'missing';
      const data = snapshot.data();
      if (data?.expiresAt && Date.parse(data.expiresAt) <= Date.now()) return 'expired';
      const visitCount = Number(snapshot.data()?.visitCount || 0);
      transaction.update(playlistRef, { visitCount: visitCount + 1, lastVisitedAt: visitedAt });
      return 'ok';
    });
    if (status === 'missing') return reply.status(404).send({ error: 'Playlist not found' });
    if (status === 'expired') return reply.status(410).send({ error: 'This playlist link has expired.' });
    return reply.status(204).send();
  });
}
