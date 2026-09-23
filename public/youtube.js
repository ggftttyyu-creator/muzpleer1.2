// Клиентская обёртка над YouTube IFrame Player API.
// Скрипт грузится с youtube.com — в изолированном превью внешняя сеть закрыта,
// поэтому здесь всё аккуратно деградирует с понятным сообщением.

let apiPromise = null;

function loadIframeApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () =>
      reject(
        new Error(
          'Не удалось загрузить YouTube IFrame API: нет доступа к youtube.com. ' +
            'В изолированном превью внешняя сеть закрыта — запустите `npm start` локально, и плеер заработает.',
        ),
      );
    const timer = setTimeout(
      () => reject(new Error('Таймаут загрузки YouTube IFrame API')),
      15000,
    );
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      resolve(window.YT);
    };
    document.head.append(script);
  });
  return apiPromise;
}

export class YouTubeDock {
  constructor({ frame, note, onState, onProgress }) {
    this.frame = frame;
    this.note = note;
    this.onState = onState;
    this.onProgress = onProgress;
    this.player = null;
    this.ready = false;
    this.videoId = null;
    this._poll = null;
  }

  async mount() {
    if (this.ready) return;
    this.note.textContent = 'Загружаю YouTube-плеер…';
    const YT = await loadIframeApi();
    const host = document.createElement('div');
    host.id = 'yt-mount';
    this.frame.append(host);
    await new Promise((resolve) => {
      this.player = new YT.Player(host, {
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 1, modestbranding: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: () => {
            this.ready = true;
            this.note.textContent = '';
            resolve();
          },
          onStateChange: (e) => {
            // -1 нет данных, 0 завершён, 1 играет, 2 пауза, 3 буферизация, 5 очередь
            this.onState?.(e.data);
          },
          onError: (e) => {
            const codes = {
              2: 'Некорректный ID видео',
              5: 'Плеер не поддерживает формат HTML5',
              100: 'Видео удалено или приватное',
              101: 'Владелец запретил встраивание',
              150: 'Владелец запретил встраивание',
            };
            this.note.textContent = '⚠️ ' + (codes[e.data] || 'Ошибка плеера YouTube');
            this.onState?.(-2);
          },
        },
      });
    });
    this.startPolling();
  }

  startPolling() {
    if (this._poll) return;
    this._poll = setInterval(() => {
      if (!this.player?.getCurrentTime) return;
      try {
        this.onProgress?.(this.player.getCurrentTime(), this.player.getDuration());
      } catch {}
    }, 500);
  }

  async play(videoId) {
    await this.mount();
    if (this.videoId !== videoId) {
      this.videoId = videoId;
      this.player.loadVideoById(videoId);
    } else {
      this.player.playVideo();
    }
  }

  pause() { try { this.player?.pauseVideo?.(); } catch {} }
  resume() { try { this.player?.playVideo?.(); } catch {} }
  seek(sec) { this.player?.seekTo?.(sec, true); }
  setVolume(v) { this.player?.setVolume?.(Math.round(Math.max(0, Math.min(1, v)) * 100)); }
  isPlaying() { return this.player?.getPlayerState?.() === 1; }
  getVideoData() { try { return this.player?.getVideoData?.() || null; } catch { return null; } }
  getCurrentTime() { try { return this.player?.getCurrentTime?.() || 0; } catch { return 0; } }
}
