// ==== Telegram WebApp init ====
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor && tg.setHeaderColor("secondary_bg_color"); } catch (e) {}
}

// Застосунок працює лише як Telegram Mini App — якщо відкрито просто в браузері
// (немає window.Telegram.WebApp), показуємо заглушку й далі нічого не виконуємо.
if (!tg) {
  const el = document.getElementById("app");
  if (el) {
    el.innerHTML = `
      <div class="telegram-only-screen">
        <div class="telegram-only-icon">
          <svg viewBox="0 0 34 34" fill="none"><rect x="8" y="15" width="18" height="14" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M12 15 V10 a5 5 0 0 1 10 0 v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
        </div>
        <h1>Доступно лише в Telegram</h1>
        <p>Цей тренажер працює як Mini App усередині Telegram. Відкрий бота і натисни кнопку меню, щоб почати.</p>
      </div>`;
  }
  throw new Error("Not running inside Telegram WebApp — app halted.");
}

const currentUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
const userId = currentUser ? currentUser.id : "guest";
const isOwner = CONFIG.OWNER_TELEGRAM_IDS.includes(userId);

// ==== Реальний преміум-статус (перевіряється на бекенді, не локально) ====
// Поки відповідь не прийшла — вважаємо, що преміуму нема (безпечніше за замовчуванням).
let isPremiumUser = false;
let premiumUntil = null;

async function fetchPremiumStatus() {
  if (!CONFIG.BACKEND_URL || userId === "guest") return;
  try {
    const res = await fetch(`${CONFIG.BACKEND_URL}/api/status/${userId}`);
    const status = await res.json();
    isPremiumUser = !!status.isPremium;
    premiumUntil = status.premiumUntil || null;
  } catch (e) {
    // Бекенд недоступний (спить/офлайн) — просто лишаємось на безкоштовних темах,
    // не ламаємо застосунок.
  }
  render();
}

// Купівля преміуму кнопкою прямо в застосунку (Telegram Stars), без команди боту.
// tierId — один із CONFIG.PRICING_TIERS ("month" / "year" / "lifetime").
async function buyPremium(buttonEl, tierId) {
  if (!CONFIG.BACKEND_URL || userId === "guest") return;
  if (buttonEl) { buttonEl.disabled = true; buttonEl.classList.add("is-loading"); }
  try {
    const res = await fetch(`${CONFIG.BACKEND_URL}/api/premium-link/${userId}/${tierId}`);
    const data2 = await res.json();
    if (data2.alreadyPremium) {
      isPremiumUser = true;
      premiumUntil = data2.premiumUntil || null;
      render();
      return;
    }
    if (!data2.link) throw new Error("no invoice link");
    tg.openInvoice(data2.link, (status) => {
      if (status === "paid") {
        fetchPremiumStatus();
      } else if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.classList.remove("is-loading");
      }
    });
  } catch (e) {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.classList.remove("is-loading");
    }
    if (tg.showAlert) tg.showAlert("Не вдалося створити рахунок. Спробуй трохи пізніше.");
  }
}

// ==== Progress storage (per-device, keyed by Telegram user id) ====
// localStorage у Telegram Mini App — ненадійне сховище: iOS/Android WebView Telegram
// може будь-коли очистити дані сайту (оновлення застосунку, чистка кешу, переустановка),
// і тоді "Історія проходжень" виглядає так, ніби нічого не зберігалось. Тому прогрес
// додатково дублюється в Telegram CloudStorage (Bot API), яке належить самому акаунту
// користувача в Telegram і не залежить від локального кешу WebView.
const STORAGE_KEY = `uahist_progress_v2_${userId}`;

const hasCloud = !!(tg && tg.CloudStorage && typeof tg.CloudStorage.setItem === "function");
const CLOUD_KEYS = {
  meta: "uahist_meta",
  topics: "uahist_topics",
  history: "uahist_history",
};

function cloudSetItem(key, value) {
  if (!hasCloud) return;
  try {
    tg.CloudStorage.setItem(key, value, () => {});
  } catch (e) {}
}

function cloudGetItems(keys, cb) {
  if (!hasCloud) { cb({}); return; }
  try {
    tg.CloudStorage.getItems(keys, (err, values) => cb(!err && values ? values : {}));
  } catch (e) {
    cb({});
  }
}

function defaultData() {
  return {
    topics: {}, // { [topicId]: { bestScore, lastScore, attempts, correctEver } }
    totalCorrectEver: 0,
    lastTopicId: null,
    streak: { count: 0, lastActiveDate: null },
    history: [], // [{ topicId, topicTitle, score, total, pct, date }], newest first, capped at HISTORY_LIMIT
    flashcards: {}, // { [topicId]: [cardIndex, ...] } — картки, позначені як "знаю"
  };
}

const HISTORY_LIMIT = 50;
// CloudStorage-значення обмежені ~4096 символами, тому в хмару зберігаємо стиснуту
// (без назви теми й відсотка — вони рахуються на льоту) і трохи коротшу історію.
const CLOUD_HISTORY_LIMIT = 30;

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    const parsed = JSON.parse(raw);
    return { ...defaultData(), ...parsed };
  } catch (e) {
    return defaultData();
  }
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {}
  // Дублюємо найважливіше (бали по темах, лічильники, історію) у Telegram CloudStorage,
  // щоб прогрес пережив очищення локального сховища застосунку.
  cloudSetItem(CLOUD_KEYS.meta, JSON.stringify({
    totalCorrectEver: data.totalCorrectEver,
    lastTopicId: data.lastTopicId,
    streak: data.streak,
  }));
  cloudSetItem(CLOUD_KEYS.topics, JSON.stringify(data.topics));
  cloudSetItem(
    CLOUD_KEYS.history,
    JSON.stringify(
      (data.history || []).slice(0, CLOUD_HISTORY_LIMIT).map((h) => ({ t: h.topicId, s: h.score, n: h.total, d: h.date }))
    )
  );
}

// Підтягує збережений у Telegram CloudStorage прогрес (якщо є) і доливає його в локальні
// дані — беремо кращі/більші значення з обох джерел, нічого не затираючи даремно.
function mergeCloudIntoData(cloudMeta, cloudTopics, cloudHistory) {
  let changed = false;

  if (cloudMeta) {
    if ((cloudMeta.totalCorrectEver || 0) > (data.totalCorrectEver || 0)) {
      data.totalCorrectEver = cloudMeta.totalCorrectEver;
      changed = true;
    }
    if (cloudMeta.streak && (cloudMeta.streak.count || 0) > (data.streak.count || 0)) {
      data.streak = cloudMeta.streak;
      changed = true;
    }
    if (!data.lastTopicId && cloudMeta.lastTopicId) {
      data.lastTopicId = cloudMeta.lastTopicId;
      changed = true;
    }
  }

  if (cloudTopics) {
    Object.keys(cloudTopics).forEach((id) => {
      const c = cloudTopics[id] || {};
      const l = data.topics[id];
      const bestScore = Math.max((l && l.bestScore) || 0, c.bestScore || 0);
      const attempts = Math.max((l && l.attempts) || 0, c.attempts || 0);
      if (!l || bestScore > (l.bestScore || 0) || attempts > (l.attempts || 0)) {
        data.topics[id] = { bestScore, attempts, lastScore: c.lastScore != null ? c.lastScore : l ? l.lastScore : null };
        changed = true;
      }
    });
  }

  if (Array.isArray(cloudHistory) && cloudHistory.length) {
    const localKeys = new Set((data.history || []).map((h) => h.topicId + "|" + h.date));
    const expanded = cloudHistory
      .filter((h) => h && h.t && !localKeys.has(h.t + "|" + h.d))
      .map((h) => ({
        topicId: h.t,
        topicTitle: (TOPICS.find((t) => t.id === h.t) || {}).title || h.t,
        score: h.s,
        total: h.n,
        pct: h.n ? Math.round((h.s / h.n) * 100) : 0,
        date: h.d,
      }));
    if (expanded.length) {
      data.history = [...data.history, ...expanded]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, HISTORY_LIMIT);
      changed = true;
    }
  }

  if (changed) {
    saveData();
    render();
  }
}

function syncFromCloud() {
  if (!hasCloud) return;
  cloudGetItems([CLOUD_KEYS.meta, CLOUD_KEYS.topics, CLOUD_KEYS.history], (values) => {
    try {
      const meta = values[CLOUD_KEYS.meta] ? JSON.parse(values[CLOUD_KEYS.meta]) : null;
      const topics = values[CLOUD_KEYS.topics] ? JSON.parse(values[CLOUD_KEYS.topics]) : null;
      const history = values[CLOUD_KEYS.history] ? JSON.parse(values[CLOUD_KEYS.history]) : null;
      mergeCloudIntoData(meta, topics, history);
    } catch (e) {}
  });
}

let data = loadData();

// ---- Streak bookkeeping (call once per session load) ----
function updateStreakOnOpen() {
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const last = data.streak.lastActiveDate;
  if (last === todayKey) {
    // already counted today
    return;
  }
  if (!last) {
    data.streak.count = 1;
  } else {
    const lastDate = new Date(last + "T00:00:00Z");
    const diffDays = Math.round((today.setUTCHours(0, 0, 0, 0), (Date.parse(todayKey + "T00:00:00Z") - lastDate.getTime())) / 86400000);
    if (diffDays === 1) {
      data.streak.count += 1;
    } else if (diffDays > 1) {
      data.streak.count = 1;
    }
    // diffDays === 0 shouldn't happen here since last !== todayKey
  }
  data.streak.lastActiveDate = todayKey;
  saveData();
}
updateStreakOnOpen();

function totalQuestionsInBank() {
  return TOPICS.reduce((sum, t) => sum + t.questions.length, 0);
}

// ==== "Літопис" visual helpers: roman numerals instead of emoji topic icons, ====
// ==== inline line-icons instead of emoji, so the app doesn't look like a generic quiz template ====
function toRoman(num) {
  const table = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
    [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
    [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ];
  let n = num;
  let out = "";
  for (const [value, symbol] of table) {
    while (n >= value) {
      out += symbol;
      n -= value;
    }
  }
  return out;
}

const OPTION_LETTERS = ["А", "Б", "В", "Г", "Д", "Е"];

const ICONS = {
  emblem: `<svg viewBox="0 0 34 34" fill="none"><path d="M17 3 L17 22 M10 8 C10 14 13 17 17 17 C21 17 24 14 24 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M12 22 L22 22 L19.5 28 L14.5 28 Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  scroll: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 4h10a2 2 0 0 1 2 2v13a2 2 0 0 0 2-2V8M6 4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 9h6M9 13h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  banner: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 3v18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M6 4h13l-3 4 3 4H6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  flame: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3c1 3-3 4-3 8a3 3 0 0 0 6 0c0-1.5-1-2-1-3.5 1.5 1 3 3 3 6a5 5 0 0 1-10 0c0-4 2.5-5.5 5-10.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  laurel: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M8 8c-2 1-3 3-3 6M16 8c2 1 3 3 3 6M8 11c-2 .5-3 2-3 4M16 11c2 .5 3 2 3 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  book: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 5.5C4 4.7 4.7 4 5.5 4H12v16H5.5A1.5 1.5 0 0 1 4 18.5v-13zM20 5.5c0-.8-.7-1.5-1.5-1.5H12v16h6.5a1.5 1.5 0 0 0 1.5-1.5v-13z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  fist: `<svg viewBox="0 0 24 24" fill="none"><path d="M7 10V7a2 2 0 0 1 4 0M11 10V6a2 2 0 0 1 4 0v4M15 10V7a2 2 0 0 1 4 0v6a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L4.5 13a1.5 1.5 0 0 1 2.4-1.8L7 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  seal: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="9" r="6" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 14l-2 7 5.5-3 5.5 3-2-7" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="9" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 12l5 5L20 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  cross: `<svg viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`,
};

function topicIsLocked(topicIndex) {
  if (isOwner) return false;
  if (isPremiumUser) return false;
  if (!CONFIG.MONETIZATION_ENABLED) return false; // монетизація вимкнена — усе відкрито
  return topicIndex >= CONFIG.FREE_TOPICS_COUNT;
}

function topicStats(topicId) {
  const p = data.topics[topicId];
  if (!p) return { bestPct: 0, attempts: 0 };
  return { bestPct: p.bestScore != null ? Math.round((p.bestScore / 10) * 100) : 0, attempts: p.attempts || 0 };
}

function courseCompletionPct() {
  const attemptedCount = TOPICS.filter((t) => data.topics[t.id] && data.topics[t.id].attempts > 0).length;
  return TOPICS.length ? Math.round((attemptedCount / TOPICS.length) * 100) : 0;
}

// ==== App state ====
const root = document.getElementById("app");
let state = { screen: "home", topicIndex: null, quiz: null };

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Перемішує варіанти відповіді всередині одного питання (і перераховує індекс
// правильної відповіді), щоб правильна відповідь не опинялась завжди на місці "А".
// Повертає новий об'єкт, не чіпаючи оригінальні дані в questions.js.
function shuffleQuestionOptions(question) {
  const order = shuffled(question.options.map((_, i) => i));
  const options = order.map((i) => question.options[i]);
  const correct = order.indexOf(question.correct);
  return { ...question, options, correct };
}

function startQuiz(topicIndex) {
  const topic = TOPICS[topicIndex];
  const questions = shuffled(topic.questions).slice(0, 10).map(shuffleQuestionOptions);
  data.lastTopicId = topic.id;
  saveData();
  state = {
    screen: "quiz",
    topicIndex,
    quiz: { questions, current: 0, score: 0, answered: false, selectedIndex: null },
  };
  render();
}

function answerQuestion(optionIndex) {
  const q = state.quiz;
  if (q.answered) return;
  q.answered = true;
  q.selectedIndex = optionIndex;
  const question = q.questions[q.current];
  if (optionIndex === question.correct) {
    q.score += 1;
    data.totalCorrectEver += 1;
    saveData();
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
  } else {
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("error");
  }
  render();
}

function nextQuestion() {
  const q = state.quiz;
  if (q.current + 1 < q.questions.length) {
    q.current += 1;
    q.answered = false;
    q.selectedIndex = null;
    render();
  } else {
    finishQuiz();
  }
}

function finishQuiz() {
  const topic = TOPICS[state.topicIndex];
  const q = state.quiz;
  const prev = data.topics[topic.id] || { bestScore: 0, attempts: 0 };
  data.topics[topic.id] = {
    bestScore: Math.max(prev.bestScore || 0, q.score),
    lastScore: q.score,
    attempts: (prev.attempts || 0) + 1,
  };
  if (!Array.isArray(data.history)) data.history = [];
  data.history.unshift({
    topicId: topic.id,
    topicTitle: topic.title,
    score: q.score,
    total: q.questions.length,
    pct: Math.round((q.score / q.questions.length) * 100),
    date: new Date().toISOString(),
  });
  if (data.history.length > HISTORY_LIMIT) data.history.length = HISTORY_LIMIT;
  saveData();
  state.screen = "results";
  render();
}

function goHome() {
  state = { screen: "home", topicIndex: null, quiz: null };
  render();
}

function goTopics() {
  state = { screen: "topics", topicIndex: null, quiz: null };
  render();
}

function goHistory() {
  state = { screen: "history", topicIndex: null, quiz: null };
  render();
}

// ==== Конспекти ====
function conspectTopicIds() {
  return TOPICS.map((t) => t.id).filter((id) => typeof CONSPECTS !== "undefined" && CONSPECTS[id]);
}

function goConspectTopics() {
  state = { screen: "conspectTopics", topicIndex: null, quiz: null };
  render();
}

function goConspect(topicIndex) {
  state = { screen: "conspect", topicIndex, quiz: null };
  render();
}

// ==== Флешкартки ====
function flashcardTopicIds() {
  return TOPICS.map((t) => t.id).filter((id) => typeof FLASHCARDS !== "undefined" && Array.isArray(FLASHCARDS[id]) && FLASHCARDS[id].length);
}

function flashcardStats(topicId) {
  const cards = (typeof FLASHCARDS !== "undefined" && FLASHCARDS[topicId]) || [];
  const known = (data.flashcards[topicId] || []).length;
  return { total: cards.length, known };
}

function goFlashcardTopics() {
  state = { screen: "flashcardTopics", topicIndex: null, quiz: null };
  render();
}

// deck.mode: "test" — перший прохід, картка закрита, треба самому торкнутись, щоб перевернути.
// deck.mode: "review" — прохід по картках, позначених "Повторити", пояснення видно одразу,
// картку перевертати не треба — спочатку читаєш, потім оцінюєш "знаю / ще раз повторю".
function goFlashcardDeck(topicIndex) {
  const topic = TOPICS[topicIndex];
  const cards = (typeof FLASHCARDS !== "undefined" && FLASHCARDS[topic.id]) || [];
  const order = shuffled(cards.map((_, i) => i));
  state = {
    screen: "flashcards",
    topicIndex,
    quiz: null,
    deck: { order, pos: 0, flipped: false, mode: "test", knownThisRound: [], repeatThisRound: [] },
  };
  render();
}

function startReviewRound(indices) {
  state.deck = {
    order: shuffled(indices),
    pos: 0,
    flipped: true,
    mode: "review",
    knownThisRound: [],
    repeatThisRound: [],
  };
  render();
}

function swipeCard(result) {
  const topic = TOPICS[state.topicIndex];
  const deck = state.deck;
  if (!deck) return;
  const cardIndex = deck.order[deck.pos];

  if (result === "know") {
    if (!data.flashcards[topic.id]) data.flashcards[topic.id] = [];
    if (!data.flashcards[topic.id].includes(cardIndex)) {
      data.flashcards[topic.id].push(cardIndex);
      saveData();
    }
    deck.knownThisRound.push(cardIndex);
  } else {
    deck.repeatThisRound.push(cardIndex);
  }

  deck.pos += 1;
  deck.flipped = deck.mode === "review"; // у режимі повторення наступна картка теж одразу розгорнута
  render();
}

function setupCardFlipAndSwipe() {
  const wrap = document.getElementById("cardSwipeWrap");
  const flip = document.getElementById("cardFlip"); // може бути відсутній у режимі "review" — це нормально
  if (!wrap) return;

  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let dragging = false;
  let moved = 0;

  function onPointerDown(e) {
    dragging = true;
    moved = 0;
    startX = e.clientX;
    startY = e.clientY;
    startTime = Date.now();
    wrap.style.transition = "none";
  }
  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    moved = Math.abs(dx) + Math.abs(dy);
    wrap.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
  }
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    const dx = e.clientX - startX;
    const elapsed = Date.now() - startTime;

    if (moved < 8 && elapsed < 400) {
      wrap.style.transition = "transform 0.2s ease";
      wrap.style.transform = "";
      if (flip) {
        state.deck.flipped = !state.deck.flipped;
        flip.classList.toggle("is-flipped");
      }
      return;
    }

    if (Math.abs(dx) > 90) {
      const dir = dx > 0 ? "know" : "again";
      wrap.style.transition = "transform 0.25s ease, opacity 0.25s ease";
      wrap.style.transform = `translateX(${dx > 0 ? 600 : -600}px) rotate(${dx > 0 ? 30 : -30}deg)`;
      wrap.style.opacity = "0";
      setTimeout(() => swipeCard(dir), 220);
    } else {
      wrap.style.transition = "transform 0.2s ease";
      wrap.style.transform = "";
    }
  }

  wrap.addEventListener("pointerdown", onPointerDown);
  wrap.addEventListener("pointermove", onPointerMove);
  wrap.addEventListener("pointerup", onPointerUp);
  wrap.addEventListener("pointercancel", onPointerUp);
}

function formatHistoryDate(iso) {
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const months = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${dd} ${months[d.getMonth()]} · ${hh}:${mm}`;
  } catch (e) {
    return "";
  }
}

// ==== Rendering ====
function render() {
  if (state.screen === "home") return renderHome();
  if (state.screen === "topics") return renderTopics();
  if (state.screen === "quiz") return renderQuiz();
  if (state.screen === "results") return renderResults();
  if (state.screen === "locked") return renderLocked();
  if (state.screen === "history") return renderHistory();
  if (state.screen === "flashcardTopics") return renderFlashcardTopics();
  if (state.screen === "flashcards") return renderFlashcards();
  if (state.screen === "conspectTopics") return renderConspectTopics();
  if (state.screen === "conspect") return renderConspect();
}

function avatarHtml(size) {
  size = size || 40;
  if (currentUser && currentUser.photo_url) {
    return `<img src="${currentUser.photo_url}" class="avatar" style="width:${size}px;height:${size}px" />`;
  }
  const initial = currentUser && currentUser.first_name ? currentUser.first_name[0].toUpperCase() : "🇺🇦";
  return `<div class="avatar avatar-fallback" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px">${initial}</div>`;
}

function renderHome() {
  const totalQ = totalQuestionsInBank();
  const coursePct = courseCompletionPct();
  const topicsCount = TOPICS.length;
  const streak = data.streak.count || 0;

  const lastTopic = data.lastTopicId ? TOPICS.find((t) => t.id === data.lastTopicId) : null;
  const lastTopicIdx = lastTopic ? TOPICS.indexOf(lastTopic) : -1;
  const lastStats = lastTopic ? topicStats(lastTopic.id) : null;

  root.innerHTML = `
    <div class="top-bar">
      <div class="top-bar-title">ЗНО / НМТ</div>
      ${avatarHtml(40)}
    </div>

    <div class="hero-card">
      <div class="hero-icon">${ICONS.emblem}</div>
      <div class="hero-title">Історія України · Тренажер НМТ</div>
      <div class="hero-subtitle">14 розділів. Понад ${totalQ} запитань.<br>Готуйся до НМТ крок за кроком.</div>
    </div>

    <button class="choose-topic-btn" id="chooseTopicBtn">Обрати розділ</button>

    ${
      lastTopic
        ? `<div class="continue-card" id="continueCard">
            <div class="continue-icon">${toRoman(lastTopicIdx + 1)}</div>
            <div class="continue-info">
              <div class="continue-title">${lastTopic.title}</div>
              <div class="continue-sub">Останній результат: ${lastStats.bestPct}% · продовжити навчання</div>
            </div>
            <div class="continue-arrow">›</div>
          </div>`
        : ""
    }

    ${
      CONFIG.MONETIZATION_ENABLED && !isOwner && !isPremiumUser && CONFIG.PRICING_TIERS
        ? `<div class="pricing-teaser" id="pricingTeaser">
            <div class="pricing-teaser-title">Повний доступ до всіх розділів</div>
            <div class="pricing-teaser-row">
              ${CONFIG.PRICING_TIERS.map((t) => `<div class="pricing-teaser-chip"><span>${t.title}</span><b>${t.stars} ⭐</b></div>`).join("")}
            </div>
          </div>`
        : ""
    }

    <div class="section-title">Мій прогрес</div>
    <div class="stats-grid">
      <div class="stat-card stat-blue">
        <div class="stat-icon">${ICONS.shield}</div>
        <div class="stat-value">${Math.min(100, Math.round((data.totalCorrectEver / totalQ) * 100))}%</div>
        <div class="stat-label">Рейтинг</div>
      </div>
      <div class="stat-card stat-green">
        <div class="stat-icon">${ICONS.scroll}</div>
        <div class="stat-value">${coursePct}%</div>
        <div class="stat-label">Курс пройдено</div>
      </div>
      <div class="stat-card stat-orange">
        <div class="stat-icon">${ICONS.banner}</div>
        <div class="stat-value">${topicsCount}</div>
        <div class="stat-label">Розділів у курсі</div>
      </div>
      <div class="stat-card stat-red">
        <div class="stat-icon">${ICONS.flame}</div>
        <div class="stat-value">${streak}</div>
        <div class="stat-label">Серія днів</div>
      </div>
    </div>

    <button class="history-link-btn" id="conspectsLinkBtn">
      <span>${ICONS.scroll}</span>
      <span style="flex:1; text-align:left;">Конспекти</span>
      <span class="continue-arrow">›</span>
    </button>

    <button class="history-link-btn" id="flashcardsLinkBtn">
      <span>${ICONS.book}</span>
      <span style="flex:1; text-align:left;">Картки для повторення</span>
      <span class="continue-arrow">›</span>
    </button>

    <button class="history-link-btn" id="historyLinkBtn">
      <span>${ICONS.scroll}</span>
      <span style="flex:1; text-align:left;">Історія проходжень</span>
      <span>${data.history.length ? data.history.length : ""}</span>
      <span class="continue-arrow">›</span>
    </button>

    <div class="footer-note">Прогрес зберігається на цьому пристрої</div>
  `;

  document.getElementById("chooseTopicBtn").addEventListener("click", goTopics);
  document.getElementById("conspectsLinkBtn").addEventListener("click", goConspectTopics);
  document.getElementById("flashcardsLinkBtn").addEventListener("click", goFlashcardTopics);
  document.getElementById("historyLinkBtn").addEventListener("click", goHistory);
  const pricingTeaser = document.getElementById("pricingTeaser");
  if (pricingTeaser) pricingTeaser.addEventListener("click", goTopics);
  const continueCard = document.getElementById("continueCard");
  if (continueCard) {
    continueCard.addEventListener("click", () => {
      if (topicIsLocked(lastTopicIdx)) {
        state = { screen: "locked", topicIndex: lastTopicIdx, quiz: null };
        render();
      } else {
        startQuiz(lastTopicIdx);
      }
    });
  }
}

function renderTopics() {
  let topicsHtml = "";
  TOPICS.forEach((topic, idx) => {
    const stats = topicStats(topic.id);
    const locked = topicIsLocked(idx);
    topicsHtml += `
      <div class="topic-card ${locked ? "topic-locked" : ""}" data-topic-index="${idx}">
        <div class="topic-icon">${toRoman(idx + 1)}</div>
        <div class="topic-info">
          <p class="topic-title">${topic.title}</p>
          <p class="topic-period">${topic.period}</p>
          ${
            locked
              ? `<span class="lock-badge">Premium · Stars</span>`
              : `<div class="topic-progress-row">
                  <div class="progress-bar"><div class="progress-bar-fill" style="width:${stats.bestPct}%"></div></div>
                  <span class="topic-progress-pct">${stats.bestPct}%</span>
                </div>`
          }
        </div>
      </div>`;
  });

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">Обери розділ</div>
    </div>
    <div class="topics-list">${topicsHtml}</div>
    <div class="footer-note">По 10 випадкових питань із кожного розділу</div>
  `;

  document.getElementById("backBtn").addEventListener("click", goHome);
  document.querySelectorAll(".topic-card").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.topicIndex);
      if (topicIsLocked(idx)) {
        state = { screen: "locked", topicIndex: idx, quiz: null };
        render();
      } else {
        startQuiz(idx);
      }
    });
  });
}

function renderLocked() {
  const topic = TOPICS[state.topicIndex];
  const tiers = CONFIG.PRICING_TIERS || [];

  const tiersHtml = tiers
    .map(
      (tier) => `
      <button class="tier-btn" data-tier-id="${tier.id}">
        <span class="tier-btn-title">${tier.title}</span>
        <span class="tier-btn-hint">${tier.hint}</span>
        <span class="tier-btn-price">${tier.stars} ⭐</span>
      </button>`
    )
    .join("");

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">${topic.title}</div>
    </div>
    <div class="paywall-card">
      <div class="icon">${ICONS.seal}</div>
      <h2>Цей розділ — преміум</h2>
      <p>Розблокуй усі розділи за Telegram Stars — оплата одразу тут, без переходу в чат із ботом. Обери тариф:</p>
      <div class="tiers-list">${tiersHtml}</div>
    </div>
  `;
  document.getElementById("backBtn").addEventListener("click", goTopics);
  document.querySelectorAll(".tier-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => buyPremium(e.currentTarget, e.currentTarget.dataset.tierId));
  });
}

function renderHistory() {
  const history = data.history || [];

  let listHtml = "";
  if (!history.length) {
    listHtml = `<div class="history-empty">Ще немає завершених проходжень.<br>Пройди свій перший квіз — і запис з'явиться тут.</div>`;
  } else {
    history.forEach((h) => {
      let tone = "verdigris";
      if (h.pct >= 90) tone = "gold";
      else if (h.pct >= 70) tone = "wine";
      else if (h.pct >= 50) tone = "lapis";
      listHtml += `
        <div class="history-entry history-tone-${tone}">
          <div class="history-entry-main">
            <div class="history-entry-title">${escapeHtml(h.topicTitle)}</div>
            <div class="history-entry-date">${formatHistoryDate(h.date)}</div>
          </div>
          <div class="history-entry-score">${h.score}/${h.total}<span class="history-entry-pct">${h.pct}%</span></div>
        </div>`;
    });
  }

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">Історія проходжень</div>
    </div>
    <div class="history-list">${listHtml}</div>
    ${history.length ? `<div class="footer-note">Останні ${history.length} із ${HISTORY_LIMIT} записів, що зберігаються</div>` : ""}
  `;

  document.getElementById("backBtn").addEventListener("click", goHome);
}

function renderFlashcardTopics() {
  const availableIds = flashcardTopicIds();
  let topicsHtml = "";
  TOPICS.forEach((topic, idx) => {
    const hasCards = availableIds.includes(topic.id);
    const locked = hasCards && topicIsLocked(idx);
    const stats = hasCards ? flashcardStats(topic.id) : null;
    topicsHtml += `
      <div class="topic-card ${!hasCards || locked ? "topic-locked" : ""}" data-topic-index="${idx}" data-has-cards="${hasCards ? "1" : "0"}">
        <div class="topic-icon">${toRoman(idx + 1)}</div>
        <div class="topic-info">
          <p class="topic-title">${topic.title}</p>
          <p class="topic-period">${topic.period}</p>
          ${
            !hasCards
              ? `<span class="lock-badge">Картки скоро</span>`
              : locked
              ? `<span class="lock-badge">Premium · Stars</span>`
              : `<div class="topic-progress-row">
                  <div class="progress-bar"><div class="progress-bar-fill" style="width:${Math.round((stats.known / stats.total) * 100)}%"></div></div>
                  <span class="topic-progress-pct">${stats.known}/${stats.total}</span>
                </div>`
          }
        </div>
      </div>`;
  });

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">Картки для повторення</div>
    </div>
    <div class="topics-list">${topicsHtml}</div>
    <div class="footer-note">Свайп картки вправо — знаю, вліво — повторити</div>
  `;

  document.getElementById("backBtn").addEventListener("click", goHome);
  document.querySelectorAll(".topic-card[data-has-cards='1']").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.topicIndex);
      if (topicIsLocked(idx)) {
        state = { screen: "locked", topicIndex: idx, quiz: null };
        render();
      } else {
        goFlashcardDeck(idx);
      }
    });
  });
}

function renderFlashcards() {
  const topic = TOPICS[state.topicIndex];
  const cards = (typeof FLASHCARDS !== "undefined" && FLASHCARDS[topic.id]) || [];
  const deck = state.deck;

  if (!deck || deck.pos >= deck.order.length) {
    const stats = flashcardStats(topic.id);
    const knownCount = deck ? deck.knownThisRound.length : 0;
    const repeatCount = deck ? deck.repeatThisRound.length : 0;
    const isReviewRound = deck && deck.mode === "review";

    root.innerHTML = `
      <div class="quiz-header">
        <button class="back-btn" id="backBtn">‹</button>
        <div class="quiz-progress-text">${topic.title}</div>
      </div>
      <div class="results-card results-tone-gold">
        <div class="results-emoji">${ICONS.laurel}</div>
        <div class="results-score">${stats.known} / ${stats.total}</div>
        <div class="results-caption">Позначено «знаю» загалом: ${stats.known} із ${stats.total} карток.</div>
      </div>
      <div class="deck-round-rows">
        <div class="deck-round-row deck-round-know">
          <span>${ICONS.check} Знаю</span><b>${knownCount}</b>
        </div>
        <button class="deck-round-row deck-round-repeat" id="rowRepeat" ${repeatCount ? "" : "disabled"}>
          <span>${ICONS.cross} Повторити</span><b>${repeatCount}</b>
        </button>
      </div>
      ${repeatCount ? `<div class="footer-note">Натисни «Повторити» — покажу пояснення до цих карток і пройдемо їх ще раз</div>` : ""}
      <button class="next-btn" id="restartDeckBtn">${isReviewRound ? "Почати колоду заново" : "Пройти ще раз"}</button>
      <button class="link-btn" id="toTopicsBtn">До вибору теми</button>
    `;
    document.getElementById("backBtn").addEventListener("click", goFlashcardTopics);
    document.getElementById("restartDeckBtn").addEventListener("click", () => goFlashcardDeck(state.topicIndex));
    document.getElementById("toTopicsBtn").addEventListener("click", goFlashcardTopics);
    const rowRepeat = document.getElementById("rowRepeat");
    if (rowRepeat && repeatCount) {
      rowRepeat.addEventListener("click", () => startReviewRound(deck.repeatThisRound));
    }
    return;
  }

  const cardIndex = deck.order[deck.pos];
  const card = cards[cardIndex];
  const known = (data.flashcards[topic.id] || []).includes(cardIndex);
  const isReview = deck.mode === "review";

  const cardHtml = isReview
    ? `<div class="flashcard-review-card">
        ${known ? `<div class="flashcard-known-badge">${ICONS.check}</div>` : ""}
        <div class="flashcard-review-front">${escapeHtml(card.front)}</div>
        <div class="flashcard-review-divider"></div>
        <div class="flashcard-review-label">Пояснення</div>
        <div class="flashcard-review-back">${escapeHtml(card.back)}</div>
      </div>`
    : `<div class="flashcard-flip ${deck.flipped ? "is-flipped" : ""}" id="cardFlip">
        <div class="flashcard-face flashcard-front">
          ${known ? `<div class="flashcard-known-badge">${ICONS.check}</div>` : ""}
          <div class="flashcard-text">${escapeHtml(card.front)}</div>
          <div class="flashcard-hint">Торкнись, щоб перевернути</div>
        </div>
        <div class="flashcard-face flashcard-back">
          <div class="flashcard-text">${escapeHtml(card.back)}</div>
        </div>
      </div>`;

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">${topic.title} · ${isReview ? "повторення" : "картка"} ${deck.pos + 1} з ${deck.order.length}</div>
    </div>
    <div class="flashcard-scene">
      <div class="flashcard-swipe-wrap" id="cardSwipeWrap">${cardHtml}</div>
    </div>
    <div class="flashcard-actions">
      <button class="flashcard-btn flashcard-btn-again" id="btnAgain">${ICONS.cross} Повторити</button>
      <button class="flashcard-btn flashcard-btn-know" id="btnKnow">${ICONS.check} Знаю</button>
    </div>
    <div class="footer-note">${isReview ? "Пояснення вже видно — оціни, чи запам'ятав" : "Свайп картки вправо — знаю, вліво — повторити"}</div>
  `;

  document.getElementById("backBtn").addEventListener("click", goFlashcardTopics);
  document.getElementById("btnAgain").addEventListener("click", () => swipeCard("again"));
  document.getElementById("btnKnow").addEventListener("click", () => swipeCard("know"));
  setupCardFlipAndSwipe();
}

function renderConspectTopics() {
  const availableIds = conspectTopicIds();
  let topicsHtml = "";
  TOPICS.forEach((topic, idx) => {
    const hasConspect = availableIds.includes(topic.id);
    const locked = hasConspect && topicIsLocked(idx);
    topicsHtml += `
      <div class="topic-card ${!hasConspect || locked ? "topic-locked" : ""}" data-topic-index="${idx}" data-has-conspect="${hasConspect ? "1" : "0"}">
        <div class="topic-icon">${toRoman(idx + 1)}</div>
        <div class="topic-info">
          <p class="topic-title">${topic.title}</p>
          <p class="topic-period">${topic.period}</p>
          ${
            !hasConspect
              ? `<span class="lock-badge">Конспект скоро</span>`
              : locked
              ? `<span class="lock-badge">Premium · Stars</span>`
              : `<span class="topic-progress-pct">Читати →</span>`
          }
        </div>
      </div>`;
  });

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">Конспекти</div>
    </div>
    <div class="topics-list">${topicsHtml}</div>
    <div class="footer-note">Основна інформація по темі й короткий висновок</div>
  `;

  document.getElementById("backBtn").addEventListener("click", goHome);
  document.querySelectorAll(".topic-card[data-has-conspect='1']").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.topicIndex);
      if (topicIsLocked(idx)) {
        state = { screen: "locked", topicIndex: idx, quiz: null };
        render();
      } else {
        goConspect(idx);
      }
    });
  });
}

function renderConspect() {
  const topic = TOPICS[state.topicIndex];
  const conspect = (typeof CONSPECTS !== "undefined" && CONSPECTS[topic.id]) || null;

  if (!conspect) {
    // Захист про всяк випадок — сюди не мали б потрапити, бо в списку тем такі не клікабельні.
    goConspectTopics();
    return;
  }

  const paragraphsHtml = conspect.paragraphs.map((p) => `<p class="conspect-paragraph">${escapeHtml(p)}</p>`).join("");

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">${topic.title}</div>
    </div>
    <div class="conspect-body">
      ${paragraphsHtml}
      <div class="conspect-conclusion">${escapeHtml(conspect.conclusion)}</div>
    </div>
    <div style="height:16px"></div>
    <button class="next-btn" id="toQuizBtn">Перевірити себе тестом</button>
    <button class="link-btn" id="toTopicsBtn">До вибору теми</button>
  `;

  document.getElementById("backBtn").addEventListener("click", goConspectTopics);
  document.getElementById("toTopicsBtn").addEventListener("click", goConspectTopics);
  document.getElementById("toQuizBtn").addEventListener("click", () => startQuiz(state.topicIndex));
}

function renderQuiz() {
  const topic = TOPICS[state.topicIndex];
  const q = state.quiz;
  const question = q.questions[q.current];

  let optionsHtml = "";
  question.options.forEach((opt, i) => {
    let cls = "option-btn";
    let icon = "";
    if (q.answered) {
      cls += " disabled";
      if (i === question.correct) { cls += " correct"; icon = ICONS.check; }
      else if (i === q.selectedIndex) { cls += " wrong"; icon = ICONS.cross; }
    }
    optionsHtml += `<button class="${cls}" data-option-index="${i}">
      <span class="option-letter">${OPTION_LETTERS[i] || i + 1}</span>
      <span style="flex:1">${escapeHtml(opt)}</span>
      <span class="option-check">${icon}</span>
    </button>`;
  });

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">${topic.title} · питання ${q.current + 1} з ${q.questions.length} · бал ${q.score}</div>
    </div>
    <div class="question-card">
      ${question.img ? `<div class="question-image-wrap"><img class="question-image" src="${escapeHtml(question.img)}" alt="Ілюстрація до питання" loading="lazy" /></div>` : ""}
      <p class="question-text">${escapeHtml(question.q)}</p>
    </div>
    <div class="options-list">${optionsHtml}</div>
    ${
      q.answered
        ? (() => {
            const wasWrong = q.selectedIndex !== question.correct;
            return `<div class="explanation-box ${wasWrong ? "explanation-wrong" : "explanation-right"}">
              <div class="explanation-label">${wasWrong ? "Правильна відповідь" : "Правильно"}</div>
              ${wasWrong ? `<div class="explanation-correct-answer">${escapeHtml(question.options[question.correct])}</div>` : ""}
              <div class="explanation-text">${escapeHtml(question.explanation)}</div>
            </div>`;
          })()
        : ""
    }
    <div style="height:16px"></div>
    <button class="next-btn" id="nextBtn" ${q.answered ? "" : "disabled"}>
      ${q.current + 1 < q.questions.length ? "Далі →" : "Завершити"}
    </button>
  `;

  document.getElementById("backBtn").addEventListener("click", goTopics);
  document.getElementById("nextBtn").addEventListener("click", nextQuestion);
  document.querySelectorAll(".option-btn").forEach((el) => {
    el.addEventListener("click", () => answerQuestion(Number(el.dataset.optionIndex)));
  });
}

function renderResults() {
  const topic = TOPICS[state.topicIndex];
  const q = state.quiz;
  const pct = Math.round((q.score / q.questions.length) * 100);
  let icon = ICONS.book;
  let tone = "verdigris";
  let caption = "Є куди рости — повтори тему ще раз.";
  if (pct >= 90) { icon = ICONS.laurel; tone = "gold"; caption = "Чудовий результат! Розділ опановано."; }
  else if (pct >= 70) { icon = ICONS.flame; tone = "wine"; caption = "Добре! Ще трохи практики — і буде відмінно."; }
  else if (pct >= 50) { icon = ICONS.fist; tone = "lapis"; caption = "Непогано, але варто повторити матеріал."; }

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">${topic.title}</div>
    </div>
    <div class="results-card results-tone-${tone}">
      <div class="results-emoji">${icon}</div>
      <div class="results-score">${q.score} / ${q.questions.length}</div>
      <div class="results-caption">${caption}</div>
    </div>
    <div class="result-actions">
      <button class="btn-secondary" id="homeBtn">До тем</button>
      <button class="btn-primary" id="retryBtn">Спробувати ще</button>
    </div>
  `;

  document.getElementById("backBtn").addEventListener("click", goTopics);
  document.getElementById("homeBtn").addEventListener("click", goTopics);
  document.getElementById("retryBtn").addEventListener("click", () => startQuiz(state.topicIndex));
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

render();
fetchPremiumStatus(); // асинхронно уточнює реальний преміум-статус із бекенду і перемальовує екран
syncFromCloud(); // підтягує прогрес/історію з Telegram CloudStorage і мерджить з локальними даними
