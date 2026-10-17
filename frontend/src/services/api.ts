import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://bridgetunes-api.onrender.com';

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

export async function submitPlaylist(url: string, service: string, spotifyAccessToken?: string, expiresInDays = 1) {
  const ownerKey = ownerKeyForPlaylist(url);
  const { data } = await apiClient.post('/api/playlists', { url, service, expiresInDays }, {
    headers: {
      'X-Playlist-Owner-Key': ownerKey,
      ...(spotifyAccessToken ? { Authorization: `Bearer ${spotifyAccessToken}` } : {}),
    },
  });
  return data as { playlistId: string; status: string };
}

export async function getPlaylist(id: string) {
  const { data } = await apiClient.get(`/api/playlists/${encodeURIComponent(id)}`);
  return data;
}

export async function trackPlaylistVisit(id: string) {
  await apiClient.post(`/api/playlists/${encodeURIComponent(id)}/visit`);
}
