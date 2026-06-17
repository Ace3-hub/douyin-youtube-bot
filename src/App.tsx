import { useState, useEffect } from 'react';
import { AlertCircle, CheckCircle, Play, Pause, RefreshCw, Trash2 } from 'lucide-react';

interface Log {
  time: string;
  status: string;
  message: string;
}

interface Video {
  id: string;
  title: string;
  duration: number;
  addedAt: string;
  author?: string;
}

interface AppStatus {
  connected: boolean;
  isBotRunning: boolean;
  logs: Log[];
  downloadedCount: number;
  uploadedCount: number;
  pendingQueue: Video[];
  isWorkflowExecuting: boolean;
  downloadCycle: number;
}

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [authUrl, setAuthUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteVideoId, setDeleteVideoId] = useState('');

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        setStatus(data);
        setLoading(false);
      } catch (err) {
        console.error('Failed to fetch status:', err);
        setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchAuthUrl = async () => {
      try {
        const res = await fetch('/api/auth/url');
        const data = await res.json();
        if (data.url) {
          setAuthUrl(data.url);
        }
      } catch (err) {
        console.error('Failed to fetch auth URL:', err);
      }
    };

    fetchAuthUrl();

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        window.location.reload();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleOAuthLogin = () => {
    if (authUrl) {
      window.open(authUrl, 'googleAuth', 'width=500,height=600');
    }
  };

  const handleBotToggle = async (running: boolean) => {
    try {
      const res = await fetch('/api/bot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ running })
      });
      const data = await res.json();
      if (data.success) {
        setStatus(prev => prev ? { ...prev, isBotRunning: data.isBotRunning } : null);
      }
    } catch (err) {
      console.error('Failed to toggle bot:', err);
    }
  };

  const handleForceRun = async () => {
    try {
      await fetch('/api/bot/force-run', { method: 'POST' });
    } catch (err) {
      console.error('Failed to force run:', err);
    }
  };

  const handleDeleteVideo = async (videoId: string) => {
    try {
      await fetch(`/api/bot/queue/${videoId}`, { method: 'DELETE' });
      setShowDeleteConfirm(false);
      setDeleteVideoId('');
    } catch (err) {
      console.error('Failed to delete video:', err);
    }
  };

  const handleResetDownloads = async () => {
    if (confirm('Reset download counter to 0?')) {
      try {
        await fetch('/api/bot/reset-downloads', { method: 'POST' });
      } catch (err) {
        console.error('Failed to reset downloads:', err);
      }
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
          <p className="text-white">Loading bot status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">🤖 Douyin→YouTube Bot</h1>
          <p className="text-slate-300">24/7 Automated Video Upload System</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                  {status?.connected ? (
                    <CheckCircle className="w-6 h-6 text-green-500" />
                  ) : (
                    <AlertCircle className="w-6 h-6 text-yellow-500" />
                  )}
                  Connection Status
                </h2>
              </div>

              {!status?.connected ? (
                <div className="space-y-4">
                  <p className="text-slate-300">Connect your YouTube account to start the bot.</p>
                  <button
                    onClick={handleOAuthLogin}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg transition flex items-center justify-center gap-2"
                  >
                    🔐 Login with Google
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-green-400 font-semibold">✓ YouTube Account Connected</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="bg-slate-700 p-3 rounded">
                      <p className="text-slate-400 text-xs">Downloaded</p>
                      <p className="text-2xl font-bold text-white">{status?.downloadedCount || 0}</p>
                    </div>
                    <div className="bg-slate-700 p-3 rounded">
                      <p className="text-slate-400 text-xs">Pending</p>
                      <p className="text-2xl font-bold text-white">{status?.pendingQueue?.length || 0}</p>
                    </div>
                    <div className="bg-slate-700 p-3 rounded">
                      <p className="text-slate-400 text-xs">Uploaded</p>
                      <p className="text-2xl font-bold text-white">{status?.uploadedCount || 0}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {status?.connected && (
              <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
                <h2 className="text-xl font-semibold text-white mb-4">Bot Control</h2>
                <div className="space-y-4">
                  <button
                    onClick={() => handleBotToggle(!status.isBotRunning)}
                    className={`w-full font-semibold py-3 rounded-lg transition flex items-center justify-center gap-2 ${
                      status.isBotRunning
                        ? 'bg-red-600 hover:bg-red-700 text-white'
                        : 'bg-green-600 hover:bg-green-700 text-white'
                    }`}
                  >
                    {status.isBotRunning ? (
                      <>
                        <Pause className="w-5 h-5" />
                        Stop Bot
                      </>
                    ) : (
                      <>
                        <Play className="w-5 h-5" />
                        Start Bot (24/7)
                      </>
                    )}
                  </button>
                  {status.isBotRunning && (
                    <p className="text-green-400 text-sm font-semibold">✓ Bot is running continuously...</p>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={handleForceRun}
                      className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Force Upload
                    </button>
                    <button
                      onClick={handleResetDownloads}
                      className="bg-yellow-600 hover:bg-yellow-700 text-white font-semibold py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Reset Count
                    </button>
                  </div>
                </div>
              </div>
            )}

            {status?.connected && (
              <div className="bg-slate-800 rounded-lg p-6 border border-slate-700">
                <h2 className="text-xl font-semibold text-white mb-4">Pending Queue</h2>
                {status?.downloadCycle === 1 && (
                  <div className="bg-yellow-500 bg-opacity-10 border border-yellow-500 rounded p-3 text-yellow-300 text-sm mb-4">
                    ⏸️ Download pause: Reached 100 videos. Will resume when queue drops below 50.
                  </div>
                )}
                <div className="space-y-2">
                  {status?.pendingQueue && status.pendingQueue.length > 0 ? (
                    status.pendingQueue.slice(0, 5).map((video, idx) => (
                      <div key={video.id} className="flex items-center justify-between bg-slate-700 p-3 rounded text-sm">
                        <div className="flex-1">
                          <p className="text-white font-semibold truncate">{idx + 1}. {video.title?.substring(0, 40)}...</p>
                          <p className="text-slate-400 text-xs">{video.author || 'Unknown'} • {video.duration}s</p>
                        </div>
                        <button
                          onClick={() => {
                            setDeleteVideoId(video.id);
                            setShowDeleteConfirm(true);
                          }}
                          className="ml-2 p-2 hover:bg-red-600 rounded transition"
                        >
                          <Trash2 className="w-4 h-4 text-red-400" />
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="text-slate-400">No videos in queue</p>
                  )}
                  {status?.pendingQueue && status.pendingQueue.length > 5 && (
                    <p className="text-slate-400 text-sm">+{status.pendingQueue.length - 5} more videos...</p>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="bg-slate-800 rounded-lg p-6 border border-slate-700 h-[600px] overflow-hidden flex flex-col">
            <h2 className="text-xl font-semibold text-white mb-4">📊 Activity Logs</h2>
            <div className="flex-1 overflow-y-auto space-y-2">
              {(status?.logs || []).map((log, idx) => (
                <div key={idx} className="text-xs border-l-2 border-slate-600 pl-3 py-1">
                  <p className="text-slate-400">{new Date(log.time).toLocaleTimeString()}</p>
                  <p className={`text-xs font-semibold ${
                    log.status === 'SUCCESS' ? 'text-green-400' :
                    log.status === 'ERROR' ? 'text-red-400' :
                    log.status === 'WARN' ? 'text-yellow-400' :
                    'text-blue-400'
                  }`}>
                    {log.message}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-slate-800 rounded-lg p-6 border border-slate-700 max-w-sm">
            <h3 className="text-lg font-bold text-white mb-4">Delete Video from Queue?</h3>
            <p className="text-slate-300 mb-6">This video will be removed from the pending queue and deleted from the server.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-semibold py-2 rounded-lg transition"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteVideo(deleteVideoId)}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold py-2 rounded-lg transition"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
