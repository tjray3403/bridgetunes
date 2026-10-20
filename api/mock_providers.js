import http from 'node:http';

const port = Number(process.env.MOCK_PROVIDER_PORT || 8090);
const trackCount = Math.max(1, Math.min(500, Number(process.env.MOCK_TRACKS_PER_PLAYLIST || 100)));
const delayMs = Math.max(0, Number(process.env.MOCK_PROVIDER_DELAY_MS || 0));

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}

function playlistTracks(playlistId) {
  const hash = [...playlistId].reduce((value, character) => (value * 31 + character.charCodeAt(0)) % 100000, 7);
  return Array.from({ length: trackCount }, (_, index) => {
    const serial = String(hash * trackCount + index + 1).padStart(7, '0').slice(-7);
    return {
      uri: `spotify:track:mock${playlistId}${index}`,
      type: 'track',
      name: `Load Test Track ${index + 1}`,
      artists: [{ name: 'BridgeTunes Mock Artist' }],
      album: { name: 'Synthetic Test Album' },
      duration_ms: 180000 + (index % 120) * 1000,
      external_ids: { isrc: `USMCK${serial}` },
    };
  });
}

const server = http.createServer(async (request, response) => {
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);

  if (request.method === 'POST' && url.pathname === '/api/token') {
    return sendJson(response, 200, { access_token: 'mock-spotify-access-token', token_type: 'Bearer', expires_in: 3600 });
  }

  const playlistMatch = url.pathname.match(/^\/v1\/playlists\/([a-zA-Z0-9]+)(?:\/(items|tracks))?$/);
  if (request.method === 'GET' && playlistMatch) {
    const [, playlistId, resource] = playlistMatch;
    if (resource === 'items') {
      return sendJson(response, 200, {
        items: playlistTracks(playlistId).map((item) => ({ item })),
        next: null,
      });
    }
    if (resource === 'tracks') {
      return sendJson(response, 200, { data: playlistTracks(playlistId).map((track) => ({
        id: track.uri.split(':').at(-1),
        type: 'songs',
        attributes: {
          name: track.name,
          artistName: track.artists[0].name,
          albumName: track.album.name,
          durationInMillis: track.duration_ms,
          isrc: track.external_ids.isrc,
        },
      })) });
    }
    return sendJson(response, 200, { name: `Mock Playlist ${playlistId}`, owner: { id: 'mock-owner' } });
  }

  if (request.method === 'GET' && url.pathname === '/v1/search') {
    const isrc = url.searchParams.get('q')?.match(/isrc:([A-Z0-9]{12})/i)?.[1] || 'USMCK0000001';
    return sendJson(response, 200, { tracks: { items: [{ uri: `spotify:track:mock-${isrc}` }] } });
  }

  if (request.method === 'GET' && url.pathname === '/v1/catalog/us/songs') {
    const isrc = url.searchParams.get('filter[isrc]') || 'USMCK0000001';
    return sendJson(response, 200, { data: [{ id: `apple-mock-${isrc}` }] });
  }

  if (request.method === 'GET' && url.pathname === '/v1/catalog/us/search') {
    return sendJson(response, 200, { results: { songs: { data: [{ id: 'apple-mock-search-result' }] } } });
  }

  return sendJson(response, 404, { error: `Mock provider route not found: ${request.method} ${url.pathname}` });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock music providers listening on http://127.0.0.1:${port}; ${trackCount} tracks per playlist`);
});
