export interface Track {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  isrc?: string;
}

export interface PlaylistData {
  title: string;
  description?: string;
  tracks: Track[];
}

export interface MusicAdapter {
  getPlaylist(playlistId: string): Promise<PlaylistData>;
  searchTrack(track: Track): Promise<string | null>; // Returns track ID or URI in destination service
}