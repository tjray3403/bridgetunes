import type { MusicAdapter, Playlist, Track } from './types.js';

export class AppleMusicAdapter implements MusicAdapter {
  id = 'apple' as const;
  private baseUrl = (process.env.APPLE_MUSIC_API_BASE_URL || 'https://api.music.apple.com/v1').replace(/\/$/, '');

  parseUrl(url: string): { playlistId: string } | null {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'music.apple.com') return null;
      const match = parsed.pathname.match(/\/playlist\/[^\/]+\/([a-zA-Z0-9.-]+)/);
      return match ? { playlistId: match[1] } : null;
    } catch {
      return null;
    }
  }

  async getPlaylists(userToken: string): Promise<Playlist[]> {
    const res = await fetch(`${this.baseUrl}/me/library/playlists`, {
      headers: { 
        Authorization: `Bearer ${process.env.APPLE_DEVELOPER_TOKEN}`,
        'Music-User-Token': userToken,
      },
    });
    if (!res.ok) throw new Error(`Apple Music API error: ${res.statusText}`);
    const data = await res.json();

    return data.data.map((item: any) => ({
      id: item.id,
      name: item.attributes.name,
      description: item.attributes.description?.standard,
      trackCount: item.attributes.trackCount || 0,
      imageUrl: item.attributes.artwork?.url?.replace('{w}', '300').replace('{h}', '300'),
    }));
  }

  async getPlaylistName(_userToken: string, playlistId: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/catalog/us/playlists/${encodeURIComponent(playlistId)}`, {
      headers: { Authorization: `Bearer ${process.env.APPLE_DEVELOPER_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Apple Music API error: ${res.statusText}`);
    const data = await res.json() as { data?: Array<{ attributes?: { name?: string } }> };
    return data.data?.[0]?.attributes?.name || null;
  }

  async getPlaylistTracks(_userToken: string, playlistId: string): Promise<Track[]> {
    const res = await fetch(`${this.baseUrl}/catalog/us/playlists/${playlistId}/tracks`, {
      headers: { Authorization: `Bearer ${process.env.APPLE_DEVELOPER_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Apple Music API error: ${res.statusText}`);
    const data = await res.json();

    return data.data.map((track: any) => ({
      id: track.id,
      title: track.attributes.name,
      artist: track.attributes.artistName,
      album: track.attributes.albumName,
      durationMs: track.attributes.durationInMillis,
      isrc: track.attributes.isrc,
    }));
  }

  async createPlaylist(userToken: string, userId: string, name: string, description?: string): Promise<Playlist> {
    const res = await fetch(`${this.baseUrl}/me/library/playlists`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.APPLE_DEVELOPER_TOKEN}`,
        'Music-User-Token': userToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        attributes: { name, description: description ? { standard: description } : undefined }
      }),
    });
    if (!res.ok) throw new Error(`Apple Music create playlist error: ${res.statusText}`);
    const data = await res.json();
    const item = data.data[0];

    return {
      id: item.id,
      name: item.attributes.name,
      description: description,
      trackCount: 0,
    };
  }

  async addTracksToPlaylist(userToken: string, playlistId: string, trackIdentifiers: string[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/me/library/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.APPLE_DEVELOPER_TOKEN}`,
        'Music-User-Token': userToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: trackIdentifiers.map(id => ({ id, type: 'songs' }))
      }),
    });
    if (!res.ok) throw new Error(`Apple Music add tracks error: ${res.statusText}`);
  }

  async searchTrack(userToken: string, track: Track, storefront: string = 'us'): Promise<string | null> {
    // 1. ISRC Catalog Lookup
    const isrc = track.isrc?.trim().toUpperCase();
    if (isrc) {
      const params = new URLSearchParams({ 'filter[isrc]': isrc });
      const isrcRes = await fetch(`${this.baseUrl}/catalog/${storefront}/songs?${params.toString()}`, {
        headers: { Authorization: `Bearer ${process.env.APPLE_DEVELOPER_TOKEN}` },
      });
      if (!isrcRes.ok) {
        const error = new Error(`Apple Music search failed (${isrcRes.status})`) as Error & { status: number; retryAfter?: string };
        error.status = isrcRes.status;
        error.retryAfter = isrcRes.headers.get('retry-after') || undefined;
        throw error;
      }
      const data = await isrcRes.json() as { data?: Array<{ id: string }> };
      if (data.data?.length) return data.data[0].id;
    }

    // 2. Metadata Catalog Search Fallback
    const term = encodeURIComponent(`${track.title} ${track.artist}`);
    const searchRes = await fetch(`${this.baseUrl}/catalog/${storefront}/search?term=${term}&types=songs&limit=1`, {
      headers: { Authorization: `Bearer ${process.env.APPLE_DEVELOPER_TOKEN}` },
    });
    if (!searchRes.ok) {
      const error = new Error(`Apple Music search failed (${searchRes.status})`) as Error & { status: number; retryAfter?: string };
      error.status = searchRes.status;
      error.retryAfter = searchRes.headers.get('retry-after') || undefined;
      throw error;
    }
    const searchData = await searchRes.json() as { results?: { songs?: { data?: Array<{ id: string }> } } };
    return searchData.results?.songs?.data?.[0]?.id || null;
  }
}
