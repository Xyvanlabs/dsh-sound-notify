/**
 * dsh-sound-notify — client half.
 *
 * 浏览器侧负责真正发声：每 600ms 轮询宿主提供的 `/sound-notify/events`
 * 增量接口，拿到「中断」或「正常结束」事件后按配置播放对应音效。
 *
 * 两条播放路径：
 *   1. 内置音效（completed / interrupted / beep）——用 Web Audio 现场合成，
 *      不依赖任何音频文件，装上就能响。
 *   2. 自定义音效——配置里填 http(s) URL、站内路径或 data URI，走 <audio>。
 *
 * 浏览器自动播放策略要求先有用户手势：AudioContext 首次创建时若处于
 * suspended，会在任意一次 pointerdown / keydown 上自动 resume。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sound-notify',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /* 轮询间隔。500ms 是「几乎立刻听见」与「不打爆宿主」的折中：
       turn/end 是用户能感知的交互终点，超过 1s 就有明显滞后感。 */
    var POLL_MS = 600;
    var EVENTS_URL = '/sound-notify/events';
    var BUILTIN = { completed: true, interrupted: true, beep: true };

    /* HMR 或热重载可能重复执行本文件，只允许一条轮询链。 */
    if (window.__soundNotifyBooted === true) {
      module.exports.apply = function () {};
      module.exports.inject = [];
      module.exports.name = 'sound-notify';
      return module.exports;
    }
    window.__soundNotifyBooted = true;

    var audioContext = null;
    var unlocked = false;

    /* 把音频时钟停在挂起状态，等第一次用户手势再开。 */
    function context() {
      if (audioContext !== null) return audioContext;
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (typeof Ctor !== 'function') return null;
      try {
        audioContext = new Ctor();
      } catch (error) {
        audioContext = null;
      }
      return audioContext;
    }

    /* 浏览器闲置时会把 AudioContext 重新挂起，下一次事件就哑了。
       挂一条 0 增益的循环音源把上下文钉在 running 状态。 */
    function keepAlive(ac) {
      if (ac.__soundNotifyKeepAlive === true) return;
      try {
        var frames = Math.max(1, Math.floor(ac.sampleRate * 0.25));
        var source = ac.createBufferSource();
        source.buffer = ac.createBuffer(1, frames, ac.sampleRate);
        source.loop = true;
        var gain = ac.createGain();
        gain.gain.setValueAtTime(0, ac.currentTime);
        source.connect(gain);
        gain.connect(ac.destination);
        source.start(0);
        ac.__soundNotifyKeepAlive = true;
      } catch (error) {
        /* 拿不到就退回「用户手势后才响」的老实行为。 */
      }
    }

    function unlock() {
      var ac = context();
      if (ac === null) return;
      var done = function () {
        unlocked = ac.state === 'running';
        if (unlocked) keepAlive(ac);
      };
      if (ac.state === 'running') {
        unlocked = true;
        keepAlive(ac);
        return;
      }
      /* 不因「曾经解锁过」就跳过：浏览器会在闲置后把上下文重新挂起。 */
      try {
        var promise = ac.resume();
        if (promise !== null && typeof promise.then === 'function') promise.then(done, function () {});
        else done();
      } catch (error) {
        /* 无手势时 resume 会被拒绝，下一个手势再试。 */
      }
    }

    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (type) {
      document.addEventListener(type, unlock, { capture: true, passive: true });
    });

    /* ── 内置音效：全部现场合成 ───────────────────────────────────── */

    /* 单音：起始时间、频率、时长、峰值增益、波形。 */
    function tone(ac, startAt, frequency, duration, peak, type) {
      var osc = ac.createOscillator();
      var gain = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(frequency, startAt);
      /* 5ms 淡入避免爆音；尾部按指数衰减，听起来像「叮」而不是「咔」。 */
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
    }

    var PRESETS = {
      /* 正常结束：C6 → E6 上行两音，明亮、收束感强。 */
      completed: function (ac, at, volume) {
        tone(ac, at, 1046.5, 0.18, 0.3 * volume, 'sine');
        tone(ac, at + 0.13, 1318.5, 0.32, 0.3 * volume, 'sine');
      },
      /* 中断：A4 → E4 下行两音 + 轻微方波，明显更「沉」，一耳可辨。 */
      interrupted: function (ac, at, volume) {
        tone(ac, at, 440.0, 0.16, 0.26 * volume, 'square');
        tone(ac, at + 0.15, 329.6, 0.30, 0.26 * volume, 'square');
      },
      /* 自检用单声。 */
      beep: function (ac, at, volume) {
        tone(ac, at, 880.0, 0.12, 0.25 * volume, 'sine');
      }
    };

    /* ── 自定义音效：<audio> ──────────────────────────────────────── */

    function playFile(source, volume) {
      try {
        var el = new window.Audio(source);
        el.volume = Math.min(1, Math.max(0, volume));
        var promise = el.play();
        if (promise !== null && typeof promise.catch === 'function') {
          promise.catch(function () {});
        }
      } catch (error) {
        /* 资源不可用时静默失败，不影响下一次事件。 */
      }
    }

    /* 单项播放入口：内置名走合成，其余一律当 URL 处理，`none` 无声。
       返回是否真的发出了声音，供回执上报。 */
    function play(sound, volume) {
      if (typeof sound !== 'string' || sound === '' || sound === 'none') return false;
      if (volume <= 0) return false;
      if (BUILTIN[sound] === true) {
        var ac = context();
        if (ac === null) return false;
        var live = ac.state === 'running';
        /* 挂起时先异步 resume，同时照样排音：resume 通常几毫秒内完成，
           排进去的音仍会渲染出来；resume 被拒则自然无声。 */
        if (!live) unlock();
        try {
          PRESETS[sound](ac, ac.currentTime + 0.01, volume);
          return live;
        } catch (error) {
          /* 合成失败不阻断轮询。 */
          return false;
        }
      }
      playFile(sound, volume);
      return true;
    }

    /* 播完给宿主回执：把「浏览器真的执行了播放」变成宿主侧可查的计数，
       这样不依赖肉眼/耳朵也能验证链路。失败无所谓，不影响下一轮。 */
    function ack(event, played) {
      var ac = audioContext;
      var body = JSON.stringify({
        seq: typeof event.seq === 'number' ? event.seq : null,
        scene: typeof event.scene === 'string' ? event.scene : null,
        sound: typeof event.sound === 'string' ? event.sound : null,
        audioState: ac === null ? 'no-audio-context' : ac.state,
        played: played === true,
      });
      try {
        window.fetch('/sound-notify/ack', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: body,
        }).catch(function () {});
      } catch (error) {
        /* 回执是辅助通道，丢了就丢了。 */
      }
    }

    /* ── 事件轮询 ─────────────────────────────────────────────────── */

    function apply() {
      var since = -1;
      var timer = null;
      var stopped = false;

      function schedule() {
        if (stopped) return;
        timer = window.setTimeout(tick, POLL_MS);
      }

      function tick() {
        if (stopped) return;
        var url = EVENTS_URL + '?since=' + String(since);
        var options = { method: 'GET', cache: 'no-store', credentials: 'same-origin' };
        var request;
        try {
          request = window.fetch(url, options);
        } catch (error) {
          schedule();
          return;
        }
        request
          .then(function (response) {
            if (!response.ok) return null;
            return response.json();
          })
          .then(function (payload) {
            if (payload === null || payload === undefined || payload.ok !== true) return;
            /* 同一批里若有多个事件，按 seq 顺序播，后到的被前一个自然稀释。 */
            var events = Array.isArray(payload.events) ? payload.events : [];
            for (var i = 0; i < events.length; i += 1) {
              var event = events[i];
              if (typeof event.seq === 'number') since = event.seq;
              if (event.muted === true) continue;
              var ok = play(event.sound, typeof event.volume === 'number' ? event.volume : 1);
              ack(event, ok);
            }
            var latest = typeof payload.seq === 'number' ? payload.seq : since;
            /* 宿主插件热重载后 seq 会跳回小值，游标必须跟着回退，
               否则之后的新事件永远小于游标，被静默丢弃。 */
            if (typeof payload.seq === 'number' && payload.seq < since) since = payload.seq;
            /* 首次连接从这里对齐游标，避免刷新页面把历史事件重放一遍。 */
            if (latest > since) since = latest;
          })
          .catch(function () {
            /* 宿主重启期间的连接失败属于常态，下一轮继续。 */
          })
          .then(schedule, schedule);
      }

      /* 页面从后台回到前台时立即补一次，缩短「切回来才响」的延迟。 */
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && timer !== null) {
          window.clearTimeout(timer);
          timer = null;
          tick();
        }
      });

      window.addEventListener('pagehide', function () {
        stopped = true;
        if (timer !== null) window.clearTimeout(timer);
      });

      tick();
    }

    module.exports.apply = apply;
    module.exports.inject = [];
    module.exports.name = 'sound-notify';
    return module.exports;
  }
});
