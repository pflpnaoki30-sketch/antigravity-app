import React, { useState, useEffect, useRef } from 'react';
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import { Upload, Download, Play, Pause, Scissors, AlertCircle, Settings, FileVideo } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Initialize v0.11 (Stable, Single-threaded, Offline Mode)
// Loading from local public folder
// Must be 'let' to allow hard reset if worker hangs
let ffmpeg = createFFmpeg({
  log: true,
  corePath: '/ffmpeg-core.js',
});

function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

// Utility to format seconds into MM:SS
const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// Utility to parse FFmpeg time string (HH:MM:SS.ms) to seconds
const parseFfmpegTime = (timeStr: string): number => {
  const parts = timeStr.split(':');
  if (parts.length < 3) return 0;
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  return h * 3600 + m * 60 + s;
};

function App() {
  const [ready, setReady] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSrc, setVideoSrc] = useState<string>('');
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 10]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  /* Debug & Logging State */
  const [showDebug, setShowDebug] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${time}] ${msg}`]);
  };

  // Scroll to bottom of logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // System Check
  const runSystemCheck = async () => {
    addLog('--- System Health Check ---');
    addLog(`User Agent: ${navigator.userAgent}`);
    addLog(`Cross-Origin Isolated: ${window.crossOriginIsolated ? '✅ YES' : '❌ NO'}`);

    try {
      const resp = await fetch('/ffmpeg-core.js');
      addLog(`ffmpeg-core.js: ${resp.status} ${resp.statusText}`);
    } catch (e: any) {
      addLog(`❌ ffmpeg-core.js fetch error: ${e.message}`);
    }

    try {
      const resp = await fetch('/ffmpeg-core.wasm');
      addLog(`ffmpeg-core.wasm: ${resp.status} ${resp.statusText}`);
    } catch (e: any) {
      // .wasm might not be served directly or name might check
      addLog(`⚠️ ffmpeg-core.wasm fetch check failed (might be normal if bundled differently): ${e.message}`);
    }

    addLog(`FFmpeg Loaded: ${ffmpeg.isLoaded() ? '✅ YES' : '❌ NO'}`);
    addLog('---------------------------');
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef(0);

  const load = async () => {
    addLog('Initializing FFmpeg...');
    if (!ffmpeg.isLoaded()) {
      try {
        await ffmpeg.load();
        setReady(true);
        addLog('✅ FFmpeg Engine Loaded Successfully');
        runSystemCheck();
      } catch (e: any) {
        console.error(e);
        setError(`エンジンの読み込みエラー: ${e.message || 'Unknown Error'}`);
        addLog(`❌ Engine Load Error: ${e.message}`);
      }
    } else {
      setReady(true);
      runSystemCheck();
    }
  };

  useEffect(() => {
    // Initial Logger Setup
    ffmpeg.setLogger(({ message }) => {
      // console.log(message);
      addLog(message);
    });
    load();
  }, []);

  useEffect(() => {
    if (videoFile) {
      const url = URL.createObjectURL(videoFile);
      setVideoSrc(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [videoFile]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.item(0);
    if (file) {
      // 1GB Limit
      if (file.size > 1024 * 1024 * 1024) {
        setError('ファイルサイズが大きすぎます (1GB制限)');
        return;
      }
      setError('');
      setVideoFile(file);
      setRange([0, 10]);
      addLog(`File selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      const dur = videoRef.current.duration;
      setDuration(dur);
      setRange([0, Math.min(dur, 10)]);
      addLog(`Video metadata loaded. Duration: ${dur}s`);
    }
  };

  const handleSliderChange = (newRange: number | number[]) => {
    if (Array.isArray(newRange)) {
      setRange(newRange as [number, number]);
      if (videoRef.current) {
        videoRef.current.currentTime = newRange[0];
      }
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const current = videoRef.current.currentTime;
      if (current >= range[1]) {
        videoRef.current.pause();
        setIsPlaying(false);
        videoRef.current.currentTime = range[0];
      }
    }
  };

  const [isSlow, setIsSlow] = useState(false);

  // Monitor for slow processing
  useEffect(() => {
    let timeout: any;
    if (isProcessing && progress === 0) {
      timeout = setTimeout(() => {
        setIsSlow(true);
        addLog('⚠️ Processing is slow (0% for 5s)');
      }, 5000);
    } else {
      setIsSlow(false);
    }
    return () => clearTimeout(timeout);
  }, [isProcessing, progress]);

  // Universal Ultrafast Export Logic
  const handleExport = async () => {
    if (!videoFile) return;

    try {
      setIsProcessing(true);
      setMessage('処理中... (MP4変換 / 高速モード)');
      addLog('--- Universal Export Started ---');
      addLog(`Range: ${range[0]} - ${range[1]}`);

      setProgress(0);
      progressRef.current = 0;
      setIsSlow(false);

      // CRITICAL: Use safe, sanitized names to avoid FFmpeg misinterpreting colons/spaces as protocols
      const extension = (videoFile.name.split('.').pop() || 'mp4').toLowerCase();
      const safeInputName = `input_source.${extension}`;
      const safeOutputName = 'output_processed.mp4';
      addLog(`Original filename: ${videoFile.name}`);
      addLog(`Using safe FS names: ${safeInputName} -> ${safeOutputName}`);

      const startTime = range[0];
      const durationTime = range[1] - range[0];

      // Setup Progress Logger
      ffmpeg.setLogger(({ message }) => {
        addLog(message); // Persist logs
        if (message.includes('time=')) {
          const match = message.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
          if (match && match[1]) {
            const currentTime = parseFfmpegTime(match[1]);
            const percent = Math.min(Math.round((currentTime / durationTime) * 100), 100);
            setProgress(percent);
            progressRef.current = percent;
          }
        }
      });

      // Write file to memory
      setMessage('ファイルを読み込んでいます...');
      if (!ffmpeg.isLoaded()) {
        addLog('FFmpeg not loaded, loading now...');
        await ffmpeg.load();
      }
      addLog('Writing file to FS...');
      ffmpeg.FS('writeFile', safeInputName, await fetchFile(videoFile));

      setMessage('エンコードを実行中...');
      addLog('Running Universal Command (ultrafast libx264)...');

      // Robust Command with compatibility flags
      await ffmpeg.run(
        '-ss', String(startTime),
        '-i', safeInputName,
        '-t', String(durationTime),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',      // Ensure compatibility with most players
        '-c:a', 'aac',
        '-movflags', '+faststart',   // Move moov atom for better streaming/playback
        '-avoid_negative_ts', 'make_zero',
        safeOutputName
      );

      // Read result
      setMessage('ファイルを生成中...');
      addLog('Reading output file...');
      const data = ffmpeg.FS('readFile', safeOutputName);

      // Create download link
      const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `split_${formatTime(startTime)}-${formatTime(range[1])}.mp4`;
      a.click();

      // Cleanup
      try {
        ffmpeg.FS('unlink', safeInputName);
        ffmpeg.FS('unlink', safeOutputName);
      } catch (e) { }

      setMessage('完了しました！');
      addLog('Export Finished Successfully.');
      setProgress(100);
    } catch (err: any) {
      console.error(err);
      setError('書き出し中にエラーが発生しました。コンソールを確認してください。');
      addLog(`❌ EXPORT ERROR: ${err.message}`);
      setMessage('');
    } finally {
      ffmpeg.setLogger(() => { });
      setTimeout(() => setIsProcessing(false), 1000);
    }
  };

  return (
    <div className="h-screen bg-white text-gray-900 font-sans selection:bg-blue-200 flex flex-col overflow-hidden">
      {/* Processing Overlay */}
      {isProcessing && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-white/95 backdrop-blur-sm">
          <div className="relative mb-4">
            <div className="w-16 h-16 border-4 border-gray-200 rounded-full" />
            <div className="absolute top-0 left-0 w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center font-mono font-bold text-blue-600">
              {progress}%
            </div>
          </div>
          <p className="text-lg font-medium text-gray-700 mb-2">{message}</p>
          {isSlow && (
            <p className="text-sm text-amber-600">処理に時間がかかっています...</p>
          )}
          <div className="w-48 h-2 bg-gray-200 rounded-full overflow-hidden mt-3">
            <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-gray-200 bg-white sticky top-0 z-10 flex-none">
        <div className="max-w-4xl mx-auto px-4 h-12 flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-blue-500 flex items-center justify-center">
              <Scissors className="w-4 h-4 text-white" />
            </div>
            <h1 className="text-base font-bold text-gray-800">動画・音声分割ツール</h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setShowDebug(!showDebug); if (!showDebug) runSystemCheck(); }}
              className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded border border-gray-300 text-gray-600"
            >🛠️ Debug</button>
            {!ready ? (
              <span className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded border border-amber-200">読込中...</span>
            ) : (
              <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded border border-green-200">準備完了</span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-4 space-y-4 flex-1 w-full overflow-y-auto">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2 text-red-600 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {!videoFile && (
          <div className="relative group cursor-pointer flex-1 flex items-center justify-center">
            <input type="file" accept="video/*,audio/*" onChange={handleFileChange} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10" disabled={!ready} />
            <div className={cn(
              "w-full max-w-md h-48 border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-3 transition-all",
              !ready ? "border-gray-300 bg-gray-50 opacity-50 cursor-not-allowed" : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50"
            )}>
              <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center group-hover:bg-blue-100">
                <Upload className="w-6 h-6 text-gray-500 group-hover:text-blue-500" />
              </div>
              <p className="text-sm font-medium text-gray-600">動画・音声ファイルをドロップ</p>
              <p className="text-xs text-gray-400">最大 1GB</p>
            </div>
          </div>
        )}

        {videoFile && videoSrc && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            <div className="lg:col-span-2 space-y-3 flex flex-col min-h-0">
              <div className="relative rounded-lg overflow-hidden bg-black aspect-video ring-1 ring-gray-200 group flex-shrink-0">
                <video ref={videoRef} src={videoSrc} className="w-full h-full object-contain" onLoadedMetadata={handleLoadedMetadata} onTimeUpdate={handleTimeUpdate} onClick={togglePlay} />
                <button onClick={togglePlay} className="absolute inset-0 m-auto w-12 h-12 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  {isPlaying ? <Pause className="w-6 h-6 text-white" /> : <Play className="w-6 h-6 text-white ml-0.5" />}
                </button>
              </div>
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 space-y-3 flex-shrink-0">
                <div className="flex justify-between items-center">
                  <label className="text-sm font-medium text-gray-600 flex items-center gap-1"><Scissors className="w-3 h-3" />切り出し範囲</label>
                  <span className="font-mono text-xs text-gray-400">Total: {formatTime(duration)}</span>
                </div>
                <Slider range min={0} max={duration} step={0.1} value={range} onChange={handleSliderChange as any}
                  trackStyle={[{ backgroundColor: '#3b82f6', height: 4 }]}
                  railStyle={{ backgroundColor: '#e5e7eb', height: 4 }}
                  handleStyle={[{ borderColor: '#3b82f6', backgroundColor: '#fff', opacity: 1, height: 16, width: 16, marginTop: -6, boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }, { borderColor: '#3b82f6', backgroundColor: '#fff', opacity: 1, height: 16, width: 16, marginTop: -6, boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }]}
                />
                <div className="flex gap-3">
                  <div className="flex-1 bg-white rounded p-2 border border-gray-200">
                    <span className="text-xs text-gray-400">開始</span>
                    <div className="font-mono text-sm text-gray-800">{formatTime(range[0])}</div>
                  </div>
                  <div className="flex-1 bg-white rounded p-2 border border-gray-200 text-right">
                    <span className="text-xs text-gray-400">終了</span>
                    <div className="font-mono text-sm text-gray-800">{formatTime(range[1])}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 flex flex-col h-full">
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-1">
                  <FileVideo className="w-4 h-4 text-blue-500" />ファイル情報
                </h3>
                <div className="space-y-2 flex-1 text-sm">
                  <div><span className="text-xs text-gray-400">ファイル名</span><p className="text-gray-700 break-all text-xs">{videoFile.name}</p></div>
                  <div><span className="text-xs text-gray-400">切り出し時間</span><p className="font-mono text-blue-600">{formatTime(range[1] - range[0])}</p></div>
                  <div className="pt-2 border-t border-gray-200">
                    <span className="text-xs text-gray-400 flex items-center gap-1"><Settings className="w-3 h-3" />形式</span>
                    <p className="text-xs text-gray-600 bg-white px-2 py-1 rounded border border-gray-200 mt-1">MP4 (高速変換)</p>
                  </div>
                </div>
                <div className="mt-4 pt-3 border-t border-gray-200 space-y-2">
                  <button onClick={handleExport} disabled={isProcessing} className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white font-medium py-2.5 px-4 rounded-lg transition flex items-center justify-center gap-2 text-sm">
                    <Download className="w-4 h-4" />{isProcessing ? '処理中...' : '書き出し'}
                  </button>
                  <button onClick={() => { setVideoFile(null); setVideoSrc(''); }} className="w-full py-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg text-xs">別のファイルを選択</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {showDebug && (
        <div className="h-32 border-t border-gray-200 bg-gray-50 p-2 overflow-y-auto font-mono text-xs flex-none w-full">
          {logs.map((log, i) => (
            <div key={i} className={clsx(
              "mb-0.5",
              log.toLowerCase().includes('error') || log.toLowerCase().includes('fail') ? "text-red-500" :
                log.toLowerCase().includes('warn') ? "text-amber-600" :
                  log.toLowerCase().includes('success') || log.includes('✅') ? "text-green-600" : "text-gray-600"
            )}>{log}</div>
          ))}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  );
}

export default App;
