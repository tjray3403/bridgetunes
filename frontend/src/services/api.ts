import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://bridgetunes.onrender.com';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

function ownerKeyForPlaylist(url: string): string {
  const storageKey = `bridgetunes-owner-key:${url.trim()}`;
  let ownerKey = localStorage.getItem(storageKey);
  if (!ownerKey) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    ownerKey = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(storageKey, ownerKey);
  }
  return ownerKey;
}

export function hasPlaylistOwnerKey(url: string, playlistId?: string): boolean {
  return Boolean((playlistId && ownerKeyForPlaylistId(playlistId)) || localStorage.getItem(`bridgetunes-owner-key:${url.trim()}`));
}

function storePlaylistOwnerKey(playlistId: string, ownerKey: string): void {
  localStorage.setItem(`bridgetunes-owner-key:playlist:${playlistId}`, ownerKey);
}

function ownerKeyForPlaylistId(playlistId: string): string | null {
  return localStorage.getItem(`bridgetunes-owner-key:playlist:${playlistId}`);
}

export async function submitPlaylist(url: string, service: string, spotifyAccessToken?: string, expiresInHours = 24, playlistName?: string) {
  const ownerKey = ownerKeyForPlaylist(url);
  const { data } = await apiClient.post('/api/playlists', { url, service, expiresInHours, playlistName }, {
    headers: {
      'X-Playlist-Owner-Key': ownerKey,
      ...(spotifyAccessToken ? { Authorization: `Bearer ${spotifyAccessToken}` } : {}),
    },
  });
  const result = data as { playlistId: string; status: string };
  if (result.playlistId) storePlaylistOwnerKey(result.playlistId, ownerKey);
  return result;
}

export async function getPlaylist(id: string) {
  const { data } = await apiClient.get(`/api/playlists/${encodeURIComponent(id)}`);
  return data;
}

export async function rematchApplePlaylist(id: string, sourceUrl: string): Promise<void> {
  const ownerKey = ownerKeyForPlaylistId(id) || localStorage.getItem(`bridgetunes-owner-key:${sourceUrl.trim()}`);
  if (!ownerKey) throw new Error('Only the browser that created this playlist link can refresh its matches.');
  try {
    await apiClient.post(`/api/playlists/${encodeURIComponent(id)}/rematch/apple`, {}, {
      headers: { 'X-Playlist-Owner-Key': ownerKey },
    });
  } catch (cause) {
    if (axios.isAxiosError<{ error?: string }>(cause) && cause.response?.data?.error) {
      throw new Error(cause.response.data.error);
    }
    throw cause;
  }
}

export async function trackPlaylistVisit(id: string) {
  await apiClient.post(`/api/playlists/${encodeURIComponent(id)}/visit`);
}

export async function getAppleDeveloperToken(): Promise<string> {
  const { data } = await apiClient.get<{ developerToken: string }>('/api/apple/developer-token');
  return data.developerToken;
}
