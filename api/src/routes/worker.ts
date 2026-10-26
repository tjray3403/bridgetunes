import { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { DocumentReference } from 'firebase-admin/firestore';
import { Receiver } from '@upstash/qstash';
import { db } from '../services/firebase.js';
import { getSpotifyAppToken } from '../services/spotify.js';
import { getMusicFeatureFlags } from '../services/features.js';
import {
  cacheTrackMatches,
  cacheKeyForTrack,
  cacheIdForTrack,
  getMemoryTrackMatches,
  getRedisTrackMatches,
  markChunkComplete,
  normalizeIsrc,
  rememberTrackMatches,
  type TrackMatch,
  type TrackMatchRecord,
} from '../services/cache.js';
import { SpotifyAdapter, AppleMusicAdapter, YouTubeMusicAdapter } from '@bridgetunes/adapters';
import { cancelPlaylistRun } from '../services/qstash.js';

const MAX_PROVIDER_ATTEMPTS = 5;

async function isCurrentProcessingRun(playlistRef: DocumentReference, runId: string): Promise<boolean> {
  const snapshot = await playlistRef.get();
  const playlist = snapshot.data();
  return snapshot.exists
    && playlist?.processingRunId === runId
    && playlist?.status === 'processing'
    && playlist?.providerLimitRunId !== runId;
}

const receiver = new Receiver({
  currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || '',
  nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || '',
});

export async function workerRoutes(fastify: FastifyInstance) {
  // Middleware/Hook to verify QStash requests
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/api/jobs')) {
      if (process.env.LOCAL_LOAD_TEST === 'true' && process.env.NODE_ENV !== 'production') return;
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
    if (!['spotify', 'apple', 'youtube'].includes(service)) {
      await db.collection('playlists').doc(playlistId).update({ status: 'failed', error: 'Unsupported music service' });
      return reply.status(400).send({ error: 'Unsupported music service' });
    }
    const features = getMusicFeatureFlags();
    if ((service === 'spotify' && !features.spotify) || (service === 'apple' && !features.appleMusic) || (service === 'youtube' && !features.youtubeMusic)) {
      await db.collection('playlists').doc(playlistId).update({ status: 'failed', error: `${service === 'spotify' ? 'Spotify' : service === 'apple' ? 'Apple Music' : 'YouTube Music'} is temporarily disabled.` });
      return reply.send({ success: false, disabled: true });
    }
    const adapter = service === 'spotify' ? new SpotifyAdapter() : service === 'apple' ? new AppleMusicAdapter() : new YouTubeMusicAdapter();
    const parsed = adapter.parseUrl(cleanUrl);

    if (!parsed) {
      await db.collection('playlists').doc(playlistId).update({ status: 'failed', error: 'Invalid playlist URL' });
      return reply.send({ success: false });
    }

    try {
      const accessToken = service === 'spotify' ? await getSpotifyAppToken() : process.env.APPLE_DEVELOPER_TOKEN || '';
      const rawTracks = await adapter.getPlaylistTracks(accessToken, parsed.playlistId);

      // Chunk tracks into groups of 25 to respect free-tier CPU/memory constraints
      const chunkSize = 25;
      const chunkCount = Math.ceil(rawTracks.length / chunkSize);
      const runId = crypto.randomUUID();
      const savedPlaylist = await db.collection('playlists').doc(playlistId).get();
      const playlistName = savedPlaylist.data()?.name || 'Your playlist';

      // A source read completes with its source IDs already available. Search
      // other services only after the user asks to transfer to one.
      await db.collection('playlists').doc(playlistId).update({
        name: playlistName,
        status: 'ready',
        matchingService: null,
        completedChunkIndexes: Array.from({ length: chunkCount }, (_, index) => index),
        'progress.completedChunks': chunkCount,
        'progress.totalChunks': chunkCount,
        'progress.completedTracks': rawTracks.length,
        'progress.totalTracks': rawTracks.length,
        processingRunId: runId,
        tracks: rawTracks.map((t, idx) => ({
          ...t,
          position: idx,
          availability: typeof t.id === 'string' && t.id
            ? { [service]: t.id }
            : {},
        })),
      });

      if (chunkCount === 0) {
        await db.collection('playlists').doc(playlistId).update({ status: 'failed', error: 'No tracks were found in this playlist' });
        return reply.send({ success: false, error: 'No tracks found' });
      }

      return reply.send({ success: true, chunks: chunkCount });
    } catch (err: any) {
      await db.collection('playlists').doc(playlistId).update({ status: 'failed', error: err.message });
      return reply.status(500).send({ error: err.message });
    }
  });

  // Worker 2: Match chunk tracks against target platforms
  fastify.post('/api/jobs/match-chunk', async (request: FastifyRequest<{ Body: { playlistId: string; chunkIndex: number; runId: string; targetService?: 'apple' | 'spotify' | 'youtube'; tracks?: any[] } }>, reply) => {
    const { playlistId, chunkIndex, runId, targetService } = request.body;

    const playlistRef = db.collection('playlists').doc(playlistId);
    const doc = await playlistRef.get();
    if (!doc.exists) return reply.send({ success: false });

    const playlistData = doc.data()!;
    if (!runId || playlistData.processingRunId !== runId) return reply.send({ success: true, stale: true });
    const completedChunkIndexes: number[] = playlistData.completedChunkIndexes || [];
    if (completedChunkIndexes.includes(chunkIndex)) return reply.send({ success: true, duplicate: true });

    const savedTracks: any[] = Array.isArray(playlistData.tracks) ? playlistData.tracks : [];
    const tracks = savedTracks.slice(chunkIndex * 25, chunkIndex * 25 + 25);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || tracks.length === 0) {
      return reply.status(400).send({ error: 'No saved tracks exist for this matching chunk.' });
    }

    // Load the whole chunk's hot match cache with one Redis MGET. Firestore remains
    // the durable cache and is consulted only for ISRCs Redis did not have.
    const features = getMusicFeatureFlags();
    const spotifyEnabledForRun = features.spotify && targetService !== 'apple' && targetService !== 'youtube';
    const appleEnabledForRun = features.appleMusic && targetService !== 'spotify' && targetService !== 'youtube';
    const youtubeEnabledForRun = features.youtubeMusic && targetService !== 'spotify' && targetService !== 'apple';
    const spotifyAdapter = new SpotifyAdapter();
    const appleAdapter = new AppleMusicAdapter();
    const youtubeAdapter = new YouTubeMusicAdapter();
    let spotifyToken = '';
    let spotifyTokenError: Error | undefined;
    if (spotifyEnabledForRun) {
      try {
        spotifyToken = await getSpotifyAppToken();
      } catch (error) {
        spotifyTokenError = error instanceof Error ? error : new Error('Spotify authentication failed.');
      }
    }
    const appleToken = appleEnabledForRun ? process.env.APPLE_DEVELOPER_TOKEN || '' : '';
    const sourceIsSpotify = playlistData.sourceService === 'spotify';

    const cacheIds = [...new Set(tracks.map(cacheIdForTrack).filter((cacheId): cacheId is string => Boolean(cacheId)))];
    const matchRecords = new Map<string, TrackMatchRecord>();
    const redisMisses: string[] = [];
    for (const cacheId of cacheIds) {
      const cached = getMemoryTrackMatches(cacheId);
      if (cached) matchRecords.set(cacheId, cached);
      else redisMisses.push(cacheId);
    }
    if (redisMisses.length) {
      const redisRecords = await getRedisTrackMatches(redisMisses);
      for (const [cacheId, record] of redisRecords) matchRecords.set(cacheId, record);
    }

    const firestoreMisses = cacheIds.filter((cacheId) => !matchRecords.has(cacheId));
    if (firestoreMisses.length) {
      const snapshots = await db.getAll(...firestoreMisses.map((cacheId) => db.collection('tracks').doc(cacheId)));
      const foundFromFirestore = new Map<string, TrackMatchRecord>();
      snapshots.forEach((snapshot, index) => {
        if (!snapshot.exists) return;
        const data = snapshot.data() as { matches?: Record<string, TrackMatch> } | undefined;
        if (data?.matches) {
          const record = { matches: data.matches };
          const cacheId = firestoreMisses[index];
          matchRecords.set(cacheId, record);
          foundFromFirestore.set(cacheId, record);
          rememberTrackMatches(cacheId, record);
        }
      });
      await cacheTrackMatches(foundFromFirestore);
    }

    const changedRecords = new Map<string, TrackMatchRecord>();
    const providerFailures = new Map<string, { status?: number; retryAfter?: string }>();
    let providerLimitReached = false;
    let providerLimitService: 'spotify' | 'apple' | 'youtube' | null = null;
    let providerRateLimited = false;
    const trackWrites = db.batch();
    const resolvedTracks = [] as Array<{
      position: number;
      availability: Partial<{ spotify: string | null; apple: string | null; youtube: string | null }>;
      availabilityStatus: Partial<{ spotify: 'pending' | 'temporarily_unavailable'; apple: 'pending' | 'temporarily_unavailable'; youtube: 'pending' | 'temporarily_unavailable' }>;
      matchAttempts: Partial<{ spotify: number; apple: number; youtube: number }>;
    }>;
    const providerOrder = (['spotify', 'apple', 'youtube'] as const)
      .filter((service) => !targetService || service === targetService)
      .sort((left, right) => (left === playlistData.sourceService ? -1 : right === playlistData.sourceService ? 1 : 0));
    for (const [offset, track] of tracks.entries()) {
      if (!(await isCurrentProcessingRun(playlistRef, runId))) {
        return reply.send({ success: true, stale: true });
      }
      const position = chunkIndex * 25 + offset;
      const isrc = normalizeIsrc(track.isrc);
      const cacheId = cacheIdForTrack(track);
      const record = cacheId ? (matchRecords.get(cacheId) || { matches: {} }) : undefined;
      const availability: Partial<{ spotify: string | null; apple: string | null; youtube: string | null }> = {};
      const availabilityStatus: Partial<{ spotify: 'pending' | 'temporarily_unavailable'; apple: 'pending' | 'temporarily_unavailable'; youtube: 'pending' | 'temporarily_unavailable' }> = {};
      const matchAttempts: Partial<{ spotify: number; apple: number; youtube: number }> = {};
      const alreadyResolved = (service: 'spotify' | 'apple' | 'youtube') =>
        track.availability?.[service] !== undefined && track.availabilityStatus?.[service] !== 'pending';
      let recordChanged = false;

      const findCached = (service: 'spotify' | 'apple' | 'youtube'): TrackMatch | undefined => {
        const cacheField = cacheKeyForTrack(track, service, 'us');
        return cacheField ? record?.matches[cacheField] : undefined;
      };
      const isReusable = (match: TrackMatch | undefined): boolean => Boolean(
        match && (match.id || (match.recheckAt && Date.parse(match.recheckAt) > Date.now())),
      );
      const saveMatch = (service: 'spotify' | 'apple' | 'youtube', id: string | null) => {
        const cacheField = cacheKeyForTrack(track, service, 'us');
        if (!record || !cacheField) return;
        record.matches[cacheField] = id
          ? { id, checkedAt: new Date().toISOString() }
          : { id: null, checkedAt: new Date().toISOString(), recheckAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() };
        recordChanged = true;
      };

      for (const service of providerOrder) {
      const attemptsSoFar = Number(track.matchAttempts?.[service] || 0);
      if (service === 'spotify' && spotifyEnabledForRun && !providerLimitReached && !alreadyResolved('spotify')) {
        if (sourceIsSpotify && typeof track.id === 'string' && track.id.startsWith('spotify:track:')) {
          availability.spotify = track.id;
          saveMatch('spotify', track.id);
        } else {
          const cached = findCached('spotify');
          if (isReusable(cached)) availability.spotify = cached!.id;
          else {
            try {
              if (!spotifyToken) throw spotifyTokenError || new Error('Spotify is not configured on the API.');
              availability.spotify = await spotifyAdapter.searchTrack(spotifyToken, track, 'US');
              saveMatch('spotify', availability.spotify);
            } catch (error) {
              const providerError = error as Error & { status?: number; retryAfter?: string };
              const status = providerError.status;
              request.log.error({ err: error, position, hasIsrc: Boolean(isrc) }, 'Spotify catalog matching failed for a saved track');
              if (status === 429 || status === 403) {
                providerLimitReached = true;
                providerLimitService = 'spotify';
                providerRateLimited = status === 429;
                availability.spotify = null;
                availabilityStatus.spotify = 'temporarily_unavailable';
                break;
              }
              const attempts = attemptsSoFar + 1;
              matchAttempts.spotify = attempts;
              if (attempts >= MAX_PROVIDER_ATTEMPTS) {
                availability.spotify = null;
                availabilityStatus.spotify = 'temporarily_unavailable';
              } else providerFailures.set('spotify', { status, retryAfter: providerError.retryAfter });
            }
          }
        }
      }

      if (service === 'apple' && appleEnabledForRun && !providerLimitReached && !alreadyResolved('apple')) {
        if (!(await isCurrentProcessingRun(playlistRef, runId))) {
          return reply.send({ success: true, stale: true });
        }
        if (playlistData.sourceService === 'apple' && typeof track.id === 'string') {
          availability.apple = track.id;
          saveMatch('apple', track.id);
        } else {
          const cached = findCached('apple');
          if (isReusable(cached)) availability.apple = cached!.id;
          else {
            try {
              if (!appleToken) throw new Error('Apple Music is not configured on the API.');
              availability.apple = await appleAdapter.searchTrack(appleToken, track, 'us');
              saveMatch('apple', availability.apple);
            } catch (error) {
              const providerError = error as Error & { status?: number; retryAfter?: string };
              const status = providerError.status;
              request.log.error({ err: error, position, hasIsrc: Boolean(isrc) }, 'Apple Music catalog matching failed for a saved track');
              if (status ===  429) {
                providerLimitReached = true;
                providerLimitService = 'apple';
                providerRateLimited = true;
                availability.apple = null;
                availabilityStatus.apple = 'temporarily_unavailable';
                break;
              }
              const attempts = attemptsSoFar + 1;
              matchAttempts.apple = attempts;
              if (attempts >= MAX_PROVIDER_ATTEMPTS) {
                availability.apple = null;
                availabilityStatus.apple = 'temporarily_unavailable';
              } else providerFailures.set('apple', { status, retryAfter: providerError.retryAfter });
            }
          }
        }
      }

      if (service === 'youtube' && youtubeEnabledForRun && !providerLimitReached && !alreadyResolved('youtube')) {
        if (!(await isCurrentProcessingRun(playlistRef, runId))) return reply.send({ success: true, stale: true });
        if (playlistData.sourceService === 'youtube' && typeof track.id === 'string') {
          availability.youtube = track.id;
          saveMatch('youtube', track.id);
        } else {
          const cached = findCached('youtube');
          if (isReusable(cached)) availability.youtube = cached!.id;
          else {
            try {
              availability.youtube = await youtubeAdapter.searchTrack('', track, 'US');
              saveMatch('youtube', availability.youtube);
            } catch (error) {
              const providerError = error as Error & { status?: number; retryAfter?: string; reason?: string };
              const status = providerError.status;
              request.log.error({ err: error, position, hasIsrc: Boolean(isrc) }, 'YouTube matching failed for a saved track');
              if (status === 429 || status === 403) {
                providerLimitReached = true;
                providerLimitService = 'youtube';
                providerRateLimited = status === 429;
                availability.youtube = null;
                availabilityStatus.youtube = 'temporarily_unavailable';
                break;
              }
              const attempts = attemptsSoFar + 1;
              matchAttempts.youtube = attempts;
              if (attempts >= MAX_PROVIDER_ATTEMPTS) {
                availability.youtube = null;
                availabilityStatus.youtube = 'temporarily_unavailable';
              } else providerFailures.set('youtube', { status, retryAfter: providerError.retryAfter });
            }
          }
        }
      }
      }

      if (cacheId && recordChanged && record) {
        changedRecords.set(cacheId, record);
        matchRecords.set(cacheId, record);
        rememberTrackMatches(cacheId, record);
      }
      resolvedTracks.push({ position, availability, availabilityStatus, matchAttempts });
    }

    // Durable ISRC or metadata-fingerprint matches allow future imports to bypass provider searches.
    for (const [cacheId, record] of changedRecords) {
      trackWrites.set(db.collection('tracks').doc(cacheId), { matches: record.matches }, { merge: true });
    }
    if (changedRecords.size) await trackWrites.commit();
    await cacheTrackMatches(changedRecords);

    if (providerLimitReached && providerLimitService) {
      await playlistRef.update({ providerLimitRunId: runId });
    }

    for (const [offset, track] of tracks.entries()) {
      const position = chunkIndex * 25 + offset;
      if (features.spotify && sourceIsSpotify && targetService === 'apple' && typeof track.id === 'string' && track.id.startsWith('spotify:track:')) {
        resolvedTracks[offset].availability.spotify = track.id;
      }
    }

    const result = await db.runTransaction(async (transaction) => {
      const latestDoc = await transaction.get(playlistRef);
      const latest = latestDoc.data()!;
      if (latest.processingRunId !== runId) {
        return { completedChunks: latest.progress?.completedChunks || 0, stale: true };
      }
      const completedIndexes: number[] = latest.completedChunkIndexes || [];
      if (completedIndexes.includes(chunkIndex)) {
        return { completedChunks: latest.progress?.completedChunks || 0, duplicate: true };
      }
      const allTracks = latest.tracks || [];
      if (latest.providerLimitRunId === runId && providerLimitService && providerLimitService === targetService) {
        for (const track of allTracks) {
          if (!track.availability?.[targetService]) {
            track.availabilityStatus = { ...(track.availabilityStatus || {}), [targetService]: 'temporarily_unavailable' };
          }
        }
      }
      for (const resolved of resolvedTracks) {
        if (allTracks[resolved.position]) {
          const availability = { ...(allTracks[resolved.position].availability || {}) };
          const services = targetService ? [targetService] : ['spotify', 'apple', 'youtube'] as const;
          for (const service of services) {
            const match = resolved.availability[service];
            if (match !== undefined) {
              availability[service] = match;
              if (allTracks[resolved.position].availabilityStatus) {
                delete allTracks[resolved.position].availabilityStatus[service];
              }
            }
            const status = resolved.availabilityStatus[service];
            if (status) {
              allTracks[resolved.position].availabilityStatus = {
                ...(allTracks[resolved.position].availabilityStatus || {}),
                [service]: status,
              };
            }
            const attempts = resolved.matchAttempts[service];
            if (attempts !== undefined) {
              allTracks[resolved.position].matchAttempts = {
                ...(allTracks[resolved.position].matchAttempts || {}),
                [service]: attempts,
              };
            }
          }
          allTracks[resolved.position].availability = availability;
        }
      }
      const completedChunks = completedIndexes.length + (providerFailures.size ? 0 : 1);
      const totalChunks = latest.progress?.totalChunks || 1;
      const update: Record<string, unknown> = { tracks: allTracks };
      const progressServices = targetService
        ? [targetService]
        : providerOrder.filter((service) => service === 'spotify'
          ? spotifyEnabledForRun
          : service === 'apple' ? appleEnabledForRun : youtubeEnabledForRun);
      const completedTracks = allTracks.filter((track: any) => progressServices.every((service) =>
        track.availability?.[service] !== undefined && track.availabilityStatus?.[service] !== 'pending',
      )).length;
      update['progress.completedTracks'] = completedTracks;
      update['progress.totalTracks'] = allTracks.length;
      if (providerLimitReached && providerLimitService === targetService) {
        const completedIndexes: number[] = latest.completedChunkIndexes || [];
        const updatedIndexes = [...new Set([...completedIndexes, chunkIndex])];
        update.completedChunkIndexes = updatedIndexes;
        update['progress.completedChunks'] = updatedIndexes.length;
        update.status = 'ready';
        update.matchingService = null;
        const serviceName = targetService === 'spotify' ? 'Spotify' : targetService === 'apple' ? 'Apple Music' : 'YouTube Music';
        update.matchingNotice = providerRateLimited && targetService === 'youtube'
          ? "YouTube Music's daily limit of 100 searches has been reached. Existing matches are saved and available to transfer. Try YouTube Music matching again tomorrow."
          : providerRateLimited
            ? `${serviceName}'s rate limit has been reached. Existing matches are saved and available to transfer. Try matching again later.`
          : `${serviceName} denied further matching because of its API rules or usage limits. Existing matches are saved and available to transfer.`;
      } else if (!providerFailures.size) {
        update.completedChunkIndexes = [...completedIndexes, chunkIndex];
        update['progress.completedChunks'] = completedChunks;
        update.status = completedChunks >= totalChunks ? 'ready' : 'processing';
        if (completedChunks >= totalChunks) update.matchingService = null;
      }
      transaction.update(playlistRef, update);
      return { completedChunks, duplicate: false, stale: false };
    });

    if (!result.stale && (!providerFailures.size || (providerLimitReached && providerLimitService === targetService))) {
      await markChunkComplete(playlistId, chunkIndex);
    }

    if (providerLimitReached && providerLimitService === targetService && !result.stale) {
      try {
        await cancelPlaylistRun(playlistId, runId);
      } catch (error) {
        request.log.warn({ err: error, playlistId, runId, service: providerLimitService }, 'Could not cancel remaining matching chunks after a provider limit was reached');
      }
    }

    if (providerFailures.size && !providerLimitReached && !result.stale && !result.duplicate) {
      const retryAfter = [...providerFailures.values()].find((failure) => failure.retryAfter)?.retryAfter || '30';
      reply.header('Retry-After', retryAfter);
      return reply.status(503).send({
        error: 'One or more music services could not finish matching this chunk; successful matches were saved and the failed searches can be retried.',
        failedServices: [...providerFailures.keys()],
      });
    }

    return reply.send({ success: true, ...result });
  });
}
