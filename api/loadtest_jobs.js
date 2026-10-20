import http from 'k6/http';
import { check } from 'k6';

const virtualUsers = Math.max(1, Number(__ENV.VUS || 5));
const runId = __ENV.RUN_ID || String(Date.now());

if (!__ENV.API_URL) {
  throw new Error('Set API_URL to the base URL of your local BridgeTunes API.');
}

export const options = {
  scenarios: {
    concurrent_imports: {
      executor: 'per-vu-iterations',
      vus: virtualUsers,
      iterations: 1,
      maxDuration: '10m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // Synthetic Spotify playlist IDs are served by api/mock_providers.js.
  // runId makes each invocation a set of first-time BridgeTunes imports.
  const playlistUrl = `https://open.spotify.com/playlist/BTLOAD${__VU}?loadtest=${encodeURIComponent(runId)}`;
  const payload = JSON.stringify({
    url: playlistUrl,
    service: 'spotify',
    expiresInHours: 24,
  });

  const response = http.post(`${__ENV.API_URL.replace(/\/$/, '')}/api/playlists`, payload, {
    headers: {
      'Content-Type': 'application/json',
      // The API validates the format; each VU gets a distinct test-only owner key.
      'X-Playlist-Owner-Key': __VU.toString(16).padStart(64, '0'),
    },
    tags: { endpoint: 'create_playlist' },
  });

  const accepted = check(response, {
    'import accepted (202)': (result) => result.status === 202,
  });

  if (!accepted) {
    console.error(`VU ${__VU}: HTTP ${response.status} ${response.body}`);
    return;
  }

  const playlistId = response.json('playlistId');
  const statusResponse = http.get(`${__ENV.API_URL.replace(/\/$/, '')}/api/playlists/${playlistId}`, {
    tags: { endpoint: 'playlist_status' },
  });
  const ready = check(statusResponse, {
    'import finished in ready state': (result) => result.status === 200 && result.json('status') === 'ready',
  });
  if (!ready) {
    console.error(`VU ${__VU}: playlist ${playlistId} status check got HTTP ${statusResponse.status}: ${statusResponse.body}`);
  }
}
