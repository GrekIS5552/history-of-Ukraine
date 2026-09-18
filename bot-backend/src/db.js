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
