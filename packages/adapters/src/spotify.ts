import type { MusicAdapter, Playlist, Track } from './types.js';

type SpotifyTrackItem = {
  uri: string;
  type?: string;
  name: string;
  artists?: Array<{ name: string }>;
  album?: { name: string };
  duration_ms?: number;
  external_ids?: { isrc?: string };
};

type SpotifyPlaylistItemsPage = {
  items?: Array<{ item?: SpotifyTrackItem | null; track?: SpotifyTrackItem | null }>;
  next?: string | null;
};

export class SpotifyAdapter implements MusicAdapter {
  id = 'spotify' as const;
  private baseUrl = (process.env.SPOTIFY_API_BASE_URL || 'https://api.spotify.com/v1').replace(/\/$/, '');

  parseUrl(url: string): { playlistId: string } | null {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'spotify.com' && !parsed.hostname.endsWith('.spotify.com')) return null;
      const match = parsed.pathname.match(/\/playlist\/([a-zA-Z0-9]+)/);
      return match ? { playlistId: match[1] } : null;
    } catch {
      return null;
    }
  }

  async getPlaylists(accessToken: string): Promise<Playlist[]> {
    const res = await fetch(`${this.baseUrl}/me/playlists?limit=50`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Spotify API error: ${res.statusText}`);
    const data = await res.json();

    return data.items.map((item: any) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      trackCount: item.tracks.total,
      imageUrl: item.images?.[0]?.url,
    }));
  }

  async getPlaylistName(accessToken: string, playlistId: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/playlists/${encodeURIComponent(playlistId)}?fields=name`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const details = await res.text();
      throw new Error(`Spotify API error (${res.status}): ${details || res.statusText}`);
    }
    const data = await res.json() as { name?: string };
    return data.name || null;
  }

  async getPlaylistTracks(accessToken: string, playlistId: string): Promise<Track[]> {
    const tracks: Track[] = [];
    let nextUrl: string | null = `${this.baseUrl}/playlists/${encodeURIComponent(playlistId)}/items?limit=100`;

    while (nextUrl) {
      const pageUrl: string = nextUrl;
      const res: Response = await fetch(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        const details = await res.text();
        const error = new Error(`Spotify API error (${res.status}): ${details || res.statusText}`) as Error & { status: number };
        error.status = res.status;
        throw error;
      }
      const data = await res.json() as SpotifyPlaylistItemsPage;
      for (const item of data.items || []) {
        const track = item.item ?? item.track;
        if (!track || (track.type && track.type !== 'track')) continue;
        tracks.push({
          id: track.uri,
          title: track.name,
          artist: (track.artists || []).map((artist: { name: string }) => artist.name).join(', '),
          album: track.album?.name,
          durationMs: track.duration_ms,
          isrc: track.external_ids?.isrc,
        });
      }
      nextUrl = data.next || null;
    }
    return tracks;
  }

  async createPlaylist(accessToken: string, userId: string, name: string, description?: string): Promise<Playlist> {
    const res = await fetch(`${this.baseUrl}/users/${userId}/playlists`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, description, public: false }),
    });
    if (!res.ok) throw new Error(`Spotify create playlist error: ${res.statusText}`);
    const data = await res.json();

    return {
      id: data.id,
      name: data.name,
      description: data.description,
      trackCount: 0,
      imageUrl: data.images?.[0]?.url,
    };
  }

  async addTracksToPlaylist(accessToken: string, playlistId: string, trackIdentifiers: string[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uris: trackIdentifiers }),
    });
    if (!res.ok) throw new Error(`Spotify add tracks error: ${res.statusText}`);
  }

  async searchTrack(accessToken: string, track: Track, storefront: string = 'US'):Promise<string | null> {
    // 1. Try exact ISRC lookup first
    if (track.isrc) {
      const isrcRes = await fetch(`${this.baseUrl}/search?q=isrc:${track.isrc}&type=track&market=${storefront}&limit=1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!isrcRes.ok) {
        const error = new Error(`Spotify search failed (${isrcRes.status})`) as Error & { status: number; retryAfter?: string };
        error.status = isrcRes.status;
        error.retryAfter = isrcRes.headers.get('retry-after') || undefined;
        throw error;
      }
      const data = await isrcRes.json() as { tracks?: { items?: Array<{ uri: string }> } };
      if (data.tracks?.items?.length) {
        return data.tracks.items[0].uri;
      }
    }

    // 2. Fallback to fuzzy metadata query
    const cleanQuery = encodeURIComponent(`track:${track.title} artist:${track.artist}`);
    const fallbackRes = await fetch(`${this.baseUrl}/search?q=${cleanQuery}&type=track&market=${storefront}&limit=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fallbackRes.ok) {
      const error = new Error(`Spotify search failed (${fallbackRes.status})`) as Error & { status: number; retryAfter?: string };
      error.status = fallbackRes.status;
      error.retryAfter = fallbackRes.headers.get('retry-after') || undefined;
      throw error;
    }
    const fallbackData = await fallbackRes.json() as { tracks?: { items?: Array<{ uri: string }> } };
    return fallbackData.tracks?.items?.[0]?.uri || null;
  }
}
