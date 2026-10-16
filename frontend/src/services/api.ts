import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://bridgetunes-api.onrender.com';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

export async function submitPlaylist(url: string, service: string, spotifyAccessToken?: string) {
  const { data } = await apiClient.post('/api/playlists', { url, service }, {
    headers: spotifyAccessToken ? { Authorization: `Bearer ${spotifyAccessToken}` } : undefined,
  });
  return data as { playlistId: string; status: string };
}

export async function getPlaylist(id: string) {
  const { data } = await apiClient.get(`/api/playlists/${encodeURIComponent(id)}`);
  return data;
}
