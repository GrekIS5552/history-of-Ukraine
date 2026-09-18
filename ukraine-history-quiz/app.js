// ==== Telegram WebApp init ====
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
if (tg) {
  tg.ready();
  tg.expand();
  try { tg.setHeaderColor && tg.setHeaderColor("secondary_bg_color"); } catch (e) {}
}

const currentUser = tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user : null;
const userId = currentUser ? currentUser.id : "guest";
const isOwner = CONFIG.OWNER_TELEGRAM_IDS.includes(userId);

// ==== Progress storage (per-device, keyed by Telegram user id) ====
const STORAGE_KEY = `uahist_progress_v2_${userId}`;

function defaultData() {
  return {
    topics: {}, // { [topicId]: { bestScore, lastScore, attempts, correctEver } }
    totalCorrectEver: 0,
    lastTopicId: null,
    streak: { count: 0, lastActiveDate: null },
  };
}

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
  if (!CONFIG.MONETIZATION_ENABLED) return false; // поки монетизація вимкнена — усе відкрито
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

// ==== Rendering ====
function render() {
  if (state.screen === "home") return renderHome();
  if (state.screen === "topics") return renderTopics();
  if (state.screen === "quiz") return renderQuiz();
  if (state.screen === "results") return renderResults();
  if (state.screen === "locked") return renderLocked();
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
      <div class="hero-title">Літопис Історії України</div>
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

    <div class="section-title">Мій поступ</div>
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

    <div class="footer-note">Прогрес зберігається на цьому пристрої</div>
  `;

  document.getElementById("chooseTopicBtn").addEventListener("click", goTopics);
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
  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">${topic.title}</div>
    </div>
    <div class="paywall-card">
      <div class="icon">${ICONS.seal}</div>
      <h2>Цей розділ — преміум</h2>
      <p>Розблокуй усі розділи одноразово за Telegram Stars. Оплата поки не підключена — скоро буде доступна прямо тут.</p>
      <button class="next-btn" disabled>Розблокувати за Stars (скоро)</button>
    </div>
  `;
  document.getElementById("backBtn").addEventListener("click", goTopics);
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
      <div class="quiz-progress-text">${topic.title} · Питання ${q.current + 1} з ${q.questions.length} · Бал ${q.score}</div>
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
