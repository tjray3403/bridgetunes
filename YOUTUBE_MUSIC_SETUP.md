# YouTube Music setup

BridgeTunes uses YouTube Data API v3 to read playlists and search video matches. Google does not provide a separate public YouTube Music catalog API for this integration.

## Google Cloud configuration

1. Create or select a Google Cloud project and enable **YouTube Data API v3**.
2. Create an API key restricted to YouTube Data API v3. Set it as `YOUTUBE_API_KEY` in the API environment (local `api/.env` and the Render service settings).
3. Create a Google OAuth web client ID and set it as `VITE_GOOGLE_CLIENT_ID` in `frontend/.env.local` and the production frontend build environment.
4. Add authorized JavaScript origins for local development (`http://127.0.0.1:5173`) and the Firebase Hosting origins (`https://bridgetunes-fccff.web.app` and `https://bridgetunes-fccff.firebaseapp.com`).
5. Configure the OAuth consent screen for the YouTube account management scope: `https://www.googleapis.com/auth/youtube`.
6. Set `ENABLE_YOUTUBE_MUSIC=true` in the API environment. The flag is off by default, so the service remains hidden until credentials are configured and the feature is enabled.

The API key stays on the server and is used for public or unlisted playlist import and catalog search. Private YouTube playlists cannot be imported by this integration. Users authorize Google in the browser only when creating a private destination playlist.

## Quota and matching behavior

YouTube API search currently has a default allocation of 100 `search.list` calls per day. BridgeTunes searches once per track that needs a YouTube match, so request a quota increase in Google Cloud before enabling the feature for production traffic. Playlist item insertion also consumes quota for every video added. See Google's [quota documentation](https://developers.google.com/youtube/v3/determine_quota_cost).

Matches point to YouTube videos. The top search result can be a cover, live performance, or another upload, so users should review matches before relying on them as exact catalog equivalents.
