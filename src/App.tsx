/**
 * @fileoverview 動画・音声分割ツール
 * @description ブラウザ完結型の動画/音声トリミングアプリケーション
 *
 * @technical_notes
 * - FFmpeg.wasm v0.11.x を使用（v0.12はマルチスレッド問題でフリーズする報告があるため回避）
 * - SharedArrayBuffer 使用のため COOP/COEP ヘッダー必須（vercel.json で設定）
 * - ファイル名サニタイズ：コロン等の特殊文字を含むファイル名はFFmpegがプロトコルと誤認識するため、
 *   仮想FS上では安全な静的ファイル名を使用
 *
 * @version 1.0.0
 * @license MIT
 */

import { useState, useEffect, useRef } from 'react';
import { createFFmpeg, fetchFile } from '@ffmpeg/ffmpeg';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import { Upload, Download, Play, Pause, Scissors, AlertCircle, Settings, FileVideo } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * FFmpeg インスタンス初期化
 *
 * @why v0.11.x を使用
 * v0.12.x はマルチスレッド対応だが、一部環境でWeb Workerがフリーズする既知の問題がある。
 * v0.11.x はシングルスレッドだが安定性が高く、本アプリケーションの用途に適している。
 *
 * @why let 宣言
 * Workerがハングした場合にインスタンスを再生成してリセットする可能性があるため。
 */
let ffmpeg = createFFmpeg({
  log: true,
  corePath: '/ffmpeg-core.js',
});

/** Tailwind CSS クラス結合ユーティリティ */
function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

/** 秒数を MM:SS 形式に変換 */
const formatTime = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

/** FFmpeg出力の時間文字列 (HH:MM:SS.ms) を秒数に変換 */
const parseFfmpegTime = (timeStr: string): number => {
  const parts = timeStr.split(':');
  if (parts.length < 3) return 0;
  const h = parseFloat(parts[0]);
  const m = parseFloat(parts[1]);
  const s = parseFloat(parts[2]);
  return h * 3600 + m * 60 + s;
};

function App() {
  // Core State
  const [ready, setReady] = useState(false);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSrc, setVideoSrc] = useState<string>('');
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 10]);
  const [isPlaying, setIsPlaying] = useState(false);

  // Processing State
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isSlow, setIsSlow] = useState(false);

  // Debug State
  const [showDebug, setShowDebug] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(0);

  /** デバッグログ追加 */
  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [...prev, `[${time}] ${msg}`]);
  };

  /** ログ自動スクロール */
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  /** システムヘルスチェック */
  const runSystemCheck = async () => {
    addLog('--- System Health Check ---');
    addLog(`Cross-Origin Isolated: ${window.crossOriginIsolated ? '✅ YES' : '❌ NO'}`);

    try {
      const resp = await fetch('/ffmpeg-core.js');
      addLog(`ffmpeg-core.js: ${resp.status} ${resp.statusText}`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      addLog(`❌ ffmpeg-core.js fetch error: ${message}`);
    }

    try {
      const resp = await fetch('/ffmpeg-core.wasm');
      addLog(`ffmpeg-core.wasm: ${resp.status} ${resp.statusText}`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      addLog(`⚠️ ffmpeg-core.wasm fetch error: ${message}`);
    }

    addLog(`FFmpeg Loaded: ${ffmpeg.isLoaded() ? '✅ YES' : '❌ NO'}`);
    addLog('---------------------------');
  };

  /** FFmpegエンジン初期化 */
  const loadFFmpeg = async () => {
    addLog('Initializing FFmpeg...');
    if (!ffmpeg.isLoaded()) {
      try {
        await ffmpeg.load();
        setReady(true);
        addLog('✅ FFmpeg Engine Loaded Successfully');
        runSystemCheck();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Unknown error';
        setError(`エンジンの読み込みエラー: ${message}`);
        addLog(`❌ Engine Load Error: ${message}`);
      }
    } else {
      setReady(true);
      runSystemCheck();
    }
  };

  /** 初期化 */
  useEffect(() => {
    ffmpeg.setLogger(({ message }) => addLog(message));
    loadFFmpeg();
  }, []);

  /** 動画プレビューURL生成 */
  useEffect(() => {
    if (videoFile) {
      const url = URL.createObjectURL(videoFile);
      setVideoSrc(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [videoFile]);

  /** ファイル選択ハンドラ */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.item(0);
    if (file) {
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

  /** 動画メタデータ読み込み */
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      const dur = videoRef.current.duration;
      setDuration(dur);
      setRange([0, Math.min(dur, 10)]);
      addLog(`Video metadata loaded. Duration: ${dur}s`);
    }
  };

  /** スライダー変更ハンドラ */
  const handleSliderChange = (newRange: number | number[]) => {
    if (Array.isArray(newRange)) {
      setRange(newRange as [number, number]);
      if (videoRef.current) {
        videoRef.current.currentTime = newRange[0];
      }
    }
  };

  /** 再生/一時停止トグル */
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

  /** 再生範囲制限 */
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

  /** 処理遅延検知 */
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
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

  /**
   * 動画エクスポート処理
   *
   * @why ファイル名サニタイズ
   * ユーザーがアップロードするファイル名にコロン(:)やスペースが含まれている場合、
   * FFmpegがネットワークプロトコル（例: http:, rtmp:）と誤認識してフリーズする。
   * 仮想FS上では安全な静的ファイル名を使用することでこの問題を回避。
   *
   * @why BlobPart キャスト
   * FFmpeg.wasm v0.11 の出力バッファは SharedArrayBuffer の可能性があり、
   * TypeScript の Blob コンストラクタ型定義と互換性がない。
   * ランタイムでは問題なく動作するため、型キャストで回避。
   */
  const handleExport = async () => {
    if (!videoFile) return;

    try {
      setIsProcessing(true);
      setMessage('処理中... (MP4変換 / 高速モード)');
      addLog('--- Export Started ---');
      addLog(`Range: ${range[0]} - ${range[1]}`);

      setProgress(0);
      progressRef.current = 0;
      setIsSlow(false);

      // ファイル名サニタイズ：特殊文字を含むファイル名はFFmpegがプロトコルと誤認識する
      const extension = (videoFile.name.split('.').pop() || 'mp4').toLowerCase();
      const safeInputName = `input_source.${extension}`;
      const safeOutputName = 'output_processed.mp4';
      addLog(`Using safe FS names: ${safeInputName} -> ${safeOutputName}`);

      const startTime = range[0];
      const durationTime = range[1] - range[0];

      // プログレスロガー設定
      ffmpeg.setLogger(({ message }) => {
        addLog(message);
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

      // ファイル読み込み
      setMessage('ファイルを読み込んでいます...');
      if (!ffmpeg.isLoaded()) {
        addLog('FFmpeg not loaded, loading now...');
        await ffmpeg.load();
      }
      addLog('Writing file to FS...');
      ffmpeg.FS('writeFile', safeInputName, await fetchFile(videoFile));

      // エンコード実行
      setMessage('エンコードを実行中...');
      addLog('Running FFmpeg command (ultrafast libx264)...');

      await ffmpeg.run(
        '-ss', String(startTime),
        '-i', safeInputName,
        '-t', String(durationTime),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-avoid_negative_ts', 'make_zero',
        safeOutputName
      );

      // 出力ファイル読み込み
      setMessage('ファイルを生成中...');
      addLog('Reading output file...');
      const data = ffmpeg.FS('readFile', safeOutputName);

      // ダウンロードリンク生成
      // SharedArrayBuffer は BlobPart 型と互換性がないため型キャスト
      const url = URL.createObjectURL(new Blob([data.buffer as BlobPart], { type: 'video/mp4' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `split_${formatTime(startTime)}-${formatTime(range[1])}.mp4`;
      a.click();

      // クリーンアップ
      try {
        ffmpeg.FS('unlink', safeInputName);
        ffmpeg.FS('unlink', safeOutputName);
      } catch { /* ignore cleanup errors */ }

      setMessage('完了しました！');
      addLog('✅ Export Finished Successfully.');
      setProgress(100);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError('書き出し中にエラーが発生しました。');
      addLog(`❌ EXPORT ERROR: ${message}`);
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
          {isSlow && <p className="text-sm text-amber-600">処理に時間がかかっています...</p>}
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

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 py-4 space-y-4 flex-1 w-full overflow-y-auto">
        {/* Error Display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2 text-red-600 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {/* Upload Area */}
        {!videoFile && (
          <div className="relative group cursor-pointer flex-1 flex items-center justify-center">
            <input
              type="file"
              accept="video/*,audio/*"
              onChange={handleFileChange}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              disabled={!ready}
            />
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

        {/* Editor Interface */}
        {videoFile && videoSrc && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
            {/* Video Preview */}
            <div className="lg:col-span-2 space-y-3 flex flex-col min-h-0">
              <div className="relative rounded-lg overflow-hidden bg-black aspect-video ring-1 ring-gray-200 group flex-shrink-0">
                <video
                  ref={videoRef}
                  src={videoSrc}
                  className="w-full h-full object-contain"
                  onLoadedMetadata={handleLoadedMetadata}
                  onTimeUpdate={handleTimeUpdate}
                  onClick={togglePlay}
                />
                <button
                  onClick={togglePlay}
                  className="absolute inset-0 m-auto w-12 h-12 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  {isPlaying ? <Pause className="w-6 h-6 text-white" /> : <Play className="w-6 h-6 text-white ml-0.5" />}
                </button>
              </div>

              {/* Timeline Controls */}
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 space-y-3 flex-shrink-0">
                <div className="flex justify-between items-center">
                  <label className="text-sm font-medium text-gray-600 flex items-center gap-1">
                    <Scissors className="w-3 h-3" />切り出し範囲
                  </label>
                  <span className="font-mono text-xs text-gray-400">Total: {formatTime(duration)}</span>
                </div>
                <Slider
                  range
                  min={0}
                  max={duration}
                  step={0.1}
                  value={range}
                  onChange={handleSliderChange as (value: number | number[]) => void}
                  trackStyle={[{ backgroundColor: '#3b82f6', height: 4 }]}
                  railStyle={{ backgroundColor: '#e5e7eb', height: 4 }}
                  handleStyle={[
                    { borderColor: '#3b82f6', backgroundColor: '#fff', opacity: 1, height: 16, width: 16, marginTop: -6, boxShadow: '0 1px 3px rgba(0,0,0,0.2)' },
                    { borderColor: '#3b82f6', backgroundColor: '#fff', opacity: 1, height: 16, width: 16, marginTop: -6, boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }
                  ]}
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

            {/* Sidebar */}
            <div className="space-y-3">
              <div className="bg-gray-50 rounded-lg p-4 border border-gray-200 flex flex-col h-full">
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-1">
                  <FileVideo className="w-4 h-4 text-blue-500" />ファイル情報
                </h3>
                <div className="space-y-2 flex-1 text-sm">
                  <div>
                    <span className="text-xs text-gray-400">ファイル名</span>
                    <p className="text-gray-700 break-all text-xs">{videoFile.name}</p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-400">切り出し時間</span>
                    <p className="font-mono text-blue-600">{formatTime(range[1] - range[0])}</p>
                  </div>
                  <div className="pt-2 border-t border-gray-200">
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <Settings className="w-3 h-3" />形式
                    </span>
                    <p className="text-xs text-gray-600 bg-white px-2 py-1 rounded border border-gray-200 mt-1">
                      MP4 (高速変換)
                    </p>
                  </div>
                </div>
                <div className="mt-4 pt-3 border-t border-gray-200 space-y-2">
                  <button
                    onClick={handleExport}
                    disabled={isProcessing}
                    className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white font-medium py-2.5 px-4 rounded-lg transition flex items-center justify-center gap-2 text-sm"
                  >
                    <Download className="w-4 h-4" />
                    {isProcessing ? '処理中...' : '書き出し'}
                  </button>
                  <button
                    onClick={() => { setVideoFile(null); setVideoSrc(''); }}
                    className="w-full py-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg text-xs"
                  >
                    別のファイルを選択
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Debug Console */}
      {showDebug && (
        <div className="h-32 border-t border-gray-200 bg-gray-50 p-2 overflow-y-auto font-mono text-xs flex-none w-full">
          {logs.map((log, i) => (
            <div
              key={i}
              className={clsx(
                "mb-0.5",
                log.toLowerCase().includes('error') || log.toLowerCase().includes('fail') ? "text-red-500" :
                  log.toLowerCase().includes('warn') ? "text-amber-600" :
                    log.toLowerCase().includes('success') || log.includes('✅') ? "text-green-600" : "text-gray-600"
              )}
            >
              {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      )}
    </div>
  );
}

export default App;
