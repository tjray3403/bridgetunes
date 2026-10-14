import type { MusicAdapter, Playlist, Track } from './types.js';

export class SpotifyAdapter implements MusicAdapter {
  id = 'spotify' as const;
  private baseUrl = 'https://api.spotify.com/v1';

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

  async getPlaylistTracks(accessToken: string, playlistId: string): Promise<Track[]> {
    const res = await fetch(`${this.baseUrl}/playlists/${playlistId}/tracks`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Spotify API error: ${res.statusText}`);
    const data = await res.json();

    return data.items.map((item: any) => {
      const track = item.track;
      if (!track) return null;
      return {
        id: track.uri,
        title: track.name,
        artist: track.artists.map((a: any) => a.name).join(', '),
        album: track.album?.name,
        durationMs: track.duration_ms,
        isrc: track.external_ids?.isrc,
      };
    }).filter(Boolean);
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
      if (isrcRes.ok) {
        const data = await isrcRes.json();
        if (data.tracks?.items?.length > 0) {
          return data.tracks.items[0].uri;
        }
      }
    }

    // 2. Fallback to fuzzy metadata query
    const cleanQuery = encodeURIComponent(`track:${track.title} artist:${track.artist}`);
    const fallbackRes = await fetch(`${this.baseUrl}/search?q=${cleanQuery}&type=track&market=${storefront}&limit=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fallbackRes.ok) return null;
    const fallbackData = await fallbackRes.json();
    return fallbackData.tracks?.items?.[0]?.uri || null;
  }
}
