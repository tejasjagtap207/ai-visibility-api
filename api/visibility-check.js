// api/visibility-check.js
//
// Single Vercel serverless function (CommonJS) that scores a brand's
// "AI visibility" by asking realistic buyer-intent questions to Gemini
// and then analyzing whether (and how) the brand is mentioned.
//
// NOTE: This MVP uses Gemini to SIMULATE what an AI assistant such as
// ChatGPT / Gemini / Perplexity would answer to a real user. It does NOT
// call the real ChatGPT, Perplexity, or Bing APIs. The simulation is a
// reasonable proxy for AI search visibility in an MVP context.
//
// IMPORTANT (deployment): The default Vercel serverless timeout is 10s on
// the Hobby plan. This function makes 6 sequential Gemini calls and can
// take ~15-30s. Add this to your vercel.json to allow up to 60s
// (alongside your existing api/analyze.js entry):
//
//   {
//     "version": 2,
//     "functions": {
//       "api/analyze.js": { "maxDuration": 60 },
//       "api/visibility-check.js": { "maxDuration": 60 }
//     }
//   }
//
// CHANGE LOG (vs. the version pasted for review):
// - Replaced the raw res.writeHead(...).end(...) response pattern with
//   res.setHeader(...) + res.status(x).json(y), matching the pattern
//   already proven to work in this project's api/analyze.js. Vercel's
//   request/response handling has shown quirks elsewhere in this project,
//   so we stick to the exact pattern already confirmed working in
//   production rather than introducing a second, untested response style.
// - Everything else (validation, Supabase logic, prompt-building, Gemini
//   calls, JSON analysis, normalization, token deduction) is unchanged.

// Import the two permitted dependencies only.
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

// Main handler exported as a Vercel API route.
module.exports = async (req, res) => {
  // CORS headers applied to every response (preflight + actual), same
  // pattern as api/analyze.js.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // STEP 1: Handle CORS preflight (OPTIONS) immediately and short-circuit.
  // Browsers send an OPTIONS request before the actual POST to verify CORS.
  if (req.method === "OPTIONS") return res.status(200).end();

  // STEP 2: Only POST is allowed. Reject GET/PUT/etc.
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Wrap everything in try/catch so no internal error leaks as a stack trace.
  try {
    // STEP 3: Parse the JSON body. Vercel passes the raw body in `req.body`
    // (it auto-parses JSON for API routes), but we defensively handle both
    // string and object forms.
    let body = req.body;
    if (typeof body === "string") {
      body = JSON.parse(body);
    }
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "Request body must be a JSON object." });
    }

    const { brand_name, industry, competitors, api_key } = body;

    // STEP 3 (continued): Validate required fields.
    if (!brand_name || typeof brand_name !== "string" || !brand_name.trim()) {
      return res.status(400).json({ error: "Missing required field: brand_name (string)." });
    }
    if (!industry || typeof industry !== "string" || !industry.trim()) {
      return res.status(400).json({ error: "Missing required field: industry (string)." });
    }
    if (!api_key || typeof api_key !== "string" || !api_key.trim()) {
      return res.status(400).json({ error: "Missing required field: api_key (string)." });
    }

    // Normalize the competitors array: enforce max 3 and only strings.
    let competitorList = [];
    if (Array.isArray(competitors)) {
      competitorList = competitors
        .filter((c) => typeof c === "string" && c.trim().length > 0)
        .slice(0, 3)
        .map((c) => c.trim());
    }

    // STEP 4: Initialize Supabase client using the service role key.
    // The service role key bypasses Row Level Security; keep it server-side only.
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Look up the user row matching the provided api_key.
    const { data: userRow, error: userErr } = await supabase
      .from("users")
      .select("id, tokens_remaining")
      .eq("api_key", api_key.trim())
      .maybeSingle(); // returns null if no row, instead of erroring

    if (userErr) {
      // Surface the real DB error to the caller for debugging transparency.
      throw new Error("Supabase lookup failed: " + userErr.message);
    }

    if (!userRow) {
      return res.status(401).json({ error: "Invalid API Key." });
    }

    if (userRow.tokens_remaining <= 0) {
      return res.status(403).json({ error: "Trial limit reached." });
    }

    // STEP 5: Build 5 realistic buyer-intent prompts dynamically from the
    // `industry` field. We do NOT hardcode industry-specific text.
    const prompts = [
      `What are the best ${industry} in 2026?`,
      `Top ${industry} for small businesses`,
      `${industry} recommendations`,
      `Compare the leading ${industry} options`,
      `Which ${industry} should I choose and why?`,
    ];

    // STEP 6: Initialize the Gemini client. Per project requirement, we use
    // the model name "gemini-3.5-flash-lite". Do not use "gemini-1.5-flash"
    // or "gemini-pro" — those are deprecated/shut down.
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const answerModel = genAI.getGenerativeModel({
      model: "gemini-3.5-flash-lite",
    });

    // A system-style instruction that pushes the model to behave like a
    // helpful AI shopping/research assistant and to name real, specific
    // products/brands it knows of, rather than hedging.
    const systemInstruction =
      "You are a helpful AI research assistant answering a real user who is " +
      "evaluating options. Answer naturally and specifically. You SHOULD name " +
      "real, well-known products, brands, or services that you are aware of " +
      "for the user's query, listed in order of how strongly you would " +
      "recommend them. Do NOT say you cannot recommend specific products. " +
      "If you genuinely know fewer than five options, list as many as you " +
      "can and briefly explain why each is relevant. Keep each answer under " +
      "200 words and use a short, scannable list.";

    // Collect raw text answers from the 5 prompts.
    // We run them sequentially to stay within Gemini rate limits and to keep
    // memory usage low. Total ~5 calls here.
    const rawAnswers = [];
    for (let i = 0; i < prompts.length; i++) {
      const fullPrompt = `${systemInstruction}\n\nUser question: ${prompts[i]}`;
      const result = await answerModel.generateContent(fullPrompt);
      const text = result.response.text(); // raw string answer from Gemini
      rawAnswers.push(text);
    }

    // STEP 7: Build the analysis prompt for ONE final Gemini call.
    // We pass all 5 raw answers plus the brand_name and competitor list,
    // and ask Gemini to return strict structured JSON.
    const analysisPrompt = buildAnalysisPrompt(
      prompts,
      rawAnswers,
      brand_name.trim(),
      competitorList
    );

    // For the analysis call we enable JSON mode via generationConfig so the
    // output is guaranteed to be valid JSON that we can safely JSON.parse.
    const analysisModel = genAI.getGenerativeModel({
      model: "gemini-3.5-flash-lite",
      generationConfig: { responseMimeType: "application/json" },
    });

    const analysisResult = await analysisModel.generateContent(analysisPrompt);
    const analysisText = analysisResult.response.text();

    // Parse the JSON-structured analysis. If parsing fails, surface the
    // error to the caller rather than silently returning broken data.
    let visibilityReport;
    try {
      visibilityReport = JSON.parse(analysisText);
    } catch (parseErr) {
      throw new Error(
        "Gemini returned non-JSON analysis output. Raw: " +
          analysisText.slice(0, 500)
      );
    }

    // Defensive shape cleanup: make sure required fields exist so downstream
    // consumers don't crash on missing keys. If Gemini omitted something,
    // we provide sensible defaults.
    visibilityReport = normalizeReport(visibilityReport, prompts, competitorList);

    // STEP 8: Deduct 2000 tokens from the user's balance in Supabase.
    const newBalance = Math.max(0, userRow.tokens_remaining - 2000);
    const { error: updateErr } = await supabase
      .from("users")
      .update({ tokens_remaining: newBalance })
      .eq("id", userRow.id);

    if (updateErr) {
      // Even if the report succeeded, a balance update failure should be
      // surfaced - but we still want to return the report. We log it and
      // include a warning field in the response.
      console.error("Token deduction failed:", updateErr.message);
      return res.status(200).json({
        success: true,
        visibility_report: visibilityReport,
        tokens_remaining: userRow.tokens_remaining,
        warning: "Report generated, but token deduction failed: " + updateErr.message,
      });
    }

    // STEP 9: Return the successful result.
    return res.status(200).json({
      success: true,
      visibility_report: visibilityReport,
      tokens_remaining: newBalance,
    });
  } catch (err) {
    // STEP 10: Log the real error server-side and return a 500 with the
    // real error.message so the caller can debug (no opaque "Server Error").
    console.error("visibility-check error:", err);
    return res.status(500).json({
      error: "Server Error: " + (err && err.message ? err.message : String(err)),
    });
  }
};

// ---------------------------------------------------------------------------
// HELPER: buildAnalysisPrompt
// Constructs the prompt that asks Gemini to analyze the 5 raw answers and
// return a structured JSON object describing the brand's visibility.
// ---------------------------------------------------------------------------
function buildAnalysisPrompt(prompts, rawAnswers, brandName, competitors) {
  // Format each Q&A pair so the model can reference them clearly.
  const qaBlock = prompts
    .map((p, i) => {
      return (
        `Q${i + 1}: ${p}\n` +
        `A${i + 1}: ${rawAnswers[i] || "(no answer)"}`
      );
    })
    .join("\n\n");

  // Describe the competitor list (or note if none were provided).
  const competitorLine =
    competitors.length > 0
      ? `Known competitors to track: ${competitors.join(", ")}`
      : "No specific competitors provided; leave competitor_share_of_voice as an empty array and competitors_mentioned as empty arrays.";

  // The exact JSON schema we expect, written out so Gemini mirrors it.
  const schema = [
    "{",
    '  "visibility_score": <number 0-100, percent of the 5 answers that mention the brand by name>,',
    '  "mentions": [',
    "    {",
    '      "prompt": <the original question string>,',
    '      "brand_mentioned": <boolean>,',
    '      "position": <1-based ranking position if listed as a recommendation, else null>,',
    '      "competitors_mentioned": [<competitor names found in this answer>]',
    "    }",
    "  ],  // exactly 5 entries, one per prompt, in order",
    '  "sentiment": "<one of: positive | neutral | negative | not mentioned>",',
    '  "competitor_share_of_voice": [',
    "    {",
    '      "competitor_name": <string>,',
    '      "mention_count": <number, how many of the 5 answers mention it>',
    "    }",
    "  ]  // sorted by mention_count descending; only include competitors that appear at least once",
    "  ,",
    '  "improvement_recommendations": [<3 actionable strings>]',
    "}",
  ].join("\n");

  return (
    `You are an analyst evaluating a brand's visibility in AI assistant answers.\n\n` +
    `Brand being evaluated: "${brandName}"\n` +
    `${competitorLine}\n\n` +
    `Below are 5 question/answer pairs produced by an AI assistant. ` +
    `Analyze how the brand "${brandName}" and any of the listed competitors appear across these answers.\n\n` +
    `=== Q&A PAIRS ===\n${qaBlock}\n=== END Q&A ===\n\n` +
    `Return ONLY a JSON object with EXACTLY this shape:\n${schema}\n\n` +
    `Rules:\n` +
    `- visibility_score = (number of answers that mention "${brandName}") / 5 * 100, rounded to an integer.\n` +
    `- "position" is the 1-based position where the brand was listed as a recommendation in that answer (1 = first listed). If the brand was mentioned but not as a ranked recommendation, use position null. If not mentioned at all, brand_mentioned=false and position=null.\n` +
    `- "sentiment" reflects the overall tone toward "${brandName}" across the answers where it IS mentioned. Use "not mentioned" if it never appears.\n` +
    `- competitor_share_of_voice must include only competitors with mention_count >= 1, sorted descending.\n` +
    `- improvement_recommendations: exactly 3 concrete, specific suggestions for how "${brandName}" could improve its AI visibility (e.g. content gaps, comparison pages, review sites to target, structured data, partnerships).\n` +
    `- Do not include any text outside the JSON object.`
  );
}

// ---------------------------------------------------------------------------
// HELPER: normalizeReport
// Ensures the parsed report has all expected keys with sensible defaults.
// This protects downstream consumers if Gemini omits a field.
// ---------------------------------------------------------------------------
function normalizeReport(report, prompts, competitors) {
  if (!report || typeof report !== "object") {
    report = {};
  }

  // Ensure visibility_score is a number between 0 and 100.
  if (typeof report.visibility_score !== "number") {
    report.visibility_score = 0;
  }
  report.visibility_score = Math.max(0, Math.min(100, Math.round(report.visibility_score)));

  // Ensure mentions is an array of exactly 5 entries aligned to the prompts.
  if (!Array.isArray(report.mentions)) {
    report.mentions = [];
  }
  // Pad/trim to exactly 5 entries, preserving order.
  const padded = [];
  for (let i = 0; i < 5; i++) {
    const m = report.mentions[i] || {};
    padded.push({
      prompt: typeof m.prompt === "string" ? m.prompt : (prompts[i] || ""),
      brand_mentioned: m.brand_mentioned === true,
      position: typeof m.position === "number" ? m.position : null,
      competitors_mentioned: Array.isArray(m.competitors_mentioned)
        ? m.competitors_mentioned.filter((x) => typeof x === "string")
        : [],
    });
  }
  report.mentions = padded;

  // Ensure sentiment is one of the allowed values.
  const allowedSentiments = ["positive", "neutral", "negative", "not mentioned"];
  if (!allowedSentiments.includes(report.sentiment)) {
    report.sentiment = "not mentioned";
  }

  // Ensure competitor_share_of_voice is an array of {competitor_name, mention_count}.
  if (!Array.isArray(report.competitor_share_of_voice)) {
    report.competitor_share_of_voice = [];
  }
  report.competitor_share_of_voice = report.competitor_share_of_voice
    .filter(
      (c) =>
        c &&
        typeof c === "object" &&
        typeof c.competitor_name === "string" &&
        typeof c.mention_count === "number"
    )
    .sort((a, b) => b.mention_count - a.mention_count);

  // Ensure improvement_recommendations is an array of 3 strings.
  if (!Array.isArray(report.improvement_recommendations)) {
    report.improvement_recommendations = [];
  }
  report.improvement_recommendations = report.improvement_recommendations
    .filter((r) => typeof r === "string" && r.trim().length > 0)
    .slice(0, 3);
  // Pad with generic recommendations if fewer than 3 were returned.
  const fallbackRecs = [
    "Publish detailed comparison pages contrasting your brand with leading alternatives.",
    "Encourage customer reviews on third-party sites that AI assistants frequently cite.",
    "Add structured, schema-marked content describing your product categories and use cases.",
  ];
  while (report.improvement_recommendations.length < 3) {
    report.improvement_recommendations.push(
      fallbackRecs[report.improvement_recommendations.length]
    );
  }

  return report;
}