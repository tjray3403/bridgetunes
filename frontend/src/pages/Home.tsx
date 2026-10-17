import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowRight, Check, Loader2, Music2, Sparkles } from 'lucide-react';
import { submitPlaylist } from '../services/api';
import { currentSpotifyAccessToken, spotifyAuthorizationUrl } from '../services/spotifyAuth';

type Service = 'spotify' | 'apple';

export function Home() {
  const [url, setUrl] = useState('');
  const [service, setService] = useState<Service>('spotify');
  const [expiresInDays, setExpiresInDays] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [spotifyAuthPrompt, setSpotifyAuthPrompt] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError('');
    setSpotifyAuthPrompt(false);

    try {
      const result = await submitPlaylist(url, service, service === 'spotify' ? currentSpotifyAccessToken() : undefined, expiresInDays);
      navigate(`/p/${result.playlistId}`);
    } catch (cause: unknown) {
      if (service === 'spotify' && typeof cause === 'object' && cause !== null && 'response' in cause) {
        const response = (cause as { response?: { data?: { authRequired?: boolean } } }).response;
        if (response?.data?.authRequired) {
          setSpotifyAuthPrompt(true);
          return;
        }
      }
      setError(getErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  const connectSpotify = async () => {
    setLoading(true);
    setError('');
    try {
      sessionStorage.setItem('bridgetunes-pending-playlist', JSON.stringify({ url, service, expiresInDays }));
      window.location.assign(await spotifyAuthorizationUrl());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not start Spotify sign-in.');
      setLoading(false);
    }
  };

  return (
    <main className="site-shell landing-shell">
      <div className="ambient ambient-gold" aria-hidden="true" />
      <div className="ambient ambient-violet" aria-hidden="true" />

      <header className="site-nav page-width">
        <Link className="brand-lockup" to="/" aria-label="BridgeTunes home">
          <span className="brand-mark"><Music2 size={17} strokeWidth={2.6} /></span>
          <span>bridge<span className="brand-light">tunes</span></span>
        </Link>
        <span className="nav-note"><span className="live-dot" /> Playlist links, made simple</span>
      </header>

      <section className="landing-layout page-width">
        <div className="landing-copy">
          <div className="eyebrow"><Sparkles size={13} /> YOUR MUSIC, CONNECTED</div>
          <h1>One playlist.<br /><span>Every service.</span></h1>
          <p className="hero-copy">See where the songs are available, then share one simple link with everyone.</p>

          <div className="service-legend" aria-label="Supported music services">
            <span className="service-pill service-pill-spotify"><span className="service-dot" /> Spotify</span>
            <span className="service-pill service-pill-apple"><span className="service-dot" /> Apple Music</span>
          </div>

          <form className="import-card" onSubmit={handleSubmit}>
            <div className="card-heading">
              <div>
                <span className="card-kicker">GET STARTED</span>
                <h2>Paste a playlist</h2>
              </div>
              <span className="step-badge">01 <ArrowDown size={13} /></span>
            </div>

            <label className="field-label" htmlFor="source-service">Playlist source</label>
            <div className="select-wrap">
              <select id="source-service" value={service} onChange={(event) => setService(event.target.value as Service)} className="field-control">
                <option value="spotify">Spotify</option>
                <option value="apple">Apple Music</option>
              </select>
              <ArrowDown className="select-icon" size={16} aria-hidden="true" />
            </div>

            <label className="field-label" htmlFor="playlist-url">Playlist URL</label>
            <input
              id="playlist-url"
              className="field-control url-input"
              type="url"
              placeholder={service === 'spotify' ? 'open.spotify.com/playlist/…' : 'music.apple.com/playlist/…'}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              autoComplete="url"
            />
            <p className="field-help">We only read the playlist details needed to find your tracks.</p>

            <label className="field-label" htmlFor="link-duration">Link duration (days)</label>
            <input
              id="link-duration"
              className="field-control duration-input"
              type="number"
              min={1}
              max={30}
              step={1}
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
              required
            />
            <p className="field-help">Choose 1–30 days. Links last 1 day by default.</p>

            {error && <p role="alert" className="notice notice-error">{error}</p>}

            {spotifyAuthPrompt && (
              <div className="notice notice-auth">
                <div className="notice-icon"><Music2 size={17} /></div>
                <div className="notice-content">
                  <strong>Connect Spotify to continue</strong>
                  <p>Spotify sign-in is needed to read this playlist. Continue with an account that can access it.</p>
                  <button type="button" onClick={connectSpotify} disabled={loading} className="button button-auth">
                    Continue with Spotify <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            )}

            <button type="submit" className="button button-primary import-submit" disabled={loading}>
              {loading ? <><Loader2 className="spin" size={18} /> Preparing your link…</> : <>Create or update your link <ArrowRight size={18} /></>}
            </button>
            <div className="privacy-note"><Check size={13} /> Resubmitting an active Spotify playlist link updates it in place. Only this browser can replace it.</div>
          </form>
        </div>

        <div className="landing-visual" aria-label="Example playlist preview">
          <div className="visual-caption"><span>THE BRIDGETUNES EXPERIENCE</span><span className="caption-line" /></div>
          <div className="device-frame">
            <div className="device-button device-button-left" />
            <div className="device-screen">
              <div className="device-status"><span>9:41</span><span className="status-icons"><i /><i /><i /></span></div>
              <div className="device-brand"><span className="mini-mark">bt</span><span>YOUR PLAYLIST</span></div>
              <div className="cover-art"><span className="cover-orb cover-orb-one" /><span className="cover-orb cover-orb-two" /><span className="cover-title">after<br />hours</span><span className="cover-subtitle">a little softer, a little slower</span></div>
              <div className="preview-info"><div><h3>Late Night Drive</h3><p>Shared by you · 42 tracks</p></div><span className="preview-play"><ArrowRight size={15} /></span></div>
              <div className="availability-row"><span className="availability-label">AVAILABLE ON</span><span className="tiny-service tiny-spotify">S</span><span className="tiny-service tiny-apple">A</span><span className="availability-count">2 services</span></div>
              <div className="preview-track"><span className="track-index">01</span><span className="track-copy"><b>Nightcall</b><small>Kavinsky</small></span><span className="track-duration">4:18</span></div>
              <div className="preview-track"><span className="track-index">02</span><span className="track-copy"><b>Instant Crush</b><small>Daft Punk, Julian Casablancas</small></span><span className="track-duration">5:37</span></div>
              <div className="preview-track"><span className="track-index">03</span><span className="track-copy"><b>Sundara</b><small>ME3</small></span><span className="track-duration">3:42</span></div>
              <div className="phone-footer"><span /> A link that sounds like you</div>
            </div>
          </div>
          <div className="visual-note"><span className="note-star">✳</span><span>One easy link.<br /><b>More ways to listen.</b></span></div>
        </div>
      </section>

      <footer className="landing-footer page-width"><span>BRIDGETUNES © 2026</span><span>Made for the music you share.</span></footer>
    </main>
  );
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) return response.data.error;
  }
  return 'Could not create the playlist link. Please check the URL and try again.';
}
