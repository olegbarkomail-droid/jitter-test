'use strict';
/* ============================================================
   app.js — Джиттер-тест PWA
   Senior Frontend Developer + DSP Expert Implementation
   ============================================================ */

// ============================================================
// 1. КОНФИГУРАЦИЯ ПО УМОЛЧАНИЮ
// ============================================================
const DEFAULT_CONFIG = {
  // METRONOME_THRESHOLD убран: метроном звучит только в наушниках,
  // в микрофон не попадает — пороговая логика для него не нужна.
  STICK_THRESHOLD:     0.12, // Порог палочки (0–1). Удары выше порога = удар.
  MIN_PEAK_DISTANCE_MS: 300, // Резервный параметр (не используется в новом анализе).
  SEARCH_WINDOW_MS:    200,  // Окно поиска палочки: ±200 мс от расчётного удара.
  EXCLUDE_ZONE_MS:      15,  // Резервный параметр.
  DURATION_SEC:         60,  // Длительность записи по умолчанию (сек).
  BPM:                  60,  // Темп метронома. Фиксированный шаг 10, диапазон 30–120.
};

// Ограничения метронома (фиксированная сетка значений)
const BPM_MIN  = 30;
const BPM_MAX  = 120;
const BPM_STEP = 10;

// ============================================================
// 2. ГЛОБАЛЬНОЕ СОСТОЯНИЕ
// ============================================================
const state = {
  profile:       null,
  config:        { ...DEFAULT_CONFIG },
  currentSession: null,
  recording:     false,
  mediaRecorder: null,
  audioChunks:   [],
  timerInterval: null,
  elapsed:       0,
  autoStopTimer: null,
  gridOffsetMs:  100, // смещение первого удара метронома от старта записи (мс)
};

// ============================================================
// 3. DOM-УТИЛИТЫ
// ============================================================
const $  = (sel)       => document.querySelector(sel);
const $$ = (sel)       => document.querySelectorAll(sel);
const el = (id)        => document.getElementById(id);

function show(id) { const e = el(id); if (e) e.style.display = ''; }
function hide(id) { const e = el(id); if (e) e.style.display = 'none'; }
function setText(id, text) { const e = el(id); if (e) e.textContent = text; }

function toast(msg, type = 'info') {
  const t = el('toast');
  t.textContent = msg;
  t.className = `toast toast-${type} show`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ============================================================
// 4. ХРАНИЛИЩЕ (localStorage)
// ============================================================
const SK = {
  PROFILE: 'jitter_profile',
  HISTORY: 'jitter_history',
  BEFORE:  'jitter_before',
  AFTER:   'jitter_after',
  CONFIG:  'jitter_config',
};

const storage = {
  get:  (key) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } },
  set:  (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { toast('Ошибка сохранения: ' + e.message, 'error'); } },
  del:  (key) => { localStorage.removeItem(key); },
};

function loadProfile()  { return storage.get(SK.PROFILE); }
function saveProfile(p) { storage.set(SK.PROFILE, p); }

function loadHistory()  { return storage.get(SK.HISTORY) || []; }
function addToHistory(session) {
  const hist = loadHistory();
  hist.unshift(session);
  if (hist.length > 100) hist.pop();
  storage.set(SK.HISTORY, hist);
}
function clearHistory() { storage.del(SK.HISTORY); storage.del(SK.BEFORE); storage.del(SK.AFTER); }

// ============================================================
// 5. DSP — ЦИФРОВАЯ ОБРАБОТКА СИГНАЛОВ
// ============================================================

/**
 * computeEnvelope — вычисляет огибающую аудиосигнала.
 *
 * Огибающая = сглаженные абсолютные значения сигнала.
 * Она показывает «громкость» в каждый момент времени,
 * не зависит от знака волны (+ или −).
 *
 * Используем скользящее среднее с O(n) сложностью:
 *   sliding_sum[i] = sum(|x[i-half]|...| x[i+half]|) / window_size
 *
 * @param {Float32Array} samples    — сырые аудиосэмплы (от −1 до +1)
 * @param {number}       windowSize — ширина окна сглаживания в сэмплах
 * @returns {Float32Array}          — огибающая (только положительные значения)
 */
function computeEnvelope(samples, windowSize) {
  const n = samples.length;
  const env = new Float32Array(n);
  const half = Math.floor(windowSize / 2);
  let sum = 0;

  // Заполняем начальное окно (первые half сэмплов)
  for (let i = 0; i < Math.min(half, n); i++) {
    sum += Math.abs(samples[i]);
  }

  for (let i = 0; i < n; i++) {
    // Добавляем правый край скользящего окна
    const rEdge = i + half;
    if (rEdge < n) sum += Math.abs(samples[rEdge]);

    // Убираем левый край скользящего окна
    const lEdge = i - half - 1;
    if (lEdge >= 0) sum -= Math.abs(samples[lEdge]);

    // Нормируем на реальный размер окна (у краёв массива окно уже)
    const effectiveSize = Math.min(rEdge + 1, n) - Math.max(0, i - half);
    env[i] = sum / effectiveSize;
  }

  return env;
}

/**
 * findPeaks — находит локальные максимумы в огибающей выше заданного порога.
 *
 * Алгоритм (один проход слева направо):
 *   1. Сканируем до момента, когда envelope[i] > threshold.
 *   2. Вошли в «событие» (трансиент): идём вперёд, ищем максимум,
 *      пока сигнал остаётся > threshold * 0.5 (хвост затухания).
 *   3. Максимум этого события = один пик. Записываем его.
 *   4. Прыгаем вперёд на minDistanceSamples, чтобы не поймать
 *      эхо или рядом стоящий призрачный пик.
 *
 * Почему не простой «локальный максимум»?
 *   Звуковой трансиент имеет быстрый фронт нарастания и медленный спад.
 *   Подход через «событие» надёжнее работает с реальным аудио,
 *   где много мелких пиков на хвосте одного удара.
 *
 * @param {Float32Array} env            — огибающая сигнала
 * @param {number}       sampleRate     — частота дискретизации
 * @param {number}       threshold      — минимальная амплитуда пика (0–1)
 * @param {number}       minDistanceMs  — мин. расстояние между пиками (мс)
 * @returns {Array<{index, amplitude, timeMs}>}
 */
function findPeaks(env, sampleRate, threshold, minDistanceMs) {
  const minGap = Math.round((minDistanceMs / 1000) * sampleRate);
  const peaks  = [];
  let i = 0;

  while (i < env.length) {
    if (env[i] <= threshold) { i++; continue; }

    // ── Вошли в событие: ищем локальный максимум ──────────
    let peakAmp = env[i];
    let peakIdx = i;
    let j = i + 1;

    // Идём вперёд пока сигнал ещё в «теле» трансиента
    while (j < env.length && env[j] > threshold * 0.5) {
      if (env[j] > peakAmp) {
        peakAmp = env[j];
        peakIdx = j;
      }
      j++;
    }

    peaks.push({
      index:     peakIdx,
      amplitude: peakAmp,
      timeMs:    (peakIdx / sampleRate) * 1000,
    });

    // Пропускаем minGap от найденного пика (защита от двойного счёта)
    i = peakIdx + minGap;
  }

  return peaks;
}

/**
 * analyzeAudio — ГЛАВНАЯ ФУНКЦИЯ АНАЛИЗА (режим «метроном в наушники»).
 *
 * Метроном звучит только в наушниках → в микрофон не попадает.
 * Эталонная сетка строится математически по BPM и смещению первого удара.
 *
 * Схема работы:
 *   [AudioBuffer]  — только удары палочки, без метронома
 *       │
 *       ▼
 *   computeEnvelope()          — сглаженная огибающая |x(t)|
 *       │
 *       ▼
 *   BPM-сетка:                 — расчётные моменты идеального удара
 *     beat_N = gridOffsetMs + N × (60000/bpm)
 *       │
 *       ▼  для каждого узла сетки:
 *   поиск пика палочки в окне ±SEARCH_WINDOW_MS
 *       │
 *       ▼
 *   jitter = t(палочка) − t(beat_N)
 *       < 0 → опережение (палочка раньше метронома)
 *       > 0 → запаздывание (палочка позже метронома)
 *
 * @param {AudioBuffer} audioBuffer   — декодированный буфер
 * @param {object}      config        — параметры (STICK_THRESHOLD, SEARCH_WINDOW_MS)
 * @param {number}      gridOffsetMs  — смещение первого удара от начала записи (мс)
 * @param {number}      bpm           — темп метронома (уд/мин)
 * @returns {Array<BeatResult>}
 */
function analyzeAudio(audioBuffer, config, gridOffsetMs, bpm) {
  const sampleRate  = audioBuffer.sampleRate;
  const durationMs  = audioBuffer.duration * 1000;

  // Берём первый канал
  const samples = audioBuffer.getChannelData(0);

  // ── ШАГ 1: Огибающая (сглаживание ~2 мс) ─────────────────
  const smoothWin = Math.max(1, Math.round(sampleRate * 0.002));
  const envelope  = computeEnvelope(samples, smoothWin);

  // ── ШАГ 2: Математическая сетка BPM ──────────────────────
  //   Первый удар = gridOffsetMs от начала записи.
  //   Следующие: +beatIntervalMs каждый.
  const beatIntervalMs = 60000 / Math.max(1, bpm);
  const results        = [];
  let beatNum          = 0;
  let beatMs           = gridOffsetMs;   // начальное смещение (~100 мс)

  // ── ШАГ 3: Поиск удара палочки вблизи каждого узла сетки ─
  while (beatMs - config.SEARCH_WINDOW_MS < durationMs) {
    beatNum++;

    const winStartMs = beatMs - config.SEARCH_WINDOW_MS;
    const winEndMs   = beatMs + config.SEARCH_WINDOW_MS;

    // Пропускаем узлы, чьё окно целиком вне записи
    if (winEndMs >= 0 && winStartMs <= durationMs) {

      const winStart = Math.max(0,
        Math.round((Math.max(0, winStartMs) / 1000) * sampleRate));
      const winEnd   = Math.min(envelope.length - 1,
        Math.round((Math.min(durationMs, winEndMs) / 1000) * sampleRate));

      // Ищем самый сильный трансиент выше STICK_THRESHOLD в окне
      let bestAmp = -1;
      let bestIdx = -1;
      let k = winStart;

      while (k <= winEnd) {
        if (envelope[k] > config.STICK_THRESHOLD) {
          // Вошли в трансиент — ищем его пик
          let eventAmp = envelope[k];
          let eventIdx = k;
          let j = k + 1;

          while (j <= winEnd && envelope[j] > config.STICK_THRESHOLD * 0.5) {
            if (envelope[j] > eventAmp) {
              eventAmp = envelope[j];
              eventIdx = j;
            }
            j++;
          }

          if (eventAmp > bestAmp) {
            bestAmp = eventAmp;
            bestIdx = eventIdx;
          }
          k = j;
        } else {
          k++;
        }
      }

      // Пик найден → записываем результат
      if (bestIdx !== -1) {
        const stickMs  = (bestIdx / sampleRate) * 1000;
        // jitter со знаком: < 0 = опережение, > 0 = запаздывание
        const jitterMs = stickMs - beatMs;

        results.push({
          beatNum,
          metronomeTimeMs:    Math.round(beatMs),   // расчётный момент
          stickTimeMs:        Math.round(stickMs),  // реальный удар
          jitterMs:           Math.round(jitterMs),
          metronomeAmplitude: 0,                    // н/п: метроном в наушниках
          stickAmplitude:     bestAmp,
        });
      }
      // Нет пика → MISS; в results не попадает (виден как пропуск на графике)
    }

    beatMs += beatIntervalMs;
  }

  return results;
}

/**
 * computeStats — вычисляет итоговую статистику по набору результатов.
 *
 * Ключевой момент: используем MAD (Mean Absolute Deviation),
 * а НЕ обычное среднее, потому что +50мс и −50мс при обычном
 * среднем дадут 0, хотя реальная точность низкая.
 *
 * @param {Array} results — массив BeatResult из analyzeAudio()
 * @returns {object} статистика
 */
function computeStats(results) {
  if (!results || results.length === 0) return null;

  const jitters    = results.map(r => r.jitterMs);
  const absJitters = jitters.map(Math.abs);
  const n          = jitters.length;

  // MAD — среднее абсолютное отклонение (основная метрика)
  const mad = absJitters.reduce((a, b) => a + b, 0) / n;

  // Среднее со знаком (показывает систематическое смещение:
  // постоянно опережаете или запаздываете?)
  const meanSigned = jitters.reduce((a, b) => a + b, 0) / n;

  // Стандартное отклонение (разброс)
  const variance = jitters.reduce((acc, j) => acc + (j - meanSigned) ** 2, 0) / n;
  const stdDev   = Math.sqrt(variance);

  // Диапазон
  const minAbs = Math.min(...absJitters);
  const maxAbs = Math.max(...absJitters);

  // Процент попаданий в ключевые диапазоны
  const under20  = absJitters.filter(v => v < 20).length;
  const under50  = absJitters.filter(v => v < 50).length;
  const under100 = absJitters.filter(v => v < 100).length;

  return {
    count:          n,
    mad:            Math.round(mad * 10) / 10,
    meanSigned:     Math.round(meanSigned * 10) / 10,
    stdDev:         Math.round(stdDev * 10) / 10,
    minAbs,
    maxAbs,
    percentUnder20:  Math.round((under20  / n) * 100),
    percentUnder50:  Math.round((under50  / n) * 100),
    percentUnder100: Math.round((under100 / n) * 100),
    level:           getLevel(mad),
  };
}

function getLevel(mad) {
  if (mad < 20)  return { label: '🏆 Элитный',  color: '#22c55e', desc: 'Профессиональный уровень' };
  if (mad < 50)  return { label: '🥇 Отличный', color: '#84cc16', desc: 'Выше среднего' };
  if (mad < 100) return { label: '✅ Норма',     color: '#eab308', desc: 'Типичный человеческий диапазон' };
  if (mad < 150) return { label: '📈 Базовый',  color: '#f97316', desc: 'Есть над чем работать' };
  return                 { label: '🔰 Начальный',color: '#ef4444', desc: 'Требуется тренировка' };
}

// ============================================================
// 5b. МЕТРОНОМ — синтез механического «тик» через Web Audio API
// ============================================================
//
// Метроном служит ЭТАЛОННЫМ сигналом: во время записи он звучит через
// динамик, микрофон ловит его щелчки (самые громкие пики), а пользователь
// бьёт палочкой в такт. Так появляется фиксированная опорная сетка,
// относительно которой считается джиттер.
//
// Звук синтезируется на лету (без аудиофайлов) — это сохраняет полностью
// оффлайновую работу PWA. «Механический» тембр собирается из двух
// компонентов с очень быстрым затуханием (имитация щелчка рычага +
// резонанс деревянного корпуса классического метронома).
//
// Тайминг реализован по паттерну «lookahead scheduler» (A. Wittel):
// setInterval будит планировщик каждые 25 мс, а сами щелчки ставятся
// в очередь точного аппаратного таймера AudioContext на 100 мс вперёд.
// Это даёт стабильный ритм без «плавания», в отличие от простого setInterval.

const metronome = {
  ctx:           null,   // AudioContext (создаётся при первом запуске)
  isPlaying:     false,
  bpm:           60,
  nextNoteTime:  0,      // время следующего щелчка в часах AudioContext (сек)
  lookahead:     25,     // мс — период пробуждения планировщика
  scheduleAhead: 0.10,   // с — горизонт планирования щелчков вперёд
  timerId:       null,
  volume:        0.9,    // громкость метронома (0–1)
};

/** Создаёт (или возобновляет) AudioContext. Должно вызываться из жеста пользователя. */
function ensureAudioCtx() {
  // Контекст мог быть закрыт системой при смене BT-устройства — сбрасываем
  if (metronome.ctx && metronome.ctx.state === 'closed') {
    metronome.ctx = null;
  }
  if (!metronome.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    metronome.ctx = new AC();
    // При смене аудиомаршрута (BT connect/disconnect, звонок и т.п.)
    // Android переводит контекст в 'suspended' — автоматически возобновляем.
    metronome.ctx.onstatechange = () => {
      if (metronome.ctx && metronome.ctx.state === 'suspended') {
        metronome.ctx.resume().catch(() => {});
      }
    };
  }
  // На мобильных контекст стартует «suspended» — будим его
  if (metronome.ctx.state === 'suspended') metronome.ctx.resume();
  return metronome.ctx;
}

/**
 * scheduleClick — ставит в очередь ОДИН механический щелчок на момент `time`.
 *
 * Тембр = сумма двух осцилляторов с независимыми огибающими:
 *   1) Высокий «клик» рычага   — square 3200 Гц, спад ~30 мс
 *   2) Низкий «корпус» короба  — triangle 900 Гц, спад ~55 мс
 * Плюс общий полосовой фильтр слегка «деревянит» звук.
 *
 * Огибающие строятся на аппаратных рампах AudioParam — они сэмпл-точны
 * и не зависят от загрузки основного JS-потока.
 *
 * @param {number} time — абсолютное время старта в часах AudioContext (сек)
 */
function scheduleClick(time) {
  const ctx = metronome.ctx;

  // Общий выход щелчка с лёгким полосовым окрасом
  const master = ctx.createGain();
  master.gain.value = metronome.volume;

  const shaper = ctx.createBiquadFilter();
  shaper.type = 'bandpass';
  shaper.frequency.value = 1800;
  shaper.Q.value = 0.7;

  master.connect(shaper);
  shaper.connect(ctx.destination);

  // ── Компонент 1: высокочастотный щелчок рычага ──
  const o1 = ctx.createOscillator();
  o1.type = 'square';
  o1.frequency.value = 3200;
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0.0001, time);
  g1.gain.exponentialRampToValueAtTime(0.9,   time + 0.001); // мгновенная атака
  g1.gain.exponentialRampToValueAtTime(0.0001, time + 0.030); // быстрый спад
  o1.connect(g1); g1.connect(master);

  // ── Компонент 2: низкий корпусной резонанс ──
  const o2 = ctx.createOscillator();
  o2.type = 'triangle';
  o2.frequency.value = 900;
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.0001, time);
  g2.gain.exponentialRampToValueAtTime(0.55,  time + 0.002);
  g2.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);
  o2.connect(g2); g2.connect(master);

  // Запуск и остановка (короткая жизнь узлов — авто-сборка мусора)
  o1.start(time); o1.stop(time + 0.07);
  o2.start(time); o2.stop(time + 0.07);
}

/** Планировщик: ставит в очередь все щелчки, попадающие в горизонт scheduleAhead. */
function metronomeScheduler() {
  const ctx = metronome.ctx;
  const secondsPerBeat = 60.0 / metronome.bpm; // интервал между щелчками

  while (metronome.nextNoteTime < ctx.currentTime + metronome.scheduleAhead) {
    scheduleClick(metronome.nextNoteTime);

    // Визуальная вспышка индикатора синхронно со щелчком
    const delayMs = (metronome.nextNoteTime - ctx.currentTime) * 1000;
    setTimeout(flashBeat, Math.max(0, delayMs));

    metronome.nextNoteTime += secondsPerBeat;
  }
}

function startMetronome() {
  if (metronome.isPlaying) return;
  const ctx = ensureAudioCtx();
  metronome.isPlaying    = true;
  metronome.bpm          = state.config.BPM || 60;
  metronome.nextNoteTime = ctx.currentTime + 0.10; // небольшой запас на старт
  metronome.timerId      = setInterval(metronomeScheduler, metronome.lookahead);
  updateMetronomeUI(true);
}

function stopMetronome() {
  if (!metronome.isPlaying) return;
  metronome.isPlaying = false;
  clearInterval(metronome.timerId);
  metronome.timerId = null;
  updateMetronomeUI(false);
}

function toggleMetronome() {
  if (metronome.isPlaying) stopMetronome();
  else startMetronome();
}

/** Меняет BPM по фиксированной сетке (шаг 10, диапазон 30–120). */
function changeBpm(delta) {
  let bpm = (state.config.BPM || 60) + delta;
  bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, bpm));
  state.config.BPM = bpm;
  metronome.bpm    = bpm; // применяется на лету, даже если метроном играет
  storage.set(SK.CONFIG, state.config);
  updateBpmUI();
}

function updateBpmUI() {
  const bpm = state.config.BPM || 60;
  const v = el('bpm-value');
  if (v) v.textContent = bpm;
  const minus = el('bpm-minus');
  const plus  = el('bpm-plus');
  if (minus) minus.disabled = bpm <= BPM_MIN;
  if (plus)  plus.disabled  = bpm >= BPM_MAX;
}

function updateMetronomeUI(isPlaying) {
  const btn = el('metronome-btn');
  if (btn) {
    btn.textContent = isPlaying ? '⏸ Стоп метроном' : '▶ Метроном';
    btn.classList.toggle('active', isPlaying);
  }
  // Кнопки смены темпа блокируем во время записи, но не при простой практике
  if (!isPlaying) {
    const dot = el('beat-indicator');
    if (dot) dot.classList.remove('flash');
  }
}

/** Короткая визуальная вспышка индикатора доли. */
function flashBeat() {
  const dot = el('beat-indicator');
  if (!dot) return;
  dot.classList.remove('flash');
  // reflow для перезапуска CSS-анимации
  void dot.offsetWidth;
  dot.classList.add('flash');
}

// ============================================================
// 5c. КАЛИБРОВКА ПОРОГОВ — живой VU-метр + авто-подбор
// ============================================================
//
// Самая сложная часть работы с сырым звуком — «поймать» пороги: где
// заканчивается шум, где удары палочки, а где громкие щелчки метронома.
// Этот блок даёт визуальный помощник:
//
//   • Живой вертикальный столб уровня (VU-метр). Он показывает ту же
//     величину, что используется в анализе — сглаженную огибающую |x|
//     (окно ~2 мс), поэтому высота пиков в метре напрямую соответствует
//     порогам METRONOME_THRESHOLD / STICK_THRESHOLD (шкала 0…1).
//   • Два перетаскиваемых ползунка: 🔴 метроном, 🟡 палочка. Тянем прямо
//     на столбе — пороги применяются и сохраняются на лету, слайдеры выше
//     синхронизируются.
//   • Авто-калибровка: ~9 сек слушаем метроном + удары, ловим дискретные
//     события, кластеризуем их амплитуды на 2 группы (палочка/метроном)
//     методом k-средних и предлагаем пороги автоматически.

const METER_MAX = 1.0; // верх шкалы = уровень 1.0 (совпадает с диапазоном порогов)

const calib = {
  active:      false,
  stream:      null,
  ctx:         null,
  analyser:    null,
  buf:         null,
  raf:         null,
  smoothWin:   1,
  level:       0,     // отображаемый уровень (быстрая атака, медленный спад)
  peakHold:    0,
  // авто-режим
  auto:        false,
  autoEndT:    0,
  autoDur:     9000,  // мс сбора данных
  floorSamples:[],    // оценка шумового пола (первые ~800 мс)
  floorUntil:  0,
  noiseFloor:  0.01,
  inEvent:     false,
  curEventPeak:0,
  lastEventT:  0,
  events:      [],    // амплитуды обнаруженных ударов
  dragging:    null,  // 'metro' | 'stick' | null
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Пересчитывает позицию ползунка и зон по текущему порогу палочки. */
function syncCalibHandles() {
  const stick = clamp(state.config.STICK_THRESHOLD, 0.03, 0.50);
  const stickPct = (stick / METER_MAX) * 100;

  const hs = el('calib-handle-stick');
  if (hs) hs.style.bottom = stickPct + '%';

  setText('calib-tag-stick',    stick.toFixed(2));
  setText('calib-legend-stick', stick.toFixed(2));
  setText('calib-legend-noise', stick.toFixed(2));

  const zones = el('calib-zones');
  if (zones) {
    const s = stickPct;
    // Снизу вверх: серая (шум) → жёлтая (удары палочки)
    zones.style.background =
      `linear-gradient(to top,` +
      ` var(--text-muted) 0%, var(--text-muted) ${s}%,` +
      ` var(--yellow) ${s}%, var(--yellow) 100%)`;
  }
}

/** Применяет порог палочки из калибровки: обновляет config, слайдер и ползунок. */
function applyThreshold(stick) {
  stick = clamp(stick, 0.03, 0.50);
  state.config.STICK_THRESHOLD = Math.round(stick * 100) / 100;
  storage.set(SK.CONFIG, state.config);

  // Синхронизируем слайдер «Параметры анализа»
  const ss = el('cfg-stick-thresh');
  if (ss) { ss.value = state.config.STICK_THRESHOLD; setText('cfg-stick-thresh-val', state.config.STICK_THRESHOLD.toFixed(2)); }

  syncCalibHandles();
}

/**
 * framePeak — максимум сглаженной огибающей |x| в текущем кадре.
 * Повторяет логику computeEnvelope (скользящее среднее |x|), чтобы
 * значение в метре совпадало с тем, что видит analyzeAudio().
 */
function framePeak() {
  const buf = calib.buf;
  const n   = buf.length;
  const w   = calib.smoothWin;
  let sum = 0, peak = 0;
  // Инициализируем окно
  for (let i = 0; i < Math.min(w, n); i++) sum += Math.abs(buf[i]);
  for (let i = 0; i < n; i++) {
    const r = i + w;
    if (r < n) sum += Math.abs(buf[r]);
    const l = i - 1;
    if (l >= 0) sum -= Math.abs(buf[l]);
    const eff = Math.min(r, n) - Math.max(0, i);
    const v = sum / eff;
    if (v > peak) peak = v;
  }
  return peak;
}

/** Главный цикл отрисовки метра (requestAnimationFrame). */
function calibLoop() {
  if (!calib.active) return;
  calib.analyser.getFloatTimeDomainData(calib.buf);
  const fp = framePeak();
  const now = performance.now();

  // Уровень: мгновенная атака, плавный спад
  calib.level    = Math.max(fp, calib.level * 0.88);
  calib.peakHold = Math.max(fp, calib.peakHold * 0.985);

  // Отрисовка
  const lvlPct  = clamp(calib.level    / METER_MAX, 0, 1) * 100;
  const peakPct = clamp(calib.peakHold / METER_MAX, 0, 1) * 100;
  const fill = el('calib-fill'), peakEl = el('calib-peak');
  if (fill)   fill.style.height = lvlPct + '%';
  if (peakEl) peakEl.style.bottom = peakPct + '%';
  setText('calib-live', calib.level.toFixed(3));

  // Авто-калибровка: оценка шума + детекция дискретных ударов
  if (calib.auto) {
    if (now < calib.floorUntil) {
      calib.floorSamples.push(fp);
    } else if (calib.floorSamples.length && calib.noiseFloor === 0.01) {
      // Фиксируем шумовой пол один раз: медиана стартовых кадров
      const s = calib.floorSamples.slice().sort((a, b) => a - b);
      calib.noiseFloor = Math.max(0.005, s[Math.floor(s.length / 2)]);
    }

    const evThresh = Math.max(0.03, calib.noiseFloor * 3);
    if (!calib.inEvent) {
      if (fp > evThresh && (now - calib.lastEventT) > 90) {
        calib.inEvent = true;
        calib.curEventPeak = fp;
      }
    } else {
      if (fp > calib.curEventPeak) calib.curEventPeak = fp;
      if (fp < evThresh * 0.6) {
        calib.events.push(calib.curEventPeak);
        calib.inEvent = false;
        calib.lastEventT = now;
      }
    }

    // Прогресс
    const left = Math.max(0, Math.ceil((calib.autoEndT - now) / 1000));
    setText('calib-auto-status', `Слушаю… ${left} с · ударов: ${calib.events.length}`);

    if (now >= calib.autoEndT) {
      finishAutoCalibration();
    }
  }

  calib.raf = requestAnimationFrame(calibLoop);
}

/** Запуск живого метра (запрашивает микрофон). */
async function startCalibration() {
  if (calib.active) return;
  if (state.recording) { toast('Остановите запись перед калибровкой', 'error'); return; }
  try {
    const constraints = { audio: {
      echoCancellation: false, noiseSuppression: false,
      autoGainControl: false, channelCount: 1,
    }};
    calib.stream = await navigator.mediaDevices.getUserMedia(constraints);
    const AC = window.AudioContext || window.webkitAudioContext;
    calib.ctx = new AC();
    if (calib.ctx.state === 'suspended') await calib.ctx.resume();

    calib.smoothWin = Math.max(1, Math.round(calib.ctx.sampleRate * 0.002));
    const src = calib.ctx.createMediaStreamSource(calib.stream);
    calib.analyser = calib.ctx.createAnalyser();
    calib.analyser.fftSize = 2048;
    calib.buf = new Float32Array(calib.analyser.fftSize);
    src.connect(calib.analyser); // анализатор НЕ подключаем к destination (без петли)

    calib.active   = true;
    calib.level    = 0;
    calib.peakHold = 0;

    // Метроном как эталон, чтобы пользователь слышал такт.
    // startMetronome — noop если уже играет; без него Android убивает аудио-сессию.
    if (!metronome.isPlaying) startMetronome();

    const btn = el('calib-btn');
    if (btn) { btn.textContent = '⏹ Остановить настройку'; btn.classList.add('active'); }
    calib.raf = requestAnimationFrame(calibLoop);
  } catch (err) {
    toast(`Не удалось открыть микрофон: ${err.message}`, 'error');
  }
}

/** Остановка живого метра и освобождение ресурсов. */
function stopCalibration() {
  if (!calib.active) return;
  calib.active = false;
  calib.auto   = false;
  if (calib.raf) cancelAnimationFrame(calib.raf);
  calib.raf = null;
  if (calib.stream) calib.stream.getTracks().forEach(t => t.stop());
  if (calib.ctx)    calib.ctx.close().catch(() => {});
  calib.stream = calib.ctx = calib.analyser = calib.buf = null;
  // Метроном НЕ останавливаем — пользователь управляет им сам через ▶/⏸.

  const btn = el('calib-btn');
  if (btn) { btn.textContent = '🎧 Начать настройку'; btn.classList.remove('active'); }
  const auto = el('calib-auto-btn');
  if (auto) auto.disabled = false;

  const fill = el('calib-fill'), peakEl = el('calib-peak');
  if (fill)   fill.style.height = '0%';
  if (peakEl) peakEl.style.bottom = '0%';
  setText('calib-live', '0.00');
}

function toggleCalibration() {
  if (calib.active) stopCalibration();
  else startCalibration();
}

/** Запуск авто-калибровки: собирает события в течение autoDur мс. */
async function startAutoCalibration() {
  if (!calib.active) await startCalibration();
  if (!calib.active) return; // не удалось открыть микрофон

  calib.auto         = true;
  calib.events       = [];
  calib.floorSamples = [];
  calib.noiseFloor   = 0.01;
  calib.inEvent      = false;
  calib.curEventPeak = 0;
  calib.lastEventT   = 0;
  const now          = performance.now();
  calib.floorUntil   = now + 800;   // первые 0.8 с — оценка шума
  calib.autoEndT     = now + calib.autoDur;

  const btn = el('calib-auto-btn');
  if (btn) btn.disabled = true;
  setText('calib-auto-status', 'Слушаю… стучите палочкой в такт метроному');
}

/** 1D k-means (k=2): делит амплитуды на «палочку» (низ) и «метроном» (верх). */
function kmeans2(vals) {
  const sorted = vals.slice().sort((a, b) => a - b);
  let c1 = sorted[0], c2 = sorted[sorted.length - 1];
  let g1 = [], g2 = [];
  for (let it = 0; it < 25; it++) {
    g1 = []; g2 = [];
    for (const v of sorted) (Math.abs(v - c1) <= Math.abs(v - c2) ? g1 : g2).push(v);
    if (!g1.length || !g2.length) break;
    const n1 = g1.reduce((a, b) => a + b, 0) / g1.length;
    const n2 = g2.reduce((a, b) => a + b, 0) / g2.length;
    if (n1 === c1 && n2 === c2) break;
    c1 = n1; c2 = n2;
  }
  if (!g1.length || !g2.length) return null;
  return {
    lowMean:  c1, highMean: c2,
    lowMax:   Math.max(...g1), highMin: Math.min(...g2),
    lowN:     g1.length, highN: g2.length,
  };
}

/** Завершение авто-калибровки: подбор порога палочки по медиане амплитуд. */
function finishAutoCalibration() {
  calib.auto = false;
  const btn = el('calib-auto-btn');
  if (btn) btn.disabled = false;

  const ev = calib.events;
  if (ev.length < 3) {
    setText('calib-auto-status', `Мало данных (${ev.length}). Стучите сильнее и повторите.`);
    toast('Недостаточно ударов для авто-калибровки', 'error');
    return;
  }

  // Медиана амплитуд ударов палочки
  const sorted    = ev.slice().sort((a, b) => a - b);
  const medianHit = sorted[Math.floor(sorted.length / 2)];

  // Порог: между шумовым полом и медианным ударом
  const stick = Math.max(calib.noiseFloor * 2, medianHit * 0.4);

  applyThreshold(stick);

  setText('calib-auto-status',
    `✓ Готово · ${ev.length} ударов · порог палочки ${state.config.STICK_THRESHOLD.toFixed(2)}`);
  toast('Порог палочки подобран автоматически ✓', 'success');
}

/** Перетаскивание ползунков порогов по столбу. */
function initCalibDrag() {
  const meter = el('calib-meter');
  if (!meter) return;

  const valueFromEvent = (clientY) => {
    const rect = meter.getBoundingClientRect();
    const fromBottom = rect.bottom - clientY;         // px от низа
    const pct = clamp(fromBottom / rect.height, 0, 1); // 0..1
    return pct * METER_MAX;
  };

  const onMove = (clientY) => {
    if (!calib.dragging) return;
    const v = valueFromEvent(clientY);
    applyThreshold(v);
  };

  const startDrag = (e) => {
    calib.dragging = 'stick';
    e.preventDefault();
  };

  const hs = el('calib-handle-stick');
  if (hs) {
    hs.addEventListener('mousedown',  startDrag);
    hs.addEventListener('touchstart', startDrag, { passive: false });
  }

  window.addEventListener('mousemove', (e) => onMove(e.clientY));
  window.addEventListener('touchmove', (e) => {
    if (calib.dragging && e.touches[0]) { onMove(e.touches[0].clientY); e.preventDefault(); }
  }, { passive: false });
  window.addEventListener('mouseup',   () => { calib.dragging = null; });
  window.addEventListener('touchend',  () => { calib.dragging = null; });
}

// ============================================================
// 6. ЗАПИСЬ АУДИО
// ============================================================

async function startRecording() {
  if (state.recording) return;

  // Калибровка занимает микрофон — останавливаем её перед записью
  if (calib.active) stopCalibration();

  // Принудительно отключаем все DSP-обработки браузера —
  // они исказят амплитуды ударов и сломают поиск пиков
  const constraints = {
    audio: {
      echoCancellation:  false,
      noiseSuppression:  false,
      autoGainControl:   false,
      channelCount:      1,
    }
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    // Выбираем лучший доступный формат записи
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      '',
    ];
    const mimeType = mimeTypes.find(m => !m || MediaRecorder.isTypeSupported(m)) || '';

    state.audioChunks  = [];
    state.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.audioChunks.push(e.data);
    };

    state.mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      processRecording();
    };

    // Запускаем метроном ДО старта записи — чтобы захватить точное смещение первого удара.
    // Метроном звучит только в наушниках; в микрофон не попадает.
    startMetronome();

    // Фиксируем смещение первого удара метронома от текущего момента (мс).
    // nextNoteTime — время следующего запланированного щелчка (в секундах AudioContext).
    state.gridOffsetMs = (metronome.ctx && metronome.nextNoteTime > metronome.ctx.currentTime)
      ? Math.round((metronome.nextNoteTime - metronome.ctx.currentTime) * 1000)
      : 100;

    lockBpmControls(true);

    // Собираем чанки каждые 100 мс для надёжности; запись начинается синхронно после метронома
    state.mediaRecorder.start(100);
    state.recording = true;
    state.elapsed   = 0;

    updateRecordUI(true);

    // Таймер обратного отсчёта
    const duration = parseInt(el('cfg-duration').value) || 60;
    startTimer(duration);

    // Автоостановка через duration секунд
    state.autoStopTimer = setTimeout(() => stopRecording(), duration * 1000);

  } catch (err) {
    toast(`Ошибка доступа к микрофону: ${err.message}`, 'error');
  }
}

function stopRecording() {
  if (!state.recording || !state.mediaRecorder) return;
  clearTimeout(state.autoStopTimer);
  clearInterval(state.timerInterval);
  stopMetronome();          // глушим эталонный метроном
  lockBpmControls(false);
  state.mediaRecorder.stop();
  state.recording = false;
  updateRecordUI(false);
  el('record-status').textContent = 'Анализ записи…';
}

/** Блокирует смену темпа/метронома во время записи (эталон нельзя менять на ходу). */
function lockBpmControls(locked) {
  ['bpm-minus', 'bpm-plus', 'metronome-btn'].forEach(id => {
    const e = el(id);
    if (e) e.disabled = locked;
  });
  if (!locked) updateBpmUI(); // вернуть корректное состояние границ 30/120
}

async function processRecording() {
  el('record-status').textContent = 'Декодирование аудио…';

  try {
    const mimeType = state.mediaRecorder.mimeType || 'audio/webm';
    const blob = new Blob(state.audioChunks, { type: mimeType });

    if (blob.size < 1000) {
      toast('Запись слишком короткая или пустая', 'error');
      el('record-status').textContent = 'Готов к записи';
      return;
    }

    const arrayBuffer = await blob.arrayBuffer();

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();

    el('record-status').textContent = 'Поиск пиков…';

    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    await audioCtx.close();

    // Анализ по математической BPM-сетке.
    // gridOffsetMs — смещение первого удара, захваченное в момент старта записи.
    const results = analyzeAudio(
      audioBuffer,
      state.config,
      state.gridOffsetMs,
      state.config.BPM || 60
    );

    if (results.length === 0) {
      toast('Удары не обнаружены. Снизьте порог палочки или ударяйте сильнее.', 'error');
      el('record-status').textContent = 'Готов к записи';
      return;
    }

    const stats = computeStats(results);

    state.currentSession = {
      id:        Date.now(),
      timestamp: new Date().toISOString(),
      profile:   state.profile ? { ...state.profile } : null,
      config:    { ...state.config },
      results,
      stats,
    };

    el('record-status').textContent = `Найдено ${results.length} ударов`;

    renderResults(state.currentSession);
    show('results-section');
    el('results-section').scrollIntoView({ behavior: 'smooth' });

  } catch (err) {
    toast(`Ошибка анализа: ${err.message}`, 'error');
    el('record-status').textContent = 'Готов к записи';
    console.error(err);
  }
}

// ============================================================
// 7. ТАЙМЕР
// ============================================================

function startTimer(totalSec) {
  let remaining = totalSec;
  updateTimerDisplay(remaining, totalSec);
  state.timerInterval = setInterval(() => {
    remaining--;
    state.elapsed++;
    updateTimerDisplay(remaining, totalSec);
    const pct = ((totalSec - remaining) / totalSec) * 100;
    el('progress-bar').style.width = pct + '%';
    if (remaining <= 0) clearInterval(state.timerInterval);
  }, 1000);
}

function updateTimerDisplay(remaining, total) {
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  el('timer-display').textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

function updateRecordUI(isRecording) {
  const btn = el('record-btn');
  if (isRecording) {
    btn.textContent = '⏹ Остановить';
    btn.classList.add('recording');
    show('progress-wrap');
    el('progress-bar').style.width = '0%';
  } else {
    btn.textContent = '🎙️ Начать запись';
    btn.classList.remove('recording');
  }
}

// ============================================================
// 8. РЕНДЕРИНГ РЕЗУЛЬТАТОВ
// ============================================================

function renderResults(session) {
  renderStats(session.stats);
  renderChart(session.results);
  renderComparison();
}

/* ── Статистика ─────────────────────────────────────────── */
function renderStats(stats) {
  if (!stats) return;
  const lvl = stats.level;

  el('stats-grid').innerHTML = `
    <div class="stat-card" style="border-color:${lvl.color}">
      <div class="stat-label">Уровень</div>
      <div class="stat-value" style="color:${lvl.color}">${lvl.label}</div>
      <div class="stat-sub">${lvl.desc}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">MAD (среднее отклонение)</div>
      <div class="stat-value">${stats.mad} мс</div>
      <div class="stat-sub">Среднее абсолютное отклонение</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Систематический сдвиг</div>
      <div class="stat-value">${stats.meanSigned > 0 ? '+' : ''}${stats.meanSigned} мс</div>
      <div class="stat-sub">${stats.meanSigned > 0 ? 'Запаздываете' : stats.meanSigned < 0 ? 'Опережаете' : 'Без сдвига'}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Стандартное отклонение</div>
      <div class="stat-value">±${stats.stdDev} мс</div>
      <div class="stat-sub">Разброс результатов</div>
    </div>
    <div class="stat-card highlight-green">
      <div class="stat-label">Попадания &lt;20 мс</div>
      <div class="stat-value">${stats.percentUnder20}%</div>
      <div class="stat-sub">${stats.count > 0 ? Math.round(stats.count * stats.percentUnder20 / 100) : 0} из ${stats.count} ударов</div>
    </div>
    <div class="stat-card highlight-yellow">
      <div class="stat-label">Попадания &lt;50 мс</div>
      <div class="stat-value">${stats.percentUnder50}%</div>
      <div class="stat-sub">Хороший диапазон</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Диапазон</div>
      <div class="stat-value">${stats.minAbs}–${stats.maxAbs} мс</div>
      <div class="stat-sub">Мин–макс абсолютного отклонения</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Всего ударов</div>
      <div class="stat-value">${stats.count}</div>
      <div class="stat-sub">Обнаружено пар</div>
    </div>
  `;
}

/* ── SVG-График джиттера ────────────────────────────────── */
function renderChart(results) {
  const container = el('chart-container');
  if (!container) return;
  if (!results || results.length === 0) {
    container.innerHTML = '<p class="empty-msg">Нет данных для графика</p>';
    return;
  }
  container.innerHTML = buildChartSVG(results);
}

/**
 * buildChartSVG — строит SVG-график джиттера и возвращает его строкой.
 * Вынесено отдельно, чтобы один и тот же график можно было и вставить
 * на экран (renderChart), и встроить в автономный HTML-отчёт.
 * @param {Array} results
 * @returns {string} SVG-разметка
 */
function buildChartSVG(results) {
  if (!results || results.length === 0) return '<p class="empty-msg">Нет данных для графика</p>';

  const W  = 800, H  = 400;
  const mT = 30, mR = 20, mB = 55, mL = 68;
  const pW = W - mL - mR;
  const pH = H - mT - mB;

  // Автомасштаб Y: берём максимум по модулю, округляем вверх до 50
  const rawMax   = Math.max(100, ...results.map(r => Math.abs(r.jitterMs)));
  const yMax     = Math.ceil(rawMax / 50) * 50;

  // Преобразование данных в экранные координаты
  const xS = (i) => results.length > 1 ? (i / (results.length - 1)) * pW : pW / 2;
  const yS = (v) => pH / 2 - (v / yMax) * (pH / 2);

  // Цвет точки по абсолютному значению джиттера
  const dotColor = (abs) => abs < 20 ? '#22c55e' : abs < 50 ? '#eab308' : '#ef4444';

  // Вспомогательная функция генерации SVG-тегов
  const tag = (name, attrs, inner = '') => {
    const a = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${name} ${a}>${inner}</${name}>`;
  };

  let body = '';

  // ── Цветные зоны (фон) ──
  // Зелёная зона ±20 мс («элитный» диапазон)
  body += tag('rect', { x: 0, y: yS(20), width: pW, height: yS(-20) - yS(20),
    fill: 'rgba(34,197,94,0.12)', rx: 2 });
  // Жёлтые зоны 20–50 мс (выше и ниже нуля)
  body += tag('rect', { x: 0, y: yS(50),  width: pW, height: yS(20)  - yS(50),
    fill: 'rgba(234,179,8,0.06)' });
  body += tag('rect', { x: 0, y: yS(-20), width: pW, height: yS(-50) - yS(-20),
    fill: 'rgba(234,179,8,0.06)' });

  // ── Горизонтальные линии сетки ──
  const gridStep = yMax <= 100 ? 25 : 50;
  for (let v = -yMax; v <= yMax; v += gridStep) {
    const y = yS(v);
    const isZero = v === 0;
    body += tag('line', {
      x1: 0, y1: y, x2: pW, y2: y,
      stroke: isZero ? '#94a3b8' : '#2a2d4e',
      'stroke-width': isZero ? 2 : 1,
      'stroke-dasharray': isZero ? '' : '4 4',
    });
    // Метка оси Y
    const label = v > 0 ? `+${v}` : `${v}`;
    body += tag('text', {
      x: -8, y: y + 4,
      'text-anchor': 'end', fill: '#94a3b8', 'font-size': 11,
    }, label);
  }

  // ── Вертикальные направляющие для каждого удара ──
  results.forEach((r, i) => {
    const x = xS(i);
    body += tag('line', { x1: x, y1: 0, x2: x, y2: pH,
      stroke: '#1e2140', 'stroke-width': 1 });
  });

  // ── Ломаная линия соединения точек ──
  const polyPts = results.map((r, i) => `${xS(i)},${yS(r.jitterMs)}`).join(' ');
  body += tag('polyline', {
    points: polyPts, fill: 'none',
    stroke: '#6366f1', 'stroke-width': 1.5, opacity: 0.6,
  });

  // ── Точки (цветные кружки) ──
  results.forEach((r, i) => {
    const x   = xS(i);
    const y   = yS(r.jitterMs);
    const abs = Math.abs(r.jitterMs);
    const col = dotColor(abs);

    // Вертикальная линия от нуля до точки (визуализирует величину)
    body += tag('line', {
      x1: x, y1: yS(0), x2: x, y2: y,
      stroke: col, 'stroke-width': 1.5, opacity: 0.4,
    });

    // Точка
    body += tag('circle', {
      cx: x, cy: y, r: 5.5,
      fill: col, stroke: '#0d0d1a', 'stroke-width': 1.5,
    });

    // Подпись: каждые 5 ударов, первый и последний
    const showLabel = i === 0 || i === results.length - 1 ||
                      (results.length <= 20) || (i + 1) % 5 === 0;
    if (showLabel) {
      body += tag('text', {
        x: x, y: pH + 16,
        'text-anchor': 'middle', fill: '#64748b', 'font-size': 10,
      }, r.beatNum);
    }
  });

  // ── Метки осей ──
  body += tag('text', {
    x: pW / 2, y: pH + 40,
    'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 12,
  }, 'Номер удара');

  body += tag('text', {
    transform: `rotate(-90) translate(${-pH / 2}, ${-mL + 14})`,
    'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 12,
  }, 'Отклонение, мс');

  const svgStr = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;height:auto;display:block;border-radius:8px;background:#11122a">
      <g transform="translate(${mL},${mT})">
        ${body}
      </g>
    </svg>`;

  return svgStr;
}

/* ── Блок сравнения ДО / ПОСЛЕ ──────────────────────────── */
function renderComparison() {
  const before = storage.get(SK.BEFORE);
  const after  = storage.get(SK.AFTER);

  if (!before || !after) {
    hide('comparison-card');
    return;
  }

  show('comparison-card');

  const bS = before.stats;
  const aS = after.stats;
  const delta = (aS.mad - bS.mad);
  const deltaStr = (delta <= 0 ? '▼ ' : '▲ +') + Math.abs(Math.round(delta)).toFixed(1) + ' мс';
  const deltaColor = delta <= 0 ? '#22c55e' : '#ef4444';
  const deltaVerb  = delta <= 0 ? 'Улучшение' : 'Ухудшение';

  const d20 = aS.percentUnder20 - bS.percentUnder20;
  const dStd = aS.stdDev - bS.stdDev;

  el('comparison-content').innerHTML = `
    <div class="compare-header">
      <div class="compare-col">
        <div class="compare-label">ДО</div>
        <div class="compare-date">${formatDate(before.timestamp)}</div>
      </div>
      <div class="compare-arrow" style="color:${deltaColor}">
        <div class="compare-delta">${deltaStr}</div>
        <div class="compare-verb">${deltaVerb} MAD</div>
      </div>
      <div class="compare-col">
        <div class="compare-label">ПОСЛЕ</div>
        <div class="compare-date">${formatDate(after.timestamp)}</div>
      </div>
    </div>

    <div class="compare-grid">
      ${compareStat('MAD (ср. отклонение)', bS.mad + ' мс', aS.mad + ' мс', -delta)}
      ${compareStat('Разброс (σ)', '±' + bS.stdDev + ' мс', '±' + aS.stdDev + ' мс', -dStd)}
      ${compareStat('Попадания <20 мс', bS.percentUnder20 + '%', aS.percentUnder20 + '%', d20)}
      ${compareStat('Попадания <50 мс', bS.percentUnder50 + '%', aS.percentUnder50 + '%', aS.percentUnder50 - bS.percentUnder50)}
      ${compareStat('Уровень', bS.level.label, aS.level.label, 0)}
    </div>`;
}

function compareStat(label, bVal, aVal, improvement) {
  const icon  = improvement > 0 ? '✅' : improvement < 0 ? '❌' : '➡️';
  return `
    <div class="compare-stat">
      <div class="cs-label">${label}</div>
      <div class="cs-before">${bVal}</div>
      <div class="cs-icon">${icon}</div>
      <div class="cs-after">${aVal}</div>
    </div>`;
}

/* ── История сессий ─────────────────────────────────────── */
function renderHistory() {
  const hist = loadHistory();
  const container = el('history-list');

  if (hist.length === 0) {
    container.innerHTML = '<p class="empty-msg">История пуста. Сохраните сессию после замера.</p>';
    return;
  }

  container.innerHTML = hist.map((s, idx) => {
    const profile = s.profile;
    const pName   = profile ? profile.name || '—' : '—';
    const lvl     = s.stats ? s.stats.level : { label: '—', color: '#94a3b8' };

    return `
      <div class="history-item" data-idx="${idx}">
        <div class="hi-header" onclick="toggleHistoryItem(this)">
          <div class="hi-left">
            <span class="hi-num">#${hist.length - idx}</span>
            <span class="hi-name">${pName}</span>
            <span class="hi-date">${formatDate(s.timestamp)}</span>
          </div>
          <div class="hi-right">
            <span class="hi-level" style="color:${lvl.color}">${lvl.label}</span>
            <span class="hi-mad">${s.stats ? s.stats.mad + ' мс' : '—'}</span>
            <span class="hi-arrow">▼</span>
          </div>
        </div>
        <div class="hi-body" style="display:none">
          ${renderHistoryDetail(s)}
          <div class="hi-actions">
            <button class="btn btn-sm btn-share" onclick="shareSession(${idx})">📤 Поделиться</button>
            <button class="btn btn-sm btn-html"  onclick="exportSessionHTML(${idx})">📊 HTML</button>
            <button class="btn btn-sm btn-csv"   onclick="exportSessionCSV(${idx})">📄 CSV</button>
            <button class="btn btn-sm btn-json"  onclick="exportSessionJSON(${idx})">🗂️ JSON</button>
            <button class="btn btn-sm btn-danger" onclick="deleteHistoryItem(${idx})">🗑️</button>
          </div>
          <div class="hi-actions" style="margin-top:6px">
            <span style="font-size:11px;color:var(--text-muted);align-self:center">Для сравнения:</span>
            <button class="btn btn-sm btn-before" onclick="assignSession(${idx},'before')">⬅ как «ДО»</button>
            <button class="btn btn-sm btn-after"  onclick="assignSession(${idx},'after')">как «ПОСЛЕ» ➡</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

function renderHistoryDetail(s) {
  if (!s.stats) return '<p>Нет данных</p>';
  const st = s.stats;
  const pf = s.profile;

  const profileStr = pf
    ? `${pf.name || '—'}, ${pf.age || '—'} лет, ${pf.gender || '—'}`
    : 'Профиль не указан';

  return `
    <div class="hi-detail">
      <div class="hi-detail-row"><b>Профиль:</b> ${profileStr}</div>
      ${pf && pf.email ? `<div class="hi-detail-row"><b>Email:</b> ${pf.email}</div>` : ''}
      <div class="hi-detail-row"><b>MAD:</b> ${st.mad} мс | <b>σ:</b> ±${st.stdDev} мс</div>
      <div class="hi-detail-row"><b>&lt;20 мс:</b> ${st.percentUnder20}% | <b>&lt;50 мс:</b> ${st.percentUnder50}%</div>
      <div class="hi-detail-row"><b>Ударов:</b> ${st.count} | <b>Диапазон:</b> ${st.minAbs}–${st.maxAbs} мс</div>
    </div>`;
}

window.toggleHistoryItem = function(headerEl) {
  const body  = headerEl.nextElementSibling;
  const arrow = headerEl.querySelector('.hi-arrow');
  const open  = body.style.display !== 'none';
  body.style.display  = open ? 'none' : '';
  arrow.textContent   = open ? '▼' : '▲';
};

window.deleteHistoryItem = function(idx) {
  if (!confirm('Удалить эту запись?')) return;
  const hist = loadHistory();
  hist.splice(idx, 1);
  storage.set(SK.HISTORY, hist);
  renderHistory();
};

// ============================================================
// 9. ЭКСПОРТ И ПЕРЕДАЧА ДАННЫХ
// ============================================================

function sessionToText(session) {
  const pf = session.profile;
  const st = session.stats;
  const dt = formatDate(session.timestamp);

  let text = `=== ДЖИТТЕР-ТЕСТ ===\n`;
  text += `Дата: ${dt}\n`;
  if (pf) {
    text += `Имя: ${pf.name || '—'}\n`;
    text += `Email: ${pf.email || '—'}\n`;
    text += `Возраст: ${pf.age || '—'} | Пол: ${pf.gender || '—'}\n`;
  }
  text += `\n--- СТАТИСТИКА ---\n`;
  if (st) {
    text += `MAD (среднее отклонение): ${st.mad} мс\n`;
    text += `Разброс (σ): ±${st.stdDev} мс\n`;
    text += `Систематический сдвиг: ${st.meanSigned > 0 ? '+' : ''}${st.meanSigned} мс\n`;
    text += `Попадания <20 мс: ${st.percentUnder20}%\n`;
    text += `Попадания <50 мс: ${st.percentUnder50}%\n`;
    text += `Уровень: ${st.level.label}\n`;
    text += `Всего ударов: ${st.count}\n`;
  }
  text += `\n--- ДЕТАЛИЗАЦИЯ ПО УДАРАМ ---\n`;
  text += `#  | Время(с) | Отклонение\n`;
  session.results.forEach(r => {
    const sign = r.jitterMs >= 0 ? '+' : '';
    text += `${r.beatNum.toString().padStart(3)} | ${(r.metronomeTimeMs/1000).toFixed(2).padStart(8)} | ${sign}${r.jitterMs} мс\n`;
  });

  return text;
}

function sessionToCSV(session) {
  const pf = session.profile || {};
  const st = session.stats   || {};

  const header = [
    '# удара', 'Время метронома (мс)', 'Время палочки (мс)',
    'Джиттер (мс)', 'Джиттер |abs| (мс)', 'Оценка',
  ].join(';');

  const rows = session.results.map(r => {
    const abs   = Math.abs(r.jitterMs);
    const grade = abs < 20 ? 'Элита' : abs < 50 ? 'Хорошо' : abs < 100 ? 'Норма' : 'Слабо';
    return [r.beatNum, r.metronomeTimeMs, r.stickTimeMs, r.jitterMs, abs, grade].join(';');
  });

  const meta = [
    `# Джиттер-тест — ${formatDate(session.timestamp)}`,
    `# Профиль: ${pf.name || '—'} | ${pf.age || '—'} лет | ${pf.gender || '—'} | ${pf.email || '—'}`,
    `# MAD: ${st.mad} мс | σ: ${st.stdDev} мс | <20мс: ${st.percentUnder20}% | Уровень: ${st.level ? st.level.label : '—'}`,
    '',
    header,
  ];

  return '\uFEFF' + meta.join('\n') + '\n' + rows.join('\n'); // BOM для Excel
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function getExportFilename(session, ext) {
  const dt   = new Date(session.timestamp);
  const name = session.profile?.name?.replace(/\s+/g, '_') || 'noname';
  const date = dt.toISOString().slice(0, 10);
  return `jitter_${name}_${date}.${ext}`;
}

// ============================================================
// 9b. АВТОНОМНЫЙ HTML-ОТЧЁТ (просмотр + повторный импорт)
// ============================================================
//
// Ключевая идея «два в одном»:
//  • Файл открывается в ЛЮБОМ браузере → специалист сразу видит график,
//    итоговую статистику и профиль (всё отрисовано и стилизовано инлайн).
//  • Внутри того же файла спрятан <script id="jitter-session-data"> с полным
//    JSON сессии → приложение может загрузить файл обратно и восстановить
//    сессию как родную (история, сравнение ДО/ПОСЛЕ).
// Никаких внешних зависимостей — полностью оффлайн и самодостаточно.

const REPORT_MARKER = 'jitter-session-data'; // id script-тега с данными
const REPORT_SCHEMA = 1;                      // версия формата отчёта

/** Экранирование текста для безопасной вставки в HTML. */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Строит строки итоговой статистики для отчёта. */
function reportStatsHTML(st) {
  if (!st) return '<p>Нет статистики</p>';
  const lvl = st.level || { label: '—', color: '#94a3b8', desc: '' };
  const shift = (st.meanSigned > 0 ? '+' : '') + st.meanSigned;
  const shiftDesc = st.meanSigned > 0 ? 'запаздывание' : st.meanSigned < 0 ? 'опережение' : 'без сдвига';
  const cards = [
    ['Уровень', `<span style="color:${lvl.color}">${escHtml(lvl.label)}</span>`, escHtml(lvl.desc || '')],
    ['MAD (среднее отклонение)', `${st.mad} мс`, 'Основная метрика точности'],
    ['Систематический сдвиг', `${shift} мс`, shiftDesc],
    ['Стандартное отклонение', `±${st.stdDev} мс`, 'Разброс результатов'],
    ['Попадания &lt;20 мс', `${st.percentUnder20}%`, `${Math.round(st.count * st.percentUnder20 / 100)} из ${st.count}`],
    ['Попадания &lt;50 мс', `${st.percentUnder50}%`, 'Хороший диапазон'],
    ['Диапазон', `${st.minAbs}–${st.maxAbs} мс`, 'Мин–макс |отклонения|'],
    ['Всего ударов', `${st.count}`, 'Обнаружено пар'],
  ];
  return cards.map(([l, v, s]) => `
    <div class="rc">
      <div class="rl">${l}</div>
      <div class="rv">${v}</div>
      <div class="rs">${s}</div>
    </div>`).join('');
}

/** Строит таблицу детализации по ударам (только для файла отчёта). */
function reportTableHTML(results) {
  const rows = (results || []).map(r => {
    const abs  = Math.abs(r.jitterMs);
    const sign = r.jitterMs >= 0 ? '+' : '';
    const grade = abs < 20 ? '🏆 Элита' : abs < 50 ? '✅ Хорошо' : abs < 100 ? '📊 Норма' : '⚠️ Слабо';
    const col  = abs < 20 ? '#22c55e' : abs < 50 ? '#eab308' : '#ef4444';
    return `<tr>
      <td>${r.beatNum}</td>
      <td>${(r.metronomeTimeMs / 1000).toFixed(2)}</td>
      <td style="color:${col};font-weight:600">${sign}${r.jitterMs} мс</td>
      <td>${grade}</td>
    </tr>`;
  }).join('');
  return rows || '<tr><td colspan="4">Нет данных</td></tr>';
}

/**
 * sessionToStandaloneHTML — собирает автономный HTML-отчёт со встроенными данными.
 * @param {object} session
 * @returns {string} полный HTML-документ
 */
function sessionToStandaloneHTML(session) {
  const pf = session.profile || {};
  const st = session.stats || {};
  const dt = formatDate(session.timestamp);
  const chart = buildChartSVG(session.results || []);

  // Полезная нагрузка: обёртка со схемой + сама сессия.
  const payload = { schema: REPORT_SCHEMA, app: 'jitter-test', exportedAt: new Date().toISOString(), session };
  // Экранируем '<' чтобы JSON не «разорвал» script-тег.
  const jsonStr = JSON.stringify(payload).replace(/</g, '\\u003c');

  const profileLine = pf.name || pf.age || pf.gender || pf.email
    ? `${escHtml(pf.name || '—')} · ${escHtml(pf.age || '—')} лет · ${escHtml(pf.gender || '—')}${pf.email ? ' · ' + escHtml(pf.email) : ''}`
    : 'Профиль не указан';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Джиттер-тест — отчёт (${escHtml(pf.name || 'без имени')}, ${escHtml(dt)})</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: #0d0d1a; color: #e2e8f0;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 12px; color: #a5b4fc; border-bottom: 1px solid #2a2d4e; padding-bottom: 6px; }
  .sub { color: #94a3b8; font-size: 13px; margin: 0 0 4px; }
  .card { background: #16172e; border: 1px solid #24264a; border-radius: 12px; padding: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .rc { background: #11122a; border: 1px solid #24264a; border-radius: 8px; padding: 10px 12px; }
  .rl { font-size: 11px; color: #94a3b8; }
  .rv { font-size: 20px; font-weight: 700; margin: 2px 0; }
  .rs { font-size: 11px; color: #64748b; }
  .legend { margin-top: 10px; font-size: 12px; color: #94a3b8; }
  .legend span { margin-right: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #24264a; }
  th { color: #94a3b8; font-weight: 600; position: sticky; top: 0; background: #16172e; }
  .tbl-wrap { max-height: 460px; overflow-y: auto; border: 1px solid #24264a; border-radius: 8px; }
  .note { font-size: 12px; color: #64748b; margin-top: 8px; }
  .banner { background: #12283f; border: 1px solid #0369a1; color: #7dd3fc; border-radius: 10px;
            padding: 10px 14px; font-size: 13px; margin: 14px 0; }
  footer { margin-top: 26px; font-size: 12px; color: #475569; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🥁 Джиттер-тест — отчёт</h1>
  <p class="sub"><b>Дата замера:</b> ${escHtml(dt)}</p>
  <p class="sub"><b>Профиль:</b> ${profileLine}</p>
  ${session.type ? `<p class="sub"><b>Тип:</b> ${escHtml(session.type)}</p>` : ''}

  <div class="banner">
    💡 Этот файл можно открыть в браузере для просмотра, а также загрузить обратно
    в приложение «Джиттер-тест» (вкладка «История» → «Загрузить отчёт») — данные восстановятся полностью.
  </div>

  <h2>📊 Итоговая статистика</h2>
  <div class="grid">${reportStatsHTML(st)}</div>

  <h2>📈 График джиттера по ударам</h2>
  <div class="card">
    ${chart}
    <div class="legend">
      <span style="color:#22c55e">● &lt;20 мс — элита</span>
      <span style="color:#eab308">● 20–50 мс — хорошо</span>
      <span style="color:#ef4444">● &gt;50 мс — норма/слабо</span>
    </div>
    <div class="note">Нулевая линия = метроном. Точки выше нуля — запаздывание, ниже — опережение.</div>
  </div>

  <h2>📋 Детализация по ударам</h2>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>#</th><th>Время метр. (с)</th><th>Отклонение</th><th>Оценка</th></tr></thead>
      <tbody>${reportTableHTML(session.results)}</tbody>
    </table>
  </div>

  <footer>Сформировано приложением «Джиттер-тест» · Сенсомоторный ритм</footer>
</div>

<!-- ⬇ ВСТРОЕННЫЕ ДАННЫЕ СЕССИИ (для повторного импорта в приложение) -->
<script type="application/json" id="${REPORT_MARKER}">
${jsonStr}
</script>
</body>
</html>`;
}

/** Валидирует, что объект похож на сессию джиттер-теста. */
function isValidSession(s) {
  return s && typeof s === 'object' && Array.isArray(s.results) && s.results.length > 0 &&
         s.results.every(r => typeof r.jitterMs === 'number');
}

/** Извлекает сессию из строки HTML-отчёта или JSON. */
function parseReportContent(text) {
  // 1) Пытаемся как автономный HTML-отчёт (ищем встроенный script).
  try {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const node = doc.getElementById(REPORT_MARKER);
    if (node && node.textContent.trim()) {
      const payload = JSON.parse(node.textContent);
      const sess = payload && payload.session ? payload.session : payload;
      if (isValidSession(sess)) return sess;
    }
  } catch (e) { /* не HTML или нет данных — пробуем дальше */ }

  // 2) Пытаемся как «сырой» JSON (наш JSON-экспорт или payload-обёртка).
  try {
    const obj = JSON.parse(text);
    const sess = obj && obj.session ? obj.session : obj;
    if (isValidSession(sess)) return sess;
  } catch (e) { /* не JSON */ }

  return null;
}

/* Текущая сессия */
function exportCurrentCSV() {
  if (!state.currentSession) { toast('Сначала сделайте запись', 'error'); return; }
  downloadFile(sessionToCSV(state.currentSession),
               getExportFilename(state.currentSession, 'csv'), 'text/csv;charset=utf-8');
}
function exportCurrentJSON() {
  if (!state.currentSession) { toast('Сначала сделайте запись', 'error'); return; }
  downloadFile(JSON.stringify(state.currentSession, null, 2),
               getExportFilename(state.currentSession, 'json'), 'application/json');
}
function exportCurrentHTML() {
  if (!state.currentSession) { toast('Сначала сделайте запись', 'error'); return; }
  downloadFile(sessionToStandaloneHTML(state.currentSession),
               getExportFilename(state.currentSession, 'html'), 'text/html;charset=utf-8');
  toast('HTML-отчёт сохранён ✓', 'success');
}

/* Из истории */
window.exportSessionCSV = function(idx) {
  const s = loadHistory()[idx];
  if (!s) return;
  downloadFile(sessionToCSV(s), getExportFilename(s, 'csv'), 'text/csv;charset=utf-8');
};
window.exportSessionJSON = function(idx) {
  const s = loadHistory()[idx];
  if (!s) return;
  downloadFile(JSON.stringify(s, null, 2), getExportFilename(s, 'json'), 'application/json');
};
window.exportSessionHTML = function(idx) {
  const s = loadHistory()[idx];
  if (!s) return;
  downloadFile(sessionToStandaloneHTML(s), getExportFilename(s, 'html'), 'text/html;charset=utf-8');
  toast('HTML-отчёт сохранён ✓', 'success');
};

/* Поделиться (текущая сессия или из истории) — отправляем HTML-отчёт */
async function shareSessionData(session) {
  if (!session) { toast('Нет данных для отправки', 'error'); return; }

  const text = sessionToText(session);
  const htmlBlob = new Blob([sessionToStandaloneHTML(session)], { type: 'text/html' });
  const htmlFile = new File([htmlBlob], getExportFilename(session, 'html'), { type: 'text/html' });

  // Web Share API (нативный диалог на мобильных)
  if (navigator.share) {
    const shareData = {
      title:   'Джиттер-тест: отчёт',
      text:    `Джиттер-тест: MAD ${session.stats?.mad} мс, уровень ${session.stats?.level?.label || '—'}. Отчёт (график + статистика) во вложении — откройте в браузере.`,
    };

    // Пробуем прикрепить HTML-отчёт (не все браузеры поддерживают файлы)
    if (navigator.canShare && navigator.canShare({ files: [htmlFile] })) {
      shareData.files = [htmlFile];
    } else {
      shareData.text = text.slice(0, 2000);
    }

    try {
      await navigator.share(shareData);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // пользователь отменил
      // Fallback если share с файлом не прошёл
    }
  }

  // Fallback: меню с вариантами
  showShareMenu(session, text);
}

function showShareMenu(session, text) {
  const menu = el('share-menu');
  const subject = encodeURIComponent('Джиттер-тест: результаты');
  const body    = encodeURIComponent(text.slice(0, 1500));
  const shortText = encodeURIComponent(
    `Джиттер-тест: MAD ${session.stats?.mad} мс, уровень ${session.stats?.level?.label || '—'}. Детали в прикреплённом файле.`
  );

  el('share-email-link').href   = `mailto:?subject=${subject}&body=${body}`;
  el('share-whatsapp-link').href = `https://wa.me/?text=${shortText}`;
  el('share-telegram-link').href = `https://t.me/share/url?url=&text=${shortText}`;

  menu.style.display = menu.style.display === 'none' ? '' : 'none';
}

window.shareSession = async function(idx) {
  const s = loadHistory()[idx];
  if (s) await shareSessionData(s);
};

// ── Импорт отчёта (HTML или JSON) обратно в приложение ──
async function importReportFromFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const session = parseReportContent(text);

    if (!session) {
      toast('Не удалось распознать отчёт. Нужен HTML-отчёт или JSON из этого приложения.', 'error');
      return;
    }

    // Восстанавливаем недостающие поля, помечаем как импортированную.
    if (!session.stats) session.stats = computeStats(session.results);
    if (!session.timestamp) session.timestamp = new Date().toISOString();
    session.id = Date.now();
    session.imported = true;

    // Не создаём дубликат: если такая же сессия уже есть — сообщаем.
    const hist = loadHistory();
    const dup = hist.find(h =>
      h.timestamp === session.timestamp &&
      h.results?.length === session.results.length &&
      (h.stats?.mad === session.stats?.mad));
    if (dup) {
      toast('Этот отчёт уже есть в истории', 'info');
      switchTab('history');
      return;
    }

    addToHistory(session);
    renderHistory();
    switchTab('history');

    const pname = session.profile?.name || 'без имени';
    toast(`Отчёт загружен: ${pname}, MAD ${session.stats?.mad} мс ✓`, 'success');
  } catch (e) {
    toast('Ошибка чтения файла: ' + e.message, 'error');
    console.error(e);
  }
}

// ── Назначить сессию из истории эталоном сравнения (ДО / ПОСЛЕ) ──
window.assignSession = function(idx, slot) {
  const s = loadHistory()[idx];
  if (!s) return;
  storage.set(slot === 'before' ? SK.BEFORE : SK.AFTER, s);
  toast(`Сессия назначена как «${slot === 'before' ? 'ДО' : 'ПОСЛЕ'}» ✓`, 'success');
  renderComparison();
  switchTab('record');
};

// ============================================================
// 10. ПРОФИЛЬ
// ============================================================

function loadProfileUI() {
  const p = loadProfile();
  if (!p) return;
  state.profile = p;
  const safe = (id, val) => { const e = el(id); if (e && val != null) e.value = val; };
  safe('profile-name',  p.name);
  safe('profile-email', p.email);
  safe('profile-age',   p.age);
  if (p.gender) {
    const r = $(`input[name="gender"][value="${p.gender}"]`);
    if (r) r.checked = true;
  }
  updateProfileBadge(p);
}

function collectProfile() {
  const genderEl = $('input[name="gender"]:checked');
  return {
    name:   el('profile-name').value.trim(),
    email:  el('profile-email').value.trim(),
    age:    el('profile-age').value,
    gender: genderEl ? genderEl.value : '',
  };
}

function updateProfileBadge(p) {
  const badge = el('profile-badge');
  if (p && p.name) {
    badge.textContent = p.name[0].toUpperCase();
    badge.title       = `${p.name}${p.age ? ', ' + p.age + ' лет' : ''}`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// ============================================================
// 11. ВКЛАДКИ (TABS)
// ============================================================

function switchTab(tabName) {
  // Уходим со вкладки записи — глушим калибровку (микрофон занят)
  if (tabName !== 'record' && calib.active) stopCalibration();
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  $$('.tab-content').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tabName));
  if (tabName === 'history') renderHistory();
}

// ============================================================
// 12. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

function formatDate(isoStr) {
  try {
    return new Date(isoStr).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return isoStr || '—'; }
}

// ============================================================
// 13. ИНИЦИАЛИЗАЦИЯ НАСТРОЕК
// ============================================================

function initConfig() {
  const saved = storage.get(SK.CONFIG);
  if (saved) Object.assign(state.config, saved);

  // Слайдеры
  const bindSlider = (id, key) => {
    const input = el(id);
    const span  = el(id + '-val');
    if (!input) return;
    input.value = state.config[key];
    if (span) span.textContent = parseFloat(state.config[key]).toFixed(2);
    input.addEventListener('input', () => {
      state.config[key] = parseFloat(input.value);
      if (span) span.textContent = parseFloat(input.value).toFixed(2);
      storage.set(SK.CONFIG, state.config);
      syncCalibHandles(); // держим ползунки калибровки в синхроне
    });
  };

  // cfg-metro-thresh убран: метроном звучит только в наушниках, порог не нужен
  bindSlider('cfg-stick-thresh', 'STICK_THRESHOLD');

  const bindNumber = (id, key) => {
    const input = el(id);
    if (!input) return;
    input.value = state.config[key];
    input.addEventListener('change', () => {
      state.config[key] = parseFloat(input.value);
      storage.set(SK.CONFIG, state.config);
    });
  };

  bindNumber('cfg-duration', 'DURATION_SEC');
  bindNumber('cfg-window',   'SEARCH_WINDOW_MS');

  // Метроном: синхронизируем BPM из сохранённого конфига
  metronome.bpm = state.config.BPM || 60;
  updateBpmUI();
}

// ============================================================
// 14. ТОЧКА ВХОДА — ИНИЦИАЛИЗАЦИЯ
// ============================================================

document.addEventListener('DOMContentLoaded', () => {

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }

  // Профиль
  loadProfileUI();
  initConfig();

  // ── Вкладки ──
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ── Профиль: сохранение ──
  el('save-profile-btn').addEventListener('click', () => {
    const p = collectProfile();
    state.profile = p;
    saveProfile(p);
    updateProfileBadge(p);
    toast('Профиль сохранён ✓', 'success');
  });

  // ── Запись ──
  el('record-btn').addEventListener('click', () => {
    if (state.recording) stopRecording();
    else startRecording();
  });

  // ── Метроном ──
  el('metronome-btn').addEventListener('click', toggleMetronome);
  el('bpm-minus').addEventListener('click', () => changeBpm(-BPM_STEP));
  el('bpm-plus').addEventListener('click',  () => changeBpm(+BPM_STEP));

  // ── Калибровка порогов ──
  initCalibDrag();
  syncCalibHandles();
  el('calib-btn').addEventListener('click', toggleCalibration);
  el('calib-auto-btn').addEventListener('click', startAutoCalibration);

  // ── Сохранить как ДО / ПОСЛЕ ──
  el('save-before-btn').addEventListener('click', () => {
    if (!state.currentSession) { toast('Сначала сделайте запись', 'error'); return; }
    storage.set(SK.BEFORE, state.currentSession);
    addToHistory({ ...state.currentSession, type: 'ДО' });
    toast('Сохранено как сессия «ДО» ✓', 'success');
    renderComparison();
  });

  el('save-after-btn').addEventListener('click', () => {
    if (!state.currentSession) { toast('Сначала сделайте запись', 'error'); return; }
    storage.set(SK.AFTER, state.currentSession);
    addToHistory({ ...state.currentSession, type: 'ПОСЛЕ' });
    toast('Сохранено как сессия «ПОСЛЕ» ✓', 'success');
    renderComparison();
  });

  // ── Экспорт ──
  el('export-csv-btn').addEventListener('click', exportCurrentCSV);
  el('export-json-btn').addEventListener('click', exportCurrentJSON);
  el('export-html-btn').addEventListener('click', exportCurrentHTML);

  // ── Поделиться ──
  el('share-btn').addEventListener('click', () => shareSessionData(state.currentSession));

  el('share-menu-html').addEventListener('click', exportCurrentHTML);
  el('share-menu-csv').addEventListener('click', exportCurrentCSV);
  el('share-menu-json').addEventListener('click', exportCurrentJSON);

  // ── Импорт отчёта (вкладка «История») ──
  const importBtn   = el('import-report-btn');
  const importInput = el('import-report-input');
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      await importReportFromFile(file);
      importInput.value = ''; // сброс, чтобы можно было выбрать тот же файл повторно
    });
  }

  // ── Очистить историю ──
  el('clear-history-btn').addEventListener('click', () => {
    if (!confirm('Очистить всю историю и сессии ДО/ПОСЛЕ?')) return;
    clearHistory();
    renderHistory();
    toast('История очищена', 'info');
  });

  // Закрытие share-меню по клику вне его
  document.addEventListener('click', (e) => {
    const menu = el('share-menu');
    if (menu && !menu.contains(e.target) && e.target !== el('share-btn')) {
      menu.style.display = 'none';
    }
  });

  // Инициализируем отображение истории на вкладке
  hide('results-section');
  hide('share-menu');

  // Показываем кнопку сравнения если обе сессии есть
  renderComparison();

  // ── Реакция на подключение/отключение BT-наушников ──────────────
  // При смене аудиоустройства (devicechange) контекст может уйти в
  // suspended или closed — принудительно возобновляем или пересоздаём.
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      if (!metronome.ctx) return;
      try {
        if (metronome.ctx.state === 'closed') {
          // Контекст полностью убит — пересоздаём и перезапускаем метроном
          const wasPlaying = metronome.isPlaying;
          metronome.isPlaying = false;
          clearInterval(metronome.timerId);
          metronome.timerId = null;
          metronome.ctx = null;
          if (wasPlaying) startMetronome();
        } else if (metronome.ctx.state === 'suspended') {
          await metronome.ctx.resume();
        }
      } catch (e) { /* следующий жест пользователя восстановит контекст */ }
    });
  }
});
