import type { MusicAdapter, Playlist, Track } from './types.js';

const apiBase = 'https://www.googleapis.com/youtube/v3';

type YouTubePlaylist = { id: string; snippet?: { title?: string; description?: string; thumbnails?: { medium?: { url?: string } } }; contentDetails?: { itemCount?: number } };
type YouTubePage = { nextPageToken?: string; items?: Array<{ snippet?: { title?: string; videoOwnerChannelTitle?: string; channelTitle?: string; resourceId?: { videoId?: string } }; contentDetails?: { videoId?: string } }> };

export class YouTubeMusicAdapter implements MusicAdapter {
  id = 'youtube' as const;

  parseUrl(url: string): { playlistId: string } | null {
    try {
      const parsed = new URL(url);
      if (!['music.youtube.com', 'www.youtube.com', 'youtube.com', 'youtu.be'].includes(parsed.hostname.toLowerCase())) return null;
      const id = parsed.searchParams.get('list') || parsed.pathname.match(/^\/playlist\/([\w-]+)/)?.[1];
      return id ? { playlistId: id } : null;
    } catch { return null; }
  }

  private key(): string {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) throw new Error('YouTube is not configured on the API.');
    return key;
  }

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    const query = new URLSearchParams({ ...params, key: this.key() });
    const response = await fetch(`${apiBase}/${path}?${query}`);
    if (!response.ok) {
      const error = new Error(`YouTube API request failed (${response.status})`) as Error & { status: number; retryAfter?: string };
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after') || undefined;
      throw error;
    }
    return response.json() as Promise<T>;
  }

  private async authorizedRequest<T>(path: string, accessToken: string, params: Record<string, string>, body?: unknown): Promise<T> {
    const query = new URLSearchParams({ ...params, key: this.key() });
    const response = await fetch(`${apiBase}/${path}?${query}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const error = new Error(`YouTube API request failed (${response.status})`) as Error & { status: number; retryAfter?: string };
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after') || undefined;
      throw error;
    }
    return response.json() as Promise<T>;
  }

  async getPlaylists(accessToken: string): Promise<Playlist[]> {
    const data = await this.authorizedRequest<{ items?: YouTubePlaylist[] }>('playlists', accessToken, { part: 'snippet,contentDetails', mine: 'true', maxResults: '50' });
    return (data.items || []).map((playlist) => ({ id: playlist.id, name: playlist.snippet?.title || 'YouTube playlist', description: playlist.snippet?.description, trackCount: playlist.contentDetails?.itemCount || 0, imageUrl: playlist.snippet?.thumbnails?.medium?.url }));
  }

  async getPlaylistName(_accessToken: string, playlistId: string): Promise<string | null> {
    const data = await this.request<{ items?: YouTubePlaylist[] }>('playlists', { part: 'snippet', id: playlistId });
    return data.items?.[0]?.snippet?.title || null;
  }

  async getPlaylistTracks(_accessToken: string, playlistId: string): Promise<Track[]> {
    const tracks: Track[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.request<YouTubePage>('playlistItems', {
        part: 'snippet,contentDetails', playlistId, maxResults: '50', ...(pageToken ? { pageToken } : {}),
      });
      for (const item of data.items || []) {
        const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
        const title = item.snippet?.title;
        if (!videoId || !title || title === 'Deleted video' || title === 'Private video') continue;
        const match = title.match(/^(.+?)\s+-\s+(.+)$/);
        tracks.push({ id: videoId, title: match?.[2] || title, artist: item.snippet?.videoOwnerChannelTitle || item.snippet?.channelTitle || match?.[1] || 'YouTube' });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return tracks;
  }

  async createPlaylist(accessToken: string, _userId: string, name: string, description?: string): Promise<Playlist> {
    const data = await this.authorizedRequest<YouTubePlaylist>('playlists', accessToken, { part: 'snippet,status' }, { snippet: { title: name, description }, status: { privacyStatus: 'private' } });
    return { id: data.id, name: data.snippet?.title || name, description, trackCount: 0, imageUrl: data.snippet?.thumbnails?.medium?.url };
  }

  async addTracksToPlaylist(accessToken: string, playlistId: string, trackIdentifiers: string[]): Promise<void> {
    for (const videoId of trackIdentifiers) {
      await this.authorizedRequest('playlistItems', accessToken, { part: 'snippet' }, { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } });
    }
  }

  async searchTrack(_accessToken: string, track: Track, _storefront = 'US'): Promise<string | null> {
    const data = await this.request<{ items?: Array<{ id?: { videoId?: string } }> }>('search', {
      part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '5', q: `${track.title} ${track.artist}`,
    });
    return data.items?.find((item) => item.id?.videoId)?.id?.videoId || null;
  }
}
