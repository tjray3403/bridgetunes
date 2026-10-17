import { Redis } from '@upstash/redis';
import type { Track } from '@bridgetunes/adapters';

const PLAYLIST_MEMORY_TTL_MS = 180_000;
const TRACK_TTL_SECONDS = 24 * 60 * 60;
const PROGRESS_TTL_SECONDS = 60 * 60;
const MEMORY_TTL_MS = 60_000;
const MEMORY_MAX_ENTRIES = 150;

export type TrackMatch = { id: string | null; recheckAt?: string; checkedAt?: string };
export type TrackMatchRecord = { matches: Record<string, TrackMatch> };

const memory = new Map<string, { value: unknown; expiresAt: number }>();
const memoryTrackMatches = new Map<string, TrackMatchRecord>();
const playlistCacheVersions = new Map<string, number>();
let warnedRedisFailure = false;

function redisClient(): Redis | undefined {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return undefined;
  return new Redis({ url, token });
}

const redis = redisClient();

function warnRedis(error: unknown): void {
  if (warnedRedisFailure) return;
  warnedRedisFailure = true;
  console.warn('Upstash Redis is unavailable; continuing with Firestore and process memory.', error);
}

function remember<T>(key: string, value: T, ttlMs = MEMORY_TTL_MS): void {
  if (memory.size >= MEMORY_MAX_ENTRIES) {
    const oldestKey = memory.keys().next().value;
    if (oldestKey) memory.delete(oldestKey);
  }
  memory.delete(key);
  memory.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function recall<T>(key: string): T | undefined {
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return undefined;
  }
  // Refresh LRU order without extending the expiry.
  memory.delete(key);
  memory.set(key, entry);
  return entry.value as T;
}

export async function getCachedPlaylist(id: string): Promise<unknown | null> {
  const key = `playlist:${id}`;
  const local = recall<unknown>(key);
  return local && typeof local === 'object' && (local as { status?: unknown }).status === 'ready' ? local : null;
}

export function getPlaylistCacheVersion(id: string): number {
  return playlistCacheVersions.get(id) || 0;
}

export async function cacheReadyPlaylist(id: string, value: unknown, expectedVersion: number): Promise<void> {
  if (getPlaylistCacheVersion(id) === expectedVersion && value && typeof value === 'object' && (value as { status?: unknown }).status === 'ready') {
    remember(`playlist:${id}`, value, PLAYLIST_MEMORY_TTL_MS);
  }
}

export async function invalidatePlaylistCache(id: string): Promise<void> {
  memory.delete(`playlist:${id}`);
  playlistCacheVersions.set(id, getPlaylistCacheVersion(id) + 1);
  if (playlistCacheVersions.size > MEMORY_MAX_ENTRIES) {
    const oldestKey = playlistCacheVersions.keys().next().value;
    if (oldestKey) playlistCacheVersions.delete(oldestKey);
  }
}

export async function getProgressCount(id: string): Promise<number | null> {
  if (!redis) return null;
  try {
    const count = await redis.scard(`progress:${id}`);
    return Number.isFinite(count) ? count : 0;
  } catch (error) {
    warnRedis(error);
    return null;
  }
}

export async function markChunkComplete(id: string, chunkIndex: number): Promise<void> {
  if (!redis) return;
  try {
    const key = `progress:${id}`;
    await redis.sadd(key, String(chunkIndex));
    await redis.expire(key, PROGRESS_TTL_SECONDS);
  } catch (error) {
    warnRedis(error);
  }
}

export async function resetPlaylistProgress(id: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`progress:${id}`);
  } catch (error) {
    warnRedis(error);
  }
}

export function normalizeIsrc(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^[A-Z0-9]{12}$/.test(normalized) ? normalized : undefined;
}

export function getMemoryTrackMatches(isrc: string): TrackMatchRecord | undefined {
  const record = memoryTrackMatches.get(isrc);
  if (!record) return undefined;
  memoryTrackMatches.delete(isrc);
  memoryTrackMatches.set(isrc, record);
  return record;
}

export function rememberTrackMatches(isrc: string, record: TrackMatchRecord): void {
  if (memoryTrackMatches.size >= 500) {
    const oldestKey = memoryTrackMatches.keys().next().value;
    if (oldestKey) memoryTrackMatches.delete(oldestKey);
  }
  memoryTrackMatches.delete(isrc);
  memoryTrackMatches.set(isrc, record);
}

export async function getRedisTrackMatches(isrcs: string[]): Promise<Map<string, TrackMatchRecord>> {
  const found = new Map<string, TrackMatchRecord>();
  if (!redis || !isrcs.length) return found;
  try {
    const values = await redis.mget<(TrackMatchRecord | null)[]>(...isrcs.map((isrc) => `track:${isrc}`));
    (values || []).forEach((value, index) => {
      const isrc = isrcs[index];
      if (value && typeof value === 'object' && value.matches && typeof value.matches === 'object') {
        found.set(isrc, value);
        rememberTrackMatches(isrc, value);
      }
    });
  } catch (error) {
    warnRedis(error);
  }
  return found;
}

export async function cacheTrackMatches(records: Map<string, TrackMatchRecord>): Promise<void> {
  if (!redis || !records.size) return;
  try {
    const pipeline = redis.pipeline();
    for (const [isrc, record] of records) {
      rememberTrackMatches(isrc, record);
      pipeline.set(`track:${isrc}`, record, { ex: TRACK_TTL_SECONDS });
    }
    await pipeline.exec();
  } catch (error) {
    warnRedis(error);
  }
}

export function cacheKeyForTrack(track: Track, service: 'spotify' | 'apple', storefront = 'us'): string | undefined {
  const isrc = normalizeIsrc(track.isrc);
  return isrc ? `${service}:${storefront.toLowerCase()}` : undefined;
}
