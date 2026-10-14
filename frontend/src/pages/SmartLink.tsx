import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPlaylist } from '../services/api';
import { CheckCircle2, Loader2, AlertCircle } from 'lucide-react';

export function SmartLink() {
  const { id } = useParams<{ id: string }>();
  const [playlist, setPlaylist] = useState<any>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;

    let isMounted = true;
    const fetchDetails = async () => {
      try {
        const data = await getPlaylist(id);
        if (!isMounted) return;
        setPlaylist(data);

        // Stop polling if ready or failed
        if (data.status === 'ready' || data.status === 'failed') {
          clearInterval(interval);
        }
      } catch (err) {
        if (isMounted) setError('Could not load playlist details.');
      }
    };

    fetchDetails();
    const interval = setInterval(fetchDetails, 3000); // Poll every 3 seconds

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [id]);

  if (error) {
    return <div className="min-h-screen bg-slate-950 text-red-400 p-8 flex items-center justify-center">{error}</div>;
  }

  if (!playlist) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center space-y-4">
        <Loader2 className="animate-spin text-violet-500" size={40} />
        <p className="text-slate-400">Loading Smart Link...</p>
      </div>
    );
  }

  const isProcessing = playlist.status === 'processing';
  const progressPercent = playlist.progress?.totalChunks
    ? Math.round((playlist.progress.completedChunks / playlist.progress.totalChunks) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6 max-w-4xl mx-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-violet-400 bg-violet-950/50 px-3 py-1 rounded-full border border-violet-800/50">
            {playlist.sourceService} Import
          </span>
          <h1 className="text-3xl font-bold mt-2">{playlist.name || 'Processing Playlist...'}</h1>
          <p className="text-slate-400 text-sm mt-1">{playlist.tracks?.length || 0} tracks total</p>
        </div>

        {isProcessing && (
          <div className="w-full md:w-64 bg-slate-950 p-4 rounded-xl border border-slate-800">
            <div className="flex justify-between text-xs text-slate-400 mb-2">
              <span className="flex items-center gap-1.5">
                <Loader2 className="animate-spin text-violet-400" size={14} /> Matching Songs
              </span>
              <span>{progressPercent}%</span>
            </div>
            <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
              <div className="bg-violet-600 h-full transition-all duration-300" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-300">Track Availability</h2>
        {playlist.status === 'failed' && (
          <p role="alert" className="rounded-xl border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
            {playlist.error || 'Playlist processing failed.'}
          </p>
        )}
        {playlist.tracks?.map((track: any, index: number) => (
          <div key={index} className="bg-slate-900/60 border border-slate-800/80 rounded-xl p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-white">{track.title}</p>
              <p className="text-sm text-slate-400">{track.artist}</p>
            </div>

            <div className="flex items-center space-x-3">
              <span className={`text-xs px-2.5 py-1 rounded-lg flex items-center gap-1 ${track.availability?.spotify ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/50' : 'bg-slate-800 text-slate-500'}`}>
                Spotify {track.availability?.spotify ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
              </span>
              <span className={`text-xs px-2.5 py-1 rounded-lg flex items-center gap-1 ${track.availability?.apple ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/50' : 'bg-slate-800 text-slate-500'}`}>
                Apple Music {track.availability?.apple ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
