import { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'crypto';
import { AppleMusicAdapter, SpotifyAdapter, YouTubeMusicAdapter } from '@bridgetunes/adapters';
import type { Track } from '@bridgetunes/adapters';
import { db } from '../services/firebase.js';
import { getSpotifyAppToken } from '../services/spotify.js';
import { getMusicFeatureFlags } from '../services/features.js';
import { cancelPlaylistRun, publishQStashMessage } from '../services/qstash.js';
import { cacheReadyPlaylist, getCachedPlaylist, getPlaylistCacheVersion, getProgressCount, invalidatePlaylistCache, resetPlaylistProgress } from '../services/cache.js';

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

type MusicService = 'spotify' | 'apple' | 'youtube';

function defaultPlaylistName(service: MusicService, trackCount: number): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const randomLetters = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${service}-playlist-${randomLetters}${String(trackCount).padStart(4, '0')}`;
}

function matchingNoticeService(playlist: Record<string, any> | undefined): MusicService | undefined {
  if (playlist?.matchingNoticeService === 'spotify' || playlist?.matchingNoticeService === 'apple' || playlist?.matchingNoticeService === 'youtube') {
    return playlist.matchingNoticeService;
  }
  const notice = typeof playlist?.matchingNotice === 'string' ? playlist.matchingNotice : '';
  if (notice.includes('YouTube')) return 'youtube';
  if (notice.includes('Spotify')) return 'spotify';
  if (notice.includes('Apple Music')) return 'apple';
  return undefined;
}

function sourceAvailability(track: Track, sourceService: MusicService): Partial<Record<MusicService, string>> {
  if (typeof track.id !== 'string' || !track.id) return {};
  if (sourceService === 'spotify' && !track.id.startsWith('spotify:track:')) return {};
  return { [sourceService]: track.id };
}

async function queueMatchingTracks(playlistId: string, tracks: Track[], sourceService: MusicService, previousRunId?: string): Promise<void> {
  const playlistRef = db.collection('playlists').doc(playlistId);
  const runId = crypto.randomUUID();
  await Promise.all([invalidatePlaylistCache(playlistId), resetPlaylistProgress(playlistId)]);
  const chunkCount = Math.ceil(tracks.length / chunkSize);
  await playlistRef.update({
    status: 'ready',
    processingRunId: runId,
    matchingService: null,
    completedChunkIndexes: Array.from({ length: chunkCount }, (_, index) => index),
    'progress.completedChunks': chunkCount,
    'progress.totalChunks': chunkCount,
    'progress.completedTracks': tracks.length,
    'progress.totalTracks': tracks.length,
    tracks: tracks.map((track, position) => ({ ...track, position, availability: sourceAvailability(track, sourceService) })),
  });

  if (previousRunId) {
    try {
      const cancelled = await cancelPlaylistRun(playlistId, previousRunId);
      console.info(JSON.stringify({ event: 'playlist_matching_run_cancelled', playlistId, previousRunId, cancelled }));
    } catch (error) {
      // The new processingRunId already makes old deliveries stale; cancellation
      // removes queued retries when QStash is reachable.
      console.warn('Could not cancel queued messages for the previous playlist run.', error);
    }
  }

}

async function queueServiceMatching(playlistId: string, tracks: Track[], service: MusicService, force = false): Promise<void> {
  const qstashToken = process.env.QSTASH_TOKEN;
  const workerBaseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!qstashToken || !workerBaseUrl) throw new Error('Background job service is not configured');

  const runId = crypto.randomUUID();
  const playlistRef = db.collection('playlists').doc(playlistId);
  const currentPlaylist = (await playlistRef.get()).data();
  const clearMatchingNotice = matchingNoticeService(currentPlaylist) === service;
  await Promise.all([invalidatePlaylistCache(playlistId), resetPlaylistProgress(playlistId)]);
  const chunks: Track[][] = [];
  for (let i = 0; i < tracks.length; i += chunkSize) chunks.push(tracks.slice(i, i + chunkSize));
  const preparedTracks = tracks.map((track, position) => {
    const availability = { ...(track as Track & { availability?: Record<string, string | null> }).availability };
    const availabilityStatus = { ...(track as Track & { availabilityStatus?: Record<string, string> }).availabilityStatus };
    const matchAttempts = { ...(track as Track & { matchAttempts?: Record<string, number> }).matchAttempts };
    if (force || !availability[service]) {
      availability[service] = null;
      availabilityStatus[service] = 'pending';
      delete matchAttempts[service];
    } else {
      delete availabilityStatus[service];
    }
    return { ...track, position, availability, availabilityStatus, matchAttempts };
  });
  const completedTracks = preparedTracks.filter((track) =>
    Boolean(track.availability?.[service]) && track.availabilityStatus?.[service] !== 'pending',
  ).length;
  await playlistRef.update({
    status: 'processing',
    error: null,
    ...(clearMatchingNotice ? { matchingNotice: null, matchingNoticeService: null, matchingNoticeProgress: null } : {}),
    youtubeQuotaExceededRunId: null,
    processingRunId: runId,
    matchingService: service,
    completedChunkIndexes: [],
    'progress.completedChunks': 0,
    'progress.totalChunks': chunks.length,
    'progress.completedTracks': completedTracks,
    'progress.totalTracks': preparedTracks.length,
    tracks: preparedTracks,
  });

  for (let i = 0; i < chunks.length; i++) {
    await publishQStashMessage(
      `${workerBaseUrl}/api/jobs/match-chunk`,
      { playlistId, chunkIndex: i, runId, targetService: service },
      `match-${playlistId}-${runId}-${i}`,
      `match-${playlistId}-${runId}`,
    );
  }

  // A fast provider-limit response may arrive while this loop is still
  // publishing. Re-cancel after the final publish so late messages are removed;
  // the worker-side run marker also makes any already-delivered message exit.
  const latestPlaylist = (await playlistRef.get()).data();
  if (latestPlaylist?.providerLimitRunId === runId) {
    try {
      await cancelPlaylistRun(playlistId, runId);
    } catch (error) {
      console.warn('Could not cancel late messages for a provider-limited matching run.', error);
    }
  }
}

export async function playlistRoutes(fastify: FastifyInstance) {
  fastify.get('/api/features', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send(getMusicFeatureFlags());
  });

  fastify.get('/api/apple/developer-token', async (_request, reply) => {
    if (!getMusicFeatureFlags().appleMusic) return reply.status(503).send({ error: 'Apple Music is temporarily disabled.' });
    const developerToken = process.env.APPLE_DEVELOPER_TOKEN;
    if (!developerToken) return reply.status(503).send({ error: 'Apple Music is not configured on the API.' });
    reply.header('Cache-Control', 'no-store');
    return reply.send({ developerToken });
  });

  fastify.post('/api/playlists', async (request: FastifyRequest<{ Body: { url: string; service: string; expiresInHours?: number; expiresInDays?: number; playlistName?: string } }>, reply) => {
    const { url, service, playlistName: requestedPlaylistName } = request.body || {};
    const expiresInHours = request.body?.expiresInHours
      ?? (request.body?.expiresInDays !== undefined ? request.body.expiresInDays * 24 : 24);
    if (requestedPlaylistName !== undefined && (typeof requestedPlaylistName !== 'string' || requestedPlaylistName.trim().length > 100)) {
      return reply.status(400).send({ error: 'Playlist name must be 100 characters or fewer.' });
    }
    const nameOverride = typeof requestedPlaylistName === 'string' ? requestedPlaylistName.trim() : '';
    if (typeof url !== 'string' || !url.trim() || !['spotify', 'apple', 'youtube'].includes(service)) {
      return reply.status(400).send({ error: 'Missing url or service' });
    }
    const features = getMusicFeatureFlags();
    if (service === 'spotify' && !features.spotify) return reply.status(503).send({ error: 'Spotify is temporarily disabled.' });
    if (service === 'apple' && !features.appleMusic) return reply.status(503).send({ error: 'Apple Music is temporarily disabled.' });
    if (service === 'youtube' && !features.youtubeMusic) return reply.status(503).send({ error: 'YouTube Music is temporarily disabled.' });
    if (service === 'youtube' && !process.env.YOUTUBE_API_KEY) return reply.status(503).send({ error: 'YouTube is not configured on the API.' });
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) {
      return reply.status(400).send({ error: 'Link duration must be between 1 and 720 hours.' });
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
    if (existing.exists && existingData?.sourceService === 'spotify') {
      if (existingData.sourceService !== service) {
        return reply.status(409).send({ error: 'This playlist link already exists under a different source service.' });
      }
      if (service !== 'spotify') return reply.status(409).send({ error: 'This link was created from a Spotify playlist.' });

      const authorization = request.headers.authorization;
      const userToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;

      const adapter = new SpotifyAdapter();
      const parsed = adapter.parseUrl(cleanUrl);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Spotify playlist URL' });

      let updatedTracks: Track[];
      let updatedPlaylistName = nameOverride || existingData.name || 'Your playlist';
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
        await queueMatchingTracks(
          playlistId,
          updatedTracks,
          'spotify',
          existingData.status === 'processing' ? existingData.processingRunId : undefined,
        );
        await playlistRef.update({
          error: null,
          name: updatedPlaylistName,
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
          expiresInHours,
        });
      } catch (error) {
        await playlistRef.update({ status: 'failed', error: 'Could not queue playlist replacement' });
        request.log.error(error, 'Failed to enqueue Spotify playlist replacement');
        return reply.status(502).send({ error: 'Could not queue playlist replacement' });
      }
      return reply.status(202).send({ playlistId, status: 'ready', replaced: true });
    }
    if (existing.exists && existingData?.sourceService === 'apple') {
      const adapter = new AppleMusicAdapter();
      const parsed = adapter.parseUrl(cleanUrl);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Apple Music playlist URL' });
      const developerToken = process.env.APPLE_DEVELOPER_TOKEN;
      if (!developerToken) return reply.status(503).send({ error: 'Apple Music is not configured on the API.' });

      let updatedTracks: Track[];
      let updatedPlaylistName = nameOverride || existingData.name || 'Your playlist';
      try {
        updatedTracks = await adapter.getPlaylistTracks(developerToken, parsed.playlistId);
      } catch (error) {
        request.log.error(error, 'Failed to reread Apple Music playlist');
        return reply.status(502).send({ error: 'Could not reread this Apple Music playlist.' });
      }
      if (updatedTracks.length === 0) return reply.status(422).send({ error: 'No tracks were found in this Apple Music playlist.' });

      try {
        await queueMatchingTracks(
          playlistId,
          updatedTracks,
          'apple',
          existingData.status === 'processing' ? existingData.processingRunId : undefined,
        );
        await playlistRef.update({
          error: null,
          name: updatedPlaylistName,
          updatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
          expiresInHours,
        });
      } catch (error) {
        await playlistRef.update({ status: 'failed', error: 'Could not queue playlist replacement' });
        request.log.error(error, 'Failed to enqueue Apple Music playlist replacement');
        return reply.status(502).send({ error: 'Could not queue playlist replacement' });
      }
      return reply.status(202).send({ playlistId, status: 'ready', replaced: true });
    }
    if (existing.exists && existingData?.sourceService === 'youtube') {
      if (service !== 'youtube') return reply.status(409).send({ error: 'This playlist link was created from a YouTube Music playlist.' });
      if (existingData.ownerKeyHash && !isValidOwnerKey(ownerKey, existingData.ownerKeyHash)) return reply.status(403).send({ error: 'Only the browser that created this link can replace it.' });
      const adapter = new YouTubeMusicAdapter();
      const parsed = adapter.parseUrl(cleanUrl);
      if (!parsed) return reply.status(400).send({ error: 'Invalid YouTube Music playlist URL' });
      try {
        const updatedTracks = await adapter.getPlaylistTracks('', parsed.playlistId);
        if (!updatedTracks.length) return reply.status(422).send({ error: 'No public tracks were found in this YouTube playlist.' });
        const name = nameOverride || existingData.name || defaultPlaylistName('youtube', updatedTracks.length);
        await queueMatchingTracks(playlistId, updatedTracks, 'youtube', existingData.status === 'processing' ? existingData.processingRunId : undefined);
        await playlistRef.update({ error: null, name, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(), expiresInHours });
        return reply.status(202).send({ playlistId, status: 'ready', replaced: true });
      } catch (error) {
        request.log.error(error, 'Failed to reread YouTube playlist');
        return reply.status(502).send({ error: 'Could not reread this YouTube playlist. Check that it is public or unlisted.' });
      }
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
    let appleTracks: Track[] | undefined;
    let youtubeTracks: Track[] | undefined;
    const playlistName = nameOverride;
    if (service === 'spotify') {
      const adapter = new SpotifyAdapter();
      const parsed = adapter.parseUrl(cleanUrl);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Spotify playlist URL' });

      const authorization = request.headers.authorization;
      const userToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      let spotifyAccessToken: string;
      try {
        spotifyAccessToken = userToken || await getSpotifyAppToken();
        spotifyTracks = await adapter.getPlaylistTracks(spotifyAccessToken, parsed.playlistId);
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

    if (service === 'apple') {
      const adapter = new AppleMusicAdapter();
      const parsed = adapter.parseUrl(cleanUrl);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Apple Music playlist URL' });
      if (!process.env.APPLE_DEVELOPER_TOKEN) {
        return reply.status(503).send({ error: 'Apple Music is not configured on the API.' });
      }
      try {
        appleTracks = await adapter.getPlaylistTracks(process.env.APPLE_DEVELOPER_TOKEN, parsed.playlistId);
      } catch (error) {
        request.log.error(error, 'Failed to read Apple Music playlist');
        return reply.status(502).send({ error: 'Could not read this Apple Music playlist.' });
      }
      if (appleTracks.length === 0) {
        return reply.status(422).send({ error: 'No tracks were found in this Apple Music playlist.' });
      }
    }

    if (service === 'youtube') {
      const adapter = new YouTubeMusicAdapter();
      const parsed = adapter.parseUrl(cleanUrl);
      if (!parsed) return reply.status(400).send({ error: 'Invalid YouTube Music playlist URL' });
      try {
        youtubeTracks = await adapter.getPlaylistTracks('', parsed.playlistId);
      } catch (error) {
        request.log.error(error, 'Failed to read YouTube playlist');
        const status = (error as Error & { status?: number }).status;
        return reply.status(status === 403 || status === 404 ? 422 : 502).send({ error: 'Could not read this YouTube playlist. It must be public or unlisted.' });
      }
      if (!youtubeTracks.length) return reply.status(422).send({ error: 'No public tracks were found in this YouTube playlist.' });
    }

    try {
      await playlistRef.create({
        id: playlistId,
        ownerKeyHash: hashOwnerKey(ownerKey).toString('hex'),
        sourceUrl: cleanUrl,
        sourceService: service,
        name: playlistName || defaultPlaylistName(service as MusicService, spotifyTracks?.length ?? appleTracks?.length ?? youtubeTracks?.length ?? 0),
        status: 'processing',
        progress: { completedChunks: 0, totalChunks: 0 },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
        expiresInHours,
        tracks: [],
      });
    } catch (error) {
      request.log.warn(error, 'Playlist link was created by another request first');
      return reply.status(409).send({ error: 'This playlist link was just created in another request. Submit it again from its creator browser to update it.' });
    }

    await sourceRef.set({ playlistId, sourceKey, updatedAt: new Date().toISOString() });

    try {
      const sourceTracks = spotifyTracks || appleTracks || youtubeTracks;
      if (!sourceTracks) throw new Error('Playlist tracks were not loaded');
      await queueMatchingTracks(playlistId, sourceTracks, service as MusicService);
    } catch (error) {
      await playlistRef.update({ status: 'failed', error: 'Could not queue playlist processing' });
      request.log.error(error, 'Failed to enqueue playlist processing');
      return reply.status(502).send({ error: 'Could not queue playlist processing' });
    }

    return reply.status(202).send({ playlistId, status: 'ready' });
  });

  fastify.get('/api/playlists/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const { id } = request.params;
    let data = await getCachedPlaylist(id) as Record<string, any> | null;
    const servedFromCache = Boolean(data);
    const cacheVersion = servedFromCache ? -1 : getPlaylistCacheVersion(id);
    if (!data) {
      const doc = await db.collection('playlists').doc(id).get();
      if (!doc.exists) return reply.status(404).send({ error: 'Playlist not found' });
      data = doc.data() || null;
    }
    if (!data) return reply.status(404).send({ error: 'Playlist not found' });
    if (data.expiresAt && Date.parse(data.expiresAt) <= Date.now()) {
      await invalidatePlaylistCache(id);
      return reply.status(410).send({ error: 'This playlist link has expired.' });
    }
    const isReady = data.status === 'ready';
    reply.header('Cache-Control', isReady ? 'public, max-age=60' : 'no-store');
    if (isReady && !servedFromCache) {
      await cacheReadyPlaylist(id, data, cacheVersion);
    } else if (data.status === 'processing') {
      const completedChunks = await getProgressCount(id);
      if (completedChunks !== null) {
        data = { ...data, progress: { ...data.progress, completedChunks: Math.max(Number(data.progress?.completedChunks || 0), completedChunks) } };
      }
    }
    const { visitCount: _visitCount, lastVisitedAt: _lastVisitedAt, ownerKeyHash: _ownerKeyHash, ...publicData } = data;
    return reply.send(publicData);
  });

  fastify.post('/api/playlists/:id/match', async (request: FastifyRequest<{ Params: { id: string }; Body: { service: MusicService } }>, reply) => {
    const { service } = request.body || {};
    if (!['spotify', 'apple', 'youtube'].includes(service)) return reply.status(400).send({ error: 'Unsupported destination service.' });
    const features = getMusicFeatureFlags();
    if ((service === 'spotify' && !features.spotify) || (service === 'apple' && !features.appleMusic) || (service === 'youtube' && !features.youtubeMusic)) {
      return reply.status(503).send({ error: `${service === 'spotify' ? 'Spotify' : service === 'apple' ? 'Apple Music' : 'YouTube Music'} is temporarily disabled.` });
    }
    if (service === 'youtube' && !process.env.YOUTUBE_API_KEY) return reply.status(503).send({ error: 'YouTube is not configured on the API.' });
    if (service === 'apple' && !process.env.APPLE_DEVELOPER_TOKEN) return reply.status(503).send({ error: 'Apple Music is not configured on the API.' });

    const playlistRef = db.collection('playlists').doc(request.params.id);
    const snapshot = await playlistRef.get();
    if (!snapshot.exists) return reply.status(404).send({ error: 'Playlist not found' });
    const playlist = snapshot.data()!;
    const ownerKey = request.headers['x-playlist-owner-key'];
    if (!isValidOwnerKey(typeof ownerKey === 'string' ? ownerKey : undefined, playlist.ownerKeyHash)) {
      return reply.status(403).send({ error: 'Only the browser that created this playlist can search for matches.' });
    }
    if (playlist.expiresAt && Date.parse(playlist.expiresAt) <= Date.now()) return reply.status(410).send({ error: 'This playlist link has expired.' });
    if (playlist.status === 'processing') return reply.status(409).send({ error: `Matching is already in progress${playlist.matchingService ? ` for ${playlist.matchingService}` : ''}.` });
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks as Track[] : [];
    if (!tracks.length) return reply.status(422).send({ error: 'There are no saved tracks to match.' });

    const missingTracks = tracks.filter((track) => {
      const savedMatch = (track as Track & { availability?: Record<string, string | null> }).availability?.[service];
      return !savedMatch && !sourceAvailability(track, playlist.sourceService as MusicService)[service];
    });
    if (!missingTracks.length) return reply.send({ playlistId: request.params.id, status: 'ready', matchedTracks: tracks.length });

    try {
      await queueServiceMatching(request.params.id, tracks, service);
      return reply.status(202).send({ playlistId: request.params.id, status: 'processing', service });
    } catch (error) {
      const current = await playlistRef.get();
      if (current.data()?.status === 'processing' && current.data()?.matchingService === service) {
        await playlistRef.update({ status: 'failed', matchingService: null, error: `Could not queue ${service} matching` });
      }
      request.log.error(error, `Failed to queue ${service} matching`);
      return reply.status(502).send({ error: `Could not queue ${service} matching.` });
    }
  });

  fastify.post('/api/playlists/:id/rematch/apple', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!getMusicFeatureFlags().appleMusic) return reply.status(503).send({ error: 'Apple Music is temporarily disabled.' });
    const playlistRef = db.collection('playlists').doc(request.params.id);
    const snapshot = await playlistRef.get();
    if (!snapshot.exists) return reply.status(404).send({ error: 'Playlist not found' });

    const playlist = snapshot.data()!;
    const ownerKey = request.headers['x-playlist-owner-key'];
    if (!isValidOwnerKey(typeof ownerKey === 'string' ? ownerKey : undefined, playlist.ownerKeyHash)) {
      return reply.status(403).send({ error: 'Only the browser that created this link can refresh its matches.' });
    }
    if (playlist.expiresAt && Date.parse(playlist.expiresAt) <= Date.now()) {
      return reply.status(410).send({ error: 'This playlist link has expired.' });
    }
    if (playlist.status === 'processing') return reply.status(409).send({ error: 'Playlist matching is already in progress.' });
    if (!process.env.APPLE_DEVELOPER_TOKEN) return reply.status(503).send({ error: 'Apple Music is not configured on the API.' });

    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks as Track[] : [];
    if (tracks.length === 0) return reply.status(422).send({ error: 'There are no saved tracks to match.' });

    try {
      await queueServiceMatching(request.params.id, tracks, 'apple', true);
      return reply.status(202).send({ playlistId: request.params.id, status: 'processing' });
    } catch (error) {
      await playlistRef.update({ status: 'failed', error: 'Could not queue Apple Music matching' });
      request.log.error(error, 'Failed to queue Apple Music rematching');
      return reply.status(502).send({ error: 'Could not queue Apple Music matching.' });
    }
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
