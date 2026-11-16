const express = require("express");
const crypto = require("crypto");

const router = express.Router();
const phonePattern = /^\d{8,15}$/;

function verifySignature(req) {
  const secret = process.env.META_APP_SECRET;
  const signature = req.get("x-hub-signature-256") || "";
  if (!secret || !signature.startsWith("sha256=") || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge || ""));
  }
  return res.sendStatus(403);
}

async function receiveWebhook(req, res) {
  if (!verifySignature(req)) return res.sendStatus(401);
  if (req.body?.object !== "whatsapp_business_account") return res.sendStatus(404);
  res.sendStatus(200);
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const value = change.value || {};
        const names = new Map((value.contacts || []).map(c => [String(c.wa_id), c.profile?.name || null]));
        for (const message of value.messages || []) {
          const waId = String(message.from || "");
          if (!phonePattern.test(waId)) continue;
          const type = String(message.type || "unknown");
          const body = type === "text" ? (message.text?.body || "") :
            type === "button" ? (message.button?.text || "") :
            type === "interactive" ? (message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "") : "";
          const mediaId = message[type]?.id || null;
          await db.query(
            \`INSERT INTO wa_contacts (wa_id, profile_name, last_message_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (wa_id) DO UPDATE SET
               profile_name = COALESCE(EXCLUDED.profile_name, wa_contacts.profile_name),
               last_message_at = NOW()\`,
            [waId, names.get(waId) || null]
          );
          const conv = await db.query(
            \`INSERT INTO wa_conversations (wa_id, last_message_preview, last_message_at, updated_at)
             VALUES ($1, $2, NOW(), NOW())
             ON CONFLICT (wa_id) DO UPDATE SET
               last_message_preview = EXCLUDED.last_message_preview,
               last_message_at = NOW(), updated_at = NOW()
             RETURNING id\`,
            [waId, body || ("[" + type + "]")]
          );
          await db.query(
            \`INSERT INTO wa_messages
             (conversation_id, meta_message_id, direction, message_type, body, media_id, status, raw_payload, sent_at)
             VALUES ($1, $2, 'inbound', $3, $4, $5, 'received', $6::jsonb, NOW())
             ON CONFLICT (meta_message_id) DO NOTHING\`,
            [conv.rows[0].id, message.id, type, body, mediaId, JSON.stringify(message)]
          );
        }
        for (const status of value.statuses || []) {
          await db.query(
            \`UPDATE wa_messages SET status = $1
             WHERE meta_message_id = $2 AND direction = 'outbound'\`,
            [String(status.status || "sent"), String(status.id || "")]
          );
        }
      }
    }
  } catch (error) {
    console.error("WhatsApp webhook processing failed:", error.message);
  }
}

function routerFactory({ db, authenticateToken }) {
  router.post("/messages", async (req, res) => {
    try {
      const auth = req.get("authorization") || "";
      if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required." });
      authenticateToken(auth.slice(7));
    } catch (_) {
      return res.status(401).json({ error: "Invalid or expired access token." });
    }
    const to = String(req.body?.to || "").replace(/^\+/, "");
    const body = String(req.body?.text || "").trim();
    if (!phonePattern.test(to) || !body || body.length > 4096) {
      return res.status(400).json({ error: "Provide a valid recipient number and text (maximum 4096 characters)." });
    }
    const token = process.env.META_ACCESS_TOKEN;
    const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) return res.status(503).json({ error: "Meta Cloud API is not configured." });
    const version = process.env.META_GRAPH_API_VERSION || "v27.0";
    try {
      const response = await fetch(
        \`https://graph.facebook.com/\${version}/\${phoneNumberId}/messages\`,
        {
          method: "POST",
          headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "text",
            text: { preview_url: false, body }
          })
        }
      );
      const data = await response.json();
      if (!response.ok) {
        console.error("Meta Cloud API rejected send:", data);
        return res.status(response.status).json({ error: data.error?.message || "Meta message send failed." });
      }
      const messageId = data.messages?.[0]?.id;
      if (messageId) {
        await db.query(
          \`INSERT INTO wa_contacts (wa_id, last_message_at) VALUES ($1, NOW())
           ON CONFLICT (wa_id) DO UPDATE SET last_message_at = NOW()\`, [to]
        );
        const conv = await db.query(
          \`INSERT INTO wa_conversations (wa_id, last_message_preview, last_message_at, updated_at)
           VALUES ($1, $2, NOW(), NOW())
           ON CONFLICT (wa_id) DO UPDATE SET last_message_preview = EXCLUDED.last_message_preview,
             last_message_at = NOW(), updated_at = NOW() RETURNING id\`, [to, body]
        );
        await db.query(
          \`INSERT INTO wa_messages
           (conversation_id, meta_message_id, direction, message_type, body, status, raw_payload, sent_at)
           VALUES ($1, $2, 'outbound', 'text', $3, 'sent', $4::jsonb, NOW())
           ON CONFLICT (meta_message_id) DO NOTHING\`,
          [conv.rows[0].id, messageId, body, JSON.stringify(data)]
        );
      }
      return res.status(200).json({ success: true, meta_message_id: messageId });
    } catch (error) {
      console.error("Meta Cloud API send failed:", error.message);
      return res.status(502).json({ error: "Unable to contact Meta WhatsApp Cloud API." });
    }
  });

  router.get("/conversations", async (req, res) => {
    try {
      const auth = req.get("authorization") || "";
      if (!auth.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required." });
      authenticateToken(auth.slice(7));
    } catch (_) {
      return res.status(401).json({ error: "Invalid or expired access token." });
    }
    try {
      const result = await db.query(
        \`SELECT c.id, c.wa_id, p.profile_name, c.last_message_preview, c.last_message_at
         FROM wa_conversations c JOIN wa_contacts p USING (wa_id)
         ORDER BY c.last_message_at DESC NULLS LAST LIMIT 100\`
      );
      res.json({ conversations: result.rows });
    } catch (error) {
      console.error("Conversation list failed:", error.message);
      res.status(500).json({ error: "Could not load conversations." });
    }
  });
  return router;
}

module.exports = { router: routerFactory, verifyWebhook, receiveWebhook };
