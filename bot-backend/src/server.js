import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import {
  initDb,
  upsertUser,
  touchLastActive,
  setWriteAccess,
  grantPremium,
  recordPayment,
  getPremiumStatus,
  listActiveUserIds,
  listAllUsersWithStats,
  listAllPayments,
  getStats,
} from "./db.js";
import { sendMessage, sendInvoice, answerPreCheckoutQuery, setWebhook, getWebhookInfo } from "./telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "*",
  })
);

const PREMIUM_PRICE_STARS = Number(process.env.PREMIUM_PRICE_STARS || 300);

// ==== Health check (Render перевіряє цим, чи сервіс живий) ====
app.get("/health", (req, res) => res.json({ ok: true }));

// ==== Telegram webhook ====
app.post("/webhook", async (req, res) => {
  // Перевірка, що запит справді від Telegram, а не від когось стороннього
  const secret = req.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  // Відповідаємо Telegram одразу — обробку робимо "у фоні", щоб не тримати вебхук відкритим
  res.sendStatus(200);

  const update = req.body;
  try {
    await handleUpdate(update);
  } catch (err) {
    console.error("[webhook] Помилка обробки update:", err);
  }
});

async function handleUpdate(update) {
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const from = msg.from;

    await upsertUser({ telegramId: from.id, username: from.username, firstName: from.first_name });

    if (msg.text === "/start") {
      await sendMessage(
        chatId,
        "Привіт! Це бот «Історія України · Тренажер НМТ».\n\nНатисни кнопку меню внизу, щоб відкрити тренажер, або напиши /premium, щоб дізнатись про повний доступ."
      );
      return;
    }

    if (msg.text === "/premium") {
      const status = await getPremiumStatus(from.id);
      if (status.isPremium) {
        await sendMessage(chatId, `У тебе вже є преміум-доступ до ${new Date(status.premiumUntil).toLocaleDateString("uk-UA")}.`);
        return;
      }
      await sendInvoice(chatId, {
        title: "Преміум-доступ на 30 днів",
        description: "Усі 14 розділів і 600+ питань без обмежень протягом 30 днів.",
        payload: `premium_30d_${from.id}_${Date.now()}`,
        amountStars: PREMIUM_PRICE_STARS,
      });
      return;
    }

    if (msg.successful_payment) {
      const until = await grantPremium(from.id, 30);
      await recordPayment({
        telegramId: from.id,
        chargeId: msg.successful_payment.telegram_payment_charge_id,
        amountStars: msg.successful_payment.total_amount,
      });
      await sendMessage(chatId, `Дякую! Преміум-доступ активовано до ${new Date(until).toLocaleDateString("uk-UA")}. Гарного навчання!`);
      return;
    }

    if (msg.web_app_data) {
      // Резерв на майбутнє: якщо застосунок надсилатиме дані назад у бота через Telegram.WebApp.sendData
    }

    // Дозвіл на проактивні нагадування (Mini App викликає requestWriteAccess)
    if (msg.write_access_granted) {
      await setWriteAccess(from.id, true);
    }

    await touchLastActive(from.id);
    return;
  }

  if (update.pre_checkout_query) {
    // Має відповісти в межах ~10 секунд
    await answerPreCheckoutQuery(update.pre_checkout_query.id, true);
    return;
  }
}

// ==== API для фронтенду (Mini App перевіряє преміум-статус) ====
app.get("/api/status/:telegramId", async (req, res) => {
  const telegramId = Number(req.params.telegramId);
  if (!Number.isFinite(telegramId)) return res.status(400).json({ error: "bad telegramId" });
  const status = await getPremiumStatus(telegramId);
  res.json(status);
});

// ==== Адмінські ендпоінти (захищені окремим секретом, не плутати з webhook-секретом) ====
function requireAdmin(req, res, next) {
  if (req.get("X-Admin-Secret") !== process.env.ADMIN_SECRET) return res.sendStatus(403);
  next();
}

// Розсилка всім (або лише активним за останні N днів) користувачам.
// Приклад виклику: POST /admin/broadcast  body: { "text": "...", "sinceDays": 14 }
app.post("/admin/broadcast", requireAdmin, async (req, res) => {
  const { text, sinceDays } = req.body || {};
  if (!text) return res.status(400).json({ error: "text required" });

  const ids = await listActiveUserIds(sinceDays ? { sinceDays } : {});
  let sent = 0;
  let failed = 0;

  // Telegram дозволяє ~30 повідомлень/секунду загалом на бота — тримаємось з запасом, по 20/сек.
  const BATCH = 20;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (id) => {
        const result = await sendMessage(id, text);
        if (result.ok) sent += 1;
        else failed += 1;
      })
    );
    await new Promise((r) => setTimeout(r, 1000));
  }

  res.json({ total: ids.length, sent, failed });
});

// Одноразовий виклик після деплою, щоб зареєструвати webhook URL у Telegram.
// Приклад: GET /admin/set-webhook  (заголовок X-Admin-Secret обов'язковий)
app.get("/admin/set-webhook", requireAdmin, async (req, res) => {
  const base = process.env.BASE_URL || `https://${req.get("host")}`;
  const result = await setWebhook(`${base}/webhook`, process.env.WEBHOOK_SECRET);
  res.json(result);
});

app.get("/admin/webhook-info", requireAdmin, async (req, res) => {
  const info = await getWebhookInfo();
  res.json(info);
});

// ==== Супер-адмін API: користувачі, платежі, зведена статистика ====
app.get("/admin/stats", requireAdmin, async (req, res) => {
  const stats = await getStats();
  res.json(stats);
});

app.get("/admin/users", requireAdmin, async (req, res) => {
  const users = await listAllUsersWithStats();
  res.json({ users });
});

app.get("/admin/payments", requireAdmin, async (req, res) => {
  const payments = await listAllPayments();
  res.json({ payments });
});

// Статична сторінка супер-адмін дашборду (пароль вводиться прямо на сторінці —
// вона сама шле той самий X-Admin-Secret до /admin/* ендпоінтів вище).
app.use("/admin", express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`[server] Слухаю на порту ${PORT}`));
  })
  .catch((err) => {
    console.error("[server] Не вдалося ініціалізувати базу даних:", err);
    process.exit(1);
  });
