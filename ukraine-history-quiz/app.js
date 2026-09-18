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
const STORAGE_KEY = `uahist_progress_v2_${userId}`;

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

function startQuiz(topicIndex) {
  const topic = TOPICS[topicIndex];
  const questions = shuffled(topic.questions).slice(0, 10);
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

function goFlashcardDeck(topicIndex) {
  const topic = TOPICS[topicIndex];
  const cards = (typeof FLASHCARDS !== "undefined" && FLASHCARDS[topic.id]) || [];
  const order = shuffled(cards.map((_, i) => i));
  state = {
    screen: "flashcards",
    topicIndex,
    quiz: null,
    deck: { order, pos: 0, flipped: false },
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
  }

  deck.pos += 1;
  deck.flipped = false;
  render();
}

function setupCardFlipAndSwipe() {
  const wrap = document.getElementById("cardSwipeWrap");
  const flip = document.getElementById("cardFlip");
  if (!wrap || !flip) return;

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
      state.deck.flipped = !state.deck.flipped;
      flip.classList.toggle("is-flipped");
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
        <div class="stat-value">${data.totalCorrectEver}/${totalQ}</div>
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
    root.innerHTML = `
      <div class="quiz-header">
        <button class="back-btn" id="backBtn">‹</button>
        <div class="quiz-progress-text">${topic.title}</div>
      </div>
      <div class="results-card results-tone-gold">
        <div class="results-emoji">${ICONS.laurel}</div>
        <div class="results-score">${stats.known} / ${stats.total}</div>
        <div class="results-caption">Колоду пройдено. Позначено «знаю»: ${stats.known} із ${stats.total} карток.</div>
      </div>
      <button class="next-btn" id="restartDeckBtn">Пройти ще раз</button>
      <button class="link-btn" id="toTopicsBtn">До вибору теми</button>
    `;
    document.getElementById("backBtn").addEventListener("click", goFlashcardTopics);
    document.getElementById("restartDeckBtn").addEventListener("click", () => goFlashcardDeck(state.topicIndex));
    document.getElementById("toTopicsBtn").addEventListener("click", goFlashcardTopics);
    return;
  }

  const cardIndex = deck.order[deck.pos];
  const card = cards[cardIndex];
  const known = (data.flashcards[topic.id] || []).includes(cardIndex);

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">${topic.title} · картка ${deck.pos + 1} з ${deck.order.length}</div>
    </div>
    <div class="flashcard-scene">
      <div class="flashcard-swipe-wrap" id="cardSwipeWrap">
        <div class="flashcard-flip ${deck.flipped ? "is-flipped" : ""}" id="cardFlip">
          <div class="flashcard-face flashcard-front">
            ${known ? `<div class="flashcard-known-badge">${ICONS.check}</div>` : ""}
            <div class="flashcard-text">${escapeHtml(card.front)}</div>
            <div class="flashcard-hint">Торкнись, щоб перевернути</div>
          </div>
          <div class="flashcard-face flashcard-back">
            <div class="flashcard-text">${escapeHtml(card.back)}</div>
          </div>
        </div>
      </div>
    </div>
    <div class="flashcard-actions">
      <button class="flashcard-btn flashcard-btn-again" id="btnAgain">${ICONS.cross} Повторити</button>
      <button class="flashcard-btn flashcard-btn-know" id="btnKnow">${ICONS.check} Знаю</button>
    </div>
    <div class="footer-note">Свайп картки вправо — знаю, вліво — повторити</div>
  `;

  document.getElementById("backBtn").addEventListener("click", goFlashcardTopics);
  document.getElementById("btnAgain").addEventListener("click", () => swipeCard("again"));
  document.getElementById("btnKnow").addEventListener("click", () => swipeCard("know"));
  setupCardFlipAndSwipe();
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
    ${q.answered ? `<div class="explanation-box">${escapeHtml(question.explanation)}</div>` : ""}
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
