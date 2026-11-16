# S.D WhatsApp

Independent Android messaging application.

- Android package: `com.sdcompanies.whatsapp`
- Android client: Java + XML, native Android Activity (no AppCompat)
- Backend: Node.js + Express + Socket.IO on Railway
- Database: Neon PostgreSQL
- Phone verification: Twilio Verify
- Authentication: short-lived JWT access tokens (refresh-session flow will be added in the next backend stage)

## Repository layout

- `android/` — native Android application
- `backend/` — API, realtime gateway and database schema

## Backend setup

1. Create a Neon PostgreSQL database and copy its pooled connection string.
2. Create a Twilio Verify Service and obtain the Account SID, Auth Token and Verify Service SID.
3. Deploy `backend/` as a Railway service.
4. Set these Railway variables:

   - `DATABASE_URL`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_VERIFY_SERVICE_SID`
   - `JWT_SECRET` (at least 32 random bytes)
   - `CORS_ORIGIN` (optional; comma-separated origins)

5. Run `npm install` and `npm start` from `backend/`.

The API creates no production database tables automatically. Apply `backend/sql/schema.sql` to Neon before starting the service.

## API

- `GET /health`
- `POST /api/v1/auth/request-otp` — JSON: `{"phone":"+2567XXXXXXXX"}`
- `POST /api/v1/auth/verify-otp` — JSON: `{"phone":"+2567XXXXXXXX","code":"123456"}`

Phone numbers must use E.164 format. Never commit credentials or real user data.

## Android setup

Open the `android/` directory in Android Studio or a compatible Gradle Android IDE. Set the API base URL in `android/app/build.gradle` before testing OTP requests. The initial client is a foundation build; chat screens, media, calls, push notifications and end-to-end encryption are separate implementation stages.

## Security and scope

This is an independent messaging service. It does not connect to or import WhatsApp accounts, chats or groups. End-to-end encryption is not yet implemented; do not treat this foundation build as production-ready for sensitive conversations.
