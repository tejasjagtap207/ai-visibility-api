// api/demo.js
//
// Public-facing proxy for the homepage's live demo widget (index.html).
// It forwards every request into the existing api/visibility-check.js
// handler, but injects a server-side "demo" API key first — so the real
// per-client api_key is never exposed in the browser.
//
// SETUP REQUIRED before this works:
// 1. In Supabase (ai-visibility-db), insert a demo user row:
//      insert into public.users (api_key, tokens_remaining)
//      values ('<pick-a-long-random-string>', 100000);
//    100000 tokens = 50 free demo scans (2000 tokens each) before it
//    needs a top-up. Adjust the number to whatever budget you're
//    comfortable giving away publicly.
//
// 2. In Vercel → Settings → Environment Variables, add:
//      DEMO_API_KEY = <the same string you inserted above>
//    Then redeploy so the function picks up the new env var.
//
// Once the demo key's tokens_remaining hits 0, visibility-check.js
// already returns a 403 "Trial limit reached" — this file adds no
// separate rate limiting of its own; the token budget IS the limit.
//
// This file must sit in the same api/ folder as visibility-check.js.

const visibilityCheck = require("./visibility-check.js");

module.exports = async (req, res) => {
  // Only inject the demo key for the actual POST call — GET/OPTIONS
  // fall straight through so visibility-check.js's own CORS/method
  // handling still applies unchanged.
  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    if (!body || typeof body !== "object") body = {};

    if (!process.env.DEMO_API_KEY) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(500).json({
        error: "Demo isn't configured yet: DEMO_API_KEY is missing in this deployment's environment variables.",
      });
    }

    req.body = {
      ...body,
      api_key: process.env.DEMO_API_KEY, // overwrite whatever the client sent
    };
  }

  return visibilityCheck(req, res);
};
