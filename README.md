# Bridetunes
Bridetunes turns a playlist link from one music service into a shareable link ("Smart Link") showing where each song is available on other services, designed to cost close to $0 a month.

## Features
- Paste a Spotify, Apple Music, or TIDAL playlist link to generate a Smart Link.
- Background workers handle slow outside API calls asynchronously.
- View availability across multiple music providers and identify unmatched songs.
- Export playlists directly into your own music account via OAuth.

## Architecture
- **Frontend**: React on Firebase Hosting
- **API & Workers**: Node.js + Fastify on Google Cloud Run
- **Database**: Firestore
- **Queue**: Cloud Tasks
