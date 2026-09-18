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
const STORAGE_KEY = `uahist_progress_${userId}`;

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (e) {}
}

let progress = loadProgress(); // { [topicId]: { bestScore, lastScore, attempts, answeredCorrectIds: [] } }

function topicIsLocked(topicIndex) {
  if (isOwner) return false;
  if (!CONFIG.MONETIZATION_ENABLED) return false; // поки монетизація вимкнена — усе відкрито
  return topicIndex >= CONFIG.FREE_TOPICS_COUNT;
}

function topicStats(topicId) {
  const p = progress[topicId];
  if (!p) return { bestPct: 0, attempts: 0 };
  return { bestPct: p.bestScore != null ? Math.round((p.bestScore / 10) * 100) : 0, attempts: p.attempts || 0 };
}

function overallStats() {
  let totalPct = 0;
  let count = 0;
  TOPICS.forEach((t) => {
    const s = topicStats(t.id);
    totalPct += s.bestPct;
    count += 1;
  });
  return count ? Math.round(totalPct / count) : 0;
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
  state = {
    screen: "quiz",
    topicIndex,
    quiz: {
      questions,
      current: 0,
      score: 0,
      answered: false,
      selectedIndex: null,
    },
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
  const prev = progress[topic.id] || { bestScore: 0, attempts: 0 };
  progress[topic.id] = {
    bestScore: Math.max(prev.bestScore || 0, q.score),
    lastScore: q.score,
    attempts: (prev.attempts || 0) + 1,
  };
  saveProgress(progress);
  state.screen = "results";
  render();
}

function goHome() {
  state = { screen: "home", topicIndex: null, quiz: null };
  render();
}

// ==== Rendering ====
function render() {
  if (state.screen === "home") return renderHome();
  if (state.screen === "quiz") return renderQuiz();
  if (state.screen === "results") return renderResults();
  if (state.screen === "locked") return renderLocked();
}

function renderHome() {
  const overall = overallStats();
  const name = currentUser && currentUser.first_name ? currentUser.first_name : "гість";

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
              ? `<span class="lock-badge">🔒 Preмium · Stars</span>`
              : `<div class="topic-progress-row">
                  <div class="progress-bar"><div class="progress-bar-fill" style="width:${stats.bestPct}%"></div></div>
                  <span class="topic-progress-pct">${stats.bestPct}%</span>
                </div>`
          }
        </div>
      </div>`;
  });

  root.innerHTML = `
    <div class="header">
      <div>
        <h1>${CONFIG.APP_NAME}</h1>
        <div class="subtitle">Привіт, ${escapeHtml(name)} 👋</div>
      </div>
    </div>
    <div class="overall-progress">
      <div class="label"><span>Загальний прогрес</span><span>${overall}%</span></div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${overall}%"></div></div>
    </div>
    <div class="topics-list">${topicsHtml}</div>
    <div class="footer-note">По 10 випадкових питань з кожної теми · Прогрес зберігається на пристрої</div>
  `;

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
  document.getElementById("backBtn").addEventListener("click", goHome);
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

  document.getElementById("backBtn").addEventListener("click", goHome);
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

  document.getElementById("backBtn").addEventListener("click", goHome);
  document.getElementById("homeBtn").addEventListener("click", goHome);
  document.getElementById("retryBtn").addEventListener("click", () => startQuiz(state.topicIndex));
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

render();
