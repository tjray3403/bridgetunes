import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    ready_playlist_views: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 10),
      duration: __ENV.DURATION || '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const response = http.get(
    `${__ENV.API_URL}/api/playlists/${__ENV.PLAYLIST_ID}`,
    { tags: { endpoint: 'ready_playlist' } },
  );

  check(response, {
    'playlist request succeeded': (r) => r.status === 200,
  });

  sleep(1);
}