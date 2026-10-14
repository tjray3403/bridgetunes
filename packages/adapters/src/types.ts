export interface Track {
  id: string;          // Platform-specific ID (e.g., Spotify URI or Apple Music catalog ID)
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  isrc?: string;       // International Standard Recording Code (Crucial for 1:1 matching)
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  trackCount: number;
  imageUrl?: string;
}

export interface MusicAdapter {
  id: 'spotify' | 'apple' | 'tidal' | 'youtube';
  parseUrl(url: string): { playlistId: string } | null;
  getPlaylists(accessToken: string): Promise<Playlist[]>;
  getPlaylistTracks(accessToken: string, playlistId: string): Promise<Track[]>;
  createPlaylist(accessToken: string, userId: string, name: string, description?: string): Promise<Playlist>;
  addTracksToPlaylist(accessToken: string, playlistId: string, trackIdentifiers: string[]): Promise<void>;
  searchTrack(accessToken: string, track: Track, storefront: string): Promise<string | null>;
}