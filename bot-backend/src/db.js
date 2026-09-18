import { createClient } from "@libsql/client";

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error("[db] TURSO_DATABASE_URL / TURSO_AUTH_TOKEN не задані в environment variables.");
}

export const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Викликається один раз при старті сервера — створює таблиці, якщо їх ще нема.
export async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      is_premium INTEGER NOT NULL DEFAULT 0,
      premium_until TEXT,
      write_access INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_active TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      telegram_payment_charge_id TEXT NOT NULL,
      amount_stars INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  console.log("[db] Схему перевірено/створено.");
}

// ==== Users ====

export async function upsertUser({ telegramId, username, firstName }) {
  const now = new Date().toISOString();
  await db.execute({
    sql: `
      INSERT INTO users (telegram_id, username, first_name, created_at, last_active)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_active = excluded.last_active
    `,
    args: [telegramId, username ?? null, firstName ?? null, now, now],
  });
}

export async function touchLastActive(telegramId) {
  await db.execute({
    sql: `UPDATE users SET last_active = ? WHERE telegram_id = ?`,
    args: [new Date().toISOString(), telegramId],
  });
}

export async function setWriteAccess(telegramId, value) {
  await db.execute({
    sql: `UPDATE users SET write_access = ? WHERE telegram_id = ?`,
    args: [value ? 1 : 0, telegramId],
  });
}

export async function getUser(telegramId) {
  const res = await db.execute({
    sql: `SELECT * FROM users WHERE telegram_id = ?`,
    args: [telegramId],
  });
  return res.rows[0] ?? null;
}

export async function listAllUserIds() {
  const res = await db.execute(`SELECT telegram_id FROM users`);
  return res.rows.map((r) => r.telegram_id);
}

export async function listActiveUserIds({ sinceDays } = {}) {
  if (!sinceDays) return listAllUserIds();
  const cutoff = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const res = await db.execute({
    sql: `SELECT telegram_id FROM users WHERE last_active >= ?`,
    args: [cutoff],
  });
  return res.rows.map((r) => r.telegram_id);
}

// ==== Premium / payments ====

export async function grantPremium(telegramId, days = 30) {
  const until = new Date(Date.now() + days * 86400000).toISOString();
  await db.execute({
    sql: `UPDATE users SET is_premium = 1, premium_until = ? WHERE telegram_id = ?`,
    args: [until, telegramId],
  });
  return until;
}

export async function recordPayment({ telegramId, chargeId, amountStars }) {
  await db.execute({
    sql: `INSERT INTO payments (telegram_id, telegram_payment_charge_id, amount_stars, created_at) VALUES (?, ?, ?, ?)`,
    args: [telegramId, chargeId, amountStars, new Date().toISOString()],
  });
}

export async function getPremiumStatus(telegramId) {
  const user = await getUser(telegramId);
  if (!user) return { isPremium: false, premiumUntil: null };
  const isPremium = !!user.is_premium && user.premium_until && new Date(user.premium_until) > new Date();
  return { isPremium, premiumUntil: user.premium_until ?? null };
}

// ==== Супер-адмін: список користувачів, платежів, зведена статистика ====

// Повний список користувачів + скільки кожен заплатив і чи преміум зараз активний "по факту" (не лише прапорець).
export async function listAllUsersWithStats() {
  const res = await db.execute(`
    SELECT
      u.telegram_id,
      u.username,
      u.first_name,
      u.is_premium,
      u.premium_until,
      u.write_access,
      u.created_at,
      u.last_active,
      COALESCE(p.total_stars, 0) AS total_stars_paid,
      COALESCE(p.payments_count, 0) AS payments_count
    FROM users u
    LEFT JOIN (
      SELECT telegram_id, SUM(amount_stars) AS total_stars, COUNT(*) AS payments_count
      FROM payments
      GROUP BY telegram_id
    ) p ON p.telegram_id = u.telegram_id
    ORDER BY u.last_active DESC
  `);
  const now = new Date();
  return res.rows.map((r) => ({
    telegramId: r.telegram_id,
    username: r.username,
    firstName: r.first_name,
    isPremium: !!r.is_premium && r.premium_until && new Date(r.premium_until) > now,
    premiumUntil: r.premium_until ?? null,
    writeAccess: !!r.write_access,
    createdAt: r.created_at,
    lastActive: r.last_active,
    totalStarsPaid: Number(r.total_stars_paid) || 0,
    paymentsCount: Number(r.payments_count) || 0,
  }));
}

// Повна історія платежів, найновіші перші.
export async function listAllPayments() {
  const res = await db.execute(`
    SELECT p.*, u.username, u.first_name
    FROM payments p
    LEFT JOIN users u ON u.telegram_id = p.telegram_id
    ORDER BY p.created_at DESC
  `);
  return res.rows.map((r) => ({
    id: r.id,
    telegramId: r.telegram_id,
    username: r.username,
    firstName: r.first_name,
    chargeId: r.telegram_payment_charge_id,
    amountStars: r.amount_stars,
    createdAt: r.created_at,
  }));
}

// Зведена статистика для верхньої панелі дашборду.
export async function getStats() {
  const now = new Date().toISOString();
  const [usersTotal, usersPremiumNow, revenue, payments7d, activeUsers7d] = await Promise.all([
    db.execute(`SELECT COUNT(*) AS c FROM users`),
    db.execute({ sql: `SELECT COUNT(*) AS c FROM users WHERE is_premium = 1 AND premium_until > ?`, args: [now] }),
    db.execute(`SELECT COALESCE(SUM(amount_stars), 0) AS total FROM payments`),
    db.execute({
      sql: `SELECT COALESCE(SUM(amount_stars), 0) AS total, COUNT(*) AS c FROM payments WHERE created_at >= ?`,
      args: [new Date(Date.now() - 7 * 86400000).toISOString()],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS c FROM users WHERE last_active >= ?`,
      args: [new Date(Date.now() - 7 * 86400000).toISOString()],
    }),
  ]);
  return {
    usersTotal: Number(usersTotal.rows[0].c) || 0,
    usersPremiumNow: Number(usersPremiumNow.rows[0].c) || 0,
    activeUsers7d: Number(activeUsers7d.rows[0].c) || 0,
    totalStarsAllTime: Number(revenue.rows[0].total) || 0,
    starsLast7d: Number(payments7d.rows[0].total) || 0,
    paymentsLast7d: Number(payments7d.rows[0].c) || 0,
  };
}
