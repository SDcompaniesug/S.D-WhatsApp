require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const twilio = require("twilio");
const { Server } = require("socket.io");
const db = require("./db");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must contain at least 32 characters");
}

const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",").map(value => value.trim()).filter(Boolean);

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed"));
  }
}));
app.use(express.json({ limit: "32kb" }));

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many verification attempts. Try again later." }
});

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : false,
    methods: ["GET", "POST"]
  }
});

const phonePattern = /^\+[1-9]\d{7,14}$/;

function twilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN ||
      !process.env.TWILIO_VERIFY_SERVICE_SID) {
    throw new Error("Twilio Verify environment variables are not configured");
  }
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, phone: user.phone },
    JWT_SECRET,
    { expiresIn: "15m", issuer: "sd-whatsapp-api", audience: "sd-whatsapp-android" }
  );
}

function authenticateToken(token) {
  return jwt.verify(token, JWT_SECRET, {
    issuer: "sd-whatsapp-api",
    audience: "sd-whatsapp-android"
  });
}

app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ status: "ok", database: "connected", service: "sd-whatsapp-api" });
  } catch (error) {
    console.error("Health check failed:", error.message);
    res.status(503).json({ status: "degraded", database: "unavailable" });
  }
});

app.post("/api/v1/auth/request-otp", otpLimiter, async (req, res) => {
  const phone = String(req.body?.phone || "").trim();
  if (!phonePattern.test(phone)) {
    return res.status(400).json({ error: "Enter a valid phone number in E.164 format." });
  }

  try {
    const service = twilioClient().verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID);
    const result = await service.verifications.create({ to: phone, channel: "sms" });
    return res.json({ status: result.status, message: "Verification code requested." });
  } catch (error) {
    console.error("OTP request failed:", error.message);
    return res.status(502).json({ error: "Could not send verification code." });
  }
});

app.post("/api/v1/auth/verify-otp", otpLimiter, async (req, res) => {
  const phone = String(req.body?.phone || "").trim();
  const code = String(req.body?.code || "").trim();

  if (!phonePattern.test(phone) || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ error: "A valid phone number and verification code are required." });
  }

  try {
    const service = twilioClient().verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID);
    const check = await service.verificationChecks.create({ to: phone, code });

    if (check.status !== "approved") {
      return res.status(401).json({ error: "The verification code is incorrect or expired." });
    }

    const result = await db.query(
      `INSERT INTO users (phone, phone_verified_at, created_at, updated_at)
       VALUES ($1, NOW(), NOW(), NOW())
       ON CONFLICT (phone)
       DO UPDATE SET phone_verified_at = NOW(), updated_at = NOW()
       RETURNING id, phone, display_name, avatar_url`,
      [phone]
    );

    const user = result.rows[0];
    const accessToken = signAccessToken(user);

    return res.json({
      user,
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 900
    });
  } catch (error) {
    console.error("OTP verification failed:", error.message);
    return res.status(502).json({ error: "Verification service is temporarily unavailable." });
  }
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication required"));
    socket.user = authenticateToken(token);
    return next();
  } catch (_) {
    return next(new Error("Invalid or expired access token"));
  }
});

io.on("connection", (socket) => {
  // Authenticated realtime channel. Conversation membership checks
  // will be added before message events are enabled.
  socket.emit("connection:ready", { user_id: socket.user.sub });
});

server.listen(PORT, () => {
  console.log("S.D WhatsApp API listening on port " + PORT);
});
