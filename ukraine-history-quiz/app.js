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
      <div class="hero-text">
        <div class="hero-title">Історія України</div>
        <div class="hero-subtitle">Готуйся до НМТ крок за кроком</div>
      </div>
      <div class="hero-icon">📖</div>
    </div>

    <button class="choose-topic-btn" id="chooseTopicBtn">🔍&nbsp; Обрати тему</button>

    ${
      lastTopic
        ? `<div class="continue-card" id="continueCard">
            <div class="continue-icon">${lastTopic.icon}</div>
            <div class="continue-info">
              <div class="continue-title">${lastTopic.title}</div>
              <div class="continue-sub">Останній результат: ${lastStats.bestPct}% · продовжити навчання</div>
            </div>
            <div class="continue-arrow">›</div>
          </div>`
        : ""
    }

    <div class="section-title">Мій прогрес</div>
    <div class="stats-grid">
      <div class="stat-card stat-blue">
        <div class="stat-icon">🛡️</div>
        <div class="stat-value">${data.totalCorrectEver}/${totalQ}</div>
        <div class="stat-label">Рейтинг</div>
      </div>
      <div class="stat-card stat-green">
        <div class="stat-icon">◐</div>
        <div class="stat-value">${coursePct}%</div>
        <div class="stat-label">Курс пройдено</div>
      </div>
      <div class="stat-card stat-orange">
        <div class="stat-icon">🚩</div>
        <div class="stat-value">${topicsCount}</div>
        <div class="stat-label">Тем у курсі</div>
      </div>
      <div class="stat-card stat-red">
        <div class="stat-icon">🔥</div>
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
        <div class="topic-icon">${topic.icon}</div>
        <div class="topic-info">
          <p class="topic-title">${topic.title}</p>
          <p class="topic-period">${topic.period}</p>
          ${
            locked
              ? `<span class="lock-badge">🔒 Premium · Stars</span>`
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
      <div class="quiz-progress-text">Обери тему</div>
    </div>
    <div class="topics-list">${topicsHtml}</div>
    <div class="footer-note">По 10 випадкових питань із кожної теми</div>
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
      <div class="icon">⭐️</div>
      <h2>Ця тема — преміум</h2>
      <p>Розблокуй усі теми одноразово за Telegram Stars. Оплата поки не підключена — скоро буде доступна прямо тут.</p>
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
    if (q.answered) {
      cls += " disabled";
      if (i === question.correct) cls += " correct";
      else if (i === q.selectedIndex) cls += " wrong";
    }
    optionsHtml += `<button class="${cls}" data-option-index="${i}">${escapeHtml(opt)}</button>`;
  });

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">${topic.title} · ${q.current + 1}/${q.questions.length} · ✅ ${q.score}</div>
    </div>
    <div class="question-card">
      <p class="question-text">${escapeHtml(question.q)}</p>
    </div>
    <div class="options-list">${optionsHtml}</div>
    ${q.answered ? `<div class="explanation-box">💡 ${escapeHtml(question.explanation)}</div>` : ""}
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
  let emoji = "📚";
  let caption = "Є куди рости — повтори тему ще раз.";
  if (pct >= 90) { emoji = "🏆"; caption = "Чудовий результат! Тему опановано."; }
  else if (pct >= 70) { emoji = "🔥"; caption = "Добре! Ще трохи практики — і буде відмінно."; }
  else if (pct >= 50) { emoji = "💪"; caption = "Непогано, але варто повторити матеріал."; }

  root.innerHTML = `
    <div class="quiz-header">
      <button class="back-btn" id="backBtn">‹</button>
      <div class="quiz-progress-text">${topic.title}</div>
    </div>
    <div class="results-card">
      <div class="results-emoji">${emoji}</div>
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
