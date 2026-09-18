const BOT_TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function call(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`[telegram] ${method} failed:`, data.description);
  }
  return data;
}

export function sendMessage(chatId, text, extra = {}) {
  return call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", ...extra });
}

// Виставляє інвойс за Telegram Stars. currency завжди "XTR", provider_token завжди "" для Stars.
export function sendInvoice(chatId, { title, description, payload, amountStars }) {
  return call("sendInvoice", {
    chat_id: chatId,
    title,
    description,
    payload,
    currency: "XTR",
    provider_token: "",
    prices: [{ label: title, amount: amountStars }],
  });
}

export function answerPreCheckoutQuery(preCheckoutQueryId, ok, errorMessage) {
  return call("answerPreCheckoutQuery", {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  });
}

export function setWebhook(url, secret) {
  return call("setWebhook", { url, secret_token: secret });
}

export function getWebhookInfo() {
  return call("getWebhookInfo", {});
}
