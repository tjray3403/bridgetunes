import { refreshMusicFeatureFlags } from './api';

type SpotifyPlaylistResponse = { id: string; external_urls?: { spotify?: string } };
export type SpotifyCreationProgress = { stage: 'creating' | 'adding'; completed: number; total: number };

export async function createSpotifyPlaylist(
  accessToken: string,
  name: string,
  trackUris: string[],
  onProgress?: (progress: SpotifyCreationProgress) => void,
): Promise<string> {
  const features = await refreshMusicFeatureFlags();
  if (!features.spotify) throw new Error('Spotify is temporarily unavailable. Please try again later.');
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  onProgress?.({ stage: 'creating', completed: 0, total: 1 });
  const createResponse = await fetch('https://api.spotify.com/v1/me/playlists', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, description: 'Created with BridgeTunes', public: false }),
  });
  if (!createResponse.ok) throw new Error('Spotify could not create the playlist. Please reconnect and try again.');

  const playlist = await createResponse.json() as SpotifyPlaylistResponse;
  const totalBatches = Math.ceil(trackUris.length / 100);
  onProgress?.({ stage: 'adding', completed: 0, total: totalBatches });
  for (let index = 0; index < trackUris.length; index += 100) {
    const response = await fetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlist.id)}/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ uris: trackUris.slice(index, index + 100) }),
    });
    if (!response.ok) throw new Error('Spotify created the playlist but could not add all tracks. Open Spotify to check it.');
    onProgress?.({ stage: 'adding', completed: Math.floor(index / 100) + 1, total: totalBatches });
  }
  return playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`;
}
