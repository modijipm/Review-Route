const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { GoogleGenAI } = require("@google/genai");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);
  next();
});

function findHtmlFile() {
  const preferred = [
    "career-compass.html",
    "career-compass (12).html",
    "career-compass (11).html"
  ];
  for (const name of preferred) {
    const full = path.join(__dirname, name);
    if (fs.existsSync(full)) return full;
  }
  const match = fs.readdirSync(__dirname).find((f) =>
    /^career-compass.*\.html$/i.test(f)
  );
  return match ? path.join(__dirname, match) : null;
}

const htmlFile = findHtmlFile();

app.get("/", (_req, res) => {
  if (!htmlFile) {
    return res
      .status(404)
      .send(
        "No career-compass HTML file found in this folder. Rename your page to career-compass.html and restart the server."
      );
  }
  res.sendFile(htmlFile);
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.GEMINI_API_KEY),
    model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
    html: htmlFile ? path.basename(htmlFile) : null
  });
});

app.use(express.static(__dirname));

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.warn(
    "\n⚠️  GEMINI_API_KEY is missing. Create a .env file in this folder:\n" +
      "   GEMINI_API_KEY=your_key_here\n"
  );
}

const ai = new GoogleGenAI({ apiKey: apiKey || "" });
const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

app.post("/api/career-analysis", async (req, res) => {
  const started = Date.now();
  console.log("→ Gemini analysis requested");

  try {
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: "Server is missing GEMINI_API_KEY. Add it to the .env file and restart npm start."
      });
    }

    const { studentData } = req.body || {};
    if (!studentData) {
      return res.status(400).json({
        success: false,
        error: "Missing studentData in request body."
      });
    }

    const langMap = {
      en: "English",
      hi: "Hindi",
      gu: "Gujarati",
      bn: "Bengali",
      mr: "Marathi",
      ta: "Tamil",
      te: "Telugu",
      as: "Assamese"
    };
    const langCode = (studentData.language || "en").toLowerCase();
    const langName = langMap[langCode] || "English";

    const prompt = `You are an educational career guidance assistant for Indian school students (CBSE, ICSE, IB, State boards).

Analyze the following student's Career Compass results.

Student data:
${JSON.stringify(studentData, null, 2)}

IMPORTANT: Write the entire analysis in ${langName}. Do not mix languages. Use simple, clear ${langName} suitable for a school student.

If studentData.alreadyChoseStream is true, they are in Class 11 and have already chosen a stream. Do NOT recommend a different stream. Advise only inside the stream they already take.

Otherwise give a clear, encouraging explanation of:
1. Why the recommended stream may suit the student.
2. The student's strongest academic/interest factors.
3. What the student should improve.
4. Three suitable career areas to explore.
5. Three practical next steps.

Rules:
- Do not claim that this recommendation guarantees a particular career or college admission.
- Keep language appropriate for a school student (simple, supportive, practical).
- Use short paragraphs and bullet points where helpful.
- Base advice only on the data provided; do not invent marks or answers.
- Reply ONLY in ${langName}.`;

    const timeoutMs = 45000;
    const response = await Promise.race([
      ai.models.generateContent({
        model: MODEL,
        contents: prompt
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Gemini timed out after ${timeoutMs / 1000}s. Check your API key and internet.`)),
          timeoutMs
        )
      )
    ]);

    const analysis =
      (typeof response.text === "function" ? response.text() : response.text) ||
      response?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
      "";

    if (!analysis) {
      return res.status(500).json({
        success: false,
        error: "Gemini returned an empty response. Try another model in .env: GEMINI_MODEL=gemini-3.6-flash"
      });
    }

    console.log(`✓ Gemini analysis ready in ${Date.now() - started}ms`);
    res.json({ success: true, analysis });
  } catch (error) {
    console.error("AI error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "The AI service could not process the request."
    });
  }
});

const GROK_CLIENT_ID = (process.env.GROK_AUTH_CLIENT_ID || "grok_preview").trim();
const GROK_CLIENT_SECRET = (
  process.env.GROK_AUTH_CLIENT_SECRET ||
  "8bcdb7fc5a33874ad933ca568918d5790388a0795e44c4d1dea691f801b17ec5"
).trim();
const GROK_AUTHORIZE = "https://auth.grok.me/api/auth/oauth2/authorize";
const GROK_TOKEN = "https://auth.grok.me/api/auth/oauth2/token";
const GROK_USERINFO = "https://auth.grok.me/api/auth/oauth2/userinfo";

function googlePopupHtml(message) {
  const payload = JSON.stringify(message).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head><body style="font:16px sans-serif;padding:24px">
<script type="application/json" id="m">${payload}</script>
<script>
(function(){
  var msg = {source:"grok-auth-popup", token:null};
  try { msg = JSON.parse(document.getElementById("m").textContent); } catch (e) {}
  try { if (window.opener) window.opener.postMessage(msg, window.location.origin); } catch (e) {}
  document.body.textContent = msg.error || (msg.user ? "Signed in. You can close this window." : "You can close this window.");
  try { window.close(); } catch (e) {}
})();
</script></body></html>`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try { return decodeURIComponent(trimmed.slice(eq + 1)); } catch (e) { return trimmed.slice(eq + 1); }
  }
  return "";
}

app.get("/auth/popup", (req, res) => {
  const clientId = "491461033807-n1q26f71frc99a95q841g36ll0eqsarq.apps.googleusercontent.com";
  const origin = `${req.protocol}://${req.get("host")}`;
  const redirectUri = `${origin}/auth/popup`;
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: "openid email profile",
    prompt: "select_account",
    include_granted_scopes: "true"
  }).toString();
  const safeUrl = JSON.stringify(authUrl);
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head><body style="font:16px sans-serif;padding:24px">Opening Google…
<script>
(function(){
  var hash = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  var token = hash.get("access_token");
  var err = hash.get("error");
  function finish(msg){
    try { if (window.opener) window.opener.postMessage(msg, location.origin); } catch (e) {}
    document.body.textContent = msg.error || (msg.user ? "Signed in. This window will close." : "You can close this window.");
    try { window.close(); } catch (e) {}
    if (msg.user && !window.opener) {
      try { localStorage.setItem("rr.v1.user", JSON.stringify({provider:"google", name:msg.user.name||"", email:msg.user.email||"", picture:msg.user.image||""})); } catch (e) {}
      location.replace("/");
    }
  }
  if (err) { finish({source:"grok-auth-popup", token:null, error:"Google sign-in was cancelled."}); return; }
  if (!token) { location.replace(${safeUrl}); return; }
  fetch("https://www.googleapis.com/oauth2/v3/userinfo", {headers:{Authorization:"Bearer " + token}})
    .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
    .then(function(info){
      finish({source:"grok-auth-popup", token:null, user:{name:info.name||info.given_name||"", email:info.email||"", image:info.picture||""}});
    })
    .catch(function(){ finish({source:"grok-auth-popup", token:null, error:"Could not read the Google profile."}); });
})();
</script></body></html>`);
});

app.get("/api/auth-popup", async (req, res) => {
  if (String(req.query.probe || "") === "1") {
    return res.json({ ok: true });
  }
  const origin = `${req.protocol}://${req.get("host")}`;
  const redirectUri = `${origin}/api/auth-popup`;
  if (req.query.error) {
    return res.type("html").send(googlePopupHtml({
      source: "grok-auth-popup",
      token: null,
      error: String(req.query.error)
    }));
  }
  if (req.query.code) {
    const expected = readCookie(req, "cc_oauth_state");
    if (expected && req.query.state && expected !== String(req.query.state)) {
      return res.type("html").send(googlePopupHtml({
        source: "grok-auth-popup",
        token: null,
        error: "Sign-in session expired. Close this window and try again."
      }));
    }
    try {
      const tokenRes = await fetch(GROK_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(req.query.code),
          redirect_uri: redirectUri,
          client_id: GROK_CLIENT_ID,
          client_secret: GROK_CLIENT_SECRET
        })
      });
      const tokens = await tokenRes.json().catch(() => ({}));
      const access = tokens.access_token || tokens.accessToken;
      if (!tokenRes.ok || !access) {
        throw new Error(tokens.error_description || tokens.message || tokens.error || "Google sign-in could not be completed.");
      }
      const infoRes = await fetch(GROK_USERINFO, {
        headers: { Authorization: "Bearer " + access }
      });
      const info = await infoRes.json().catch(() => ({}));
      const id = info.sub || info.id || (info.user && info.user.id);
      if (!infoRes.ok || !id) throw new Error("Could not read the Google profile.");
      const user = info.user || info;
      return res.type("html").send(googlePopupHtml({
        source: "grok-auth-popup",
        token: null,
        user: {
          id: String(id),
          name: user.name || info.name || user.email || info.email || "Student",
          email: user.email || info.email || "",
          image: user.image || user.picture || info.picture || ""
        }
      }));
    } catch (error) {
      return res.type("html").send(googlePopupHtml({
        source: "grok-auth-popup",
        token: null,
        error: error.message || "Google sign-in failed."
      }));
    }
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.setHeader("Set-Cookie", `cc_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  const authUrl = GROK_AUTHORIZE + "?" + new URLSearchParams({
    idp: "google",
    prompt: "login",
    response_type: "code",
    client_id: GROK_CLIENT_ID,
    scope: "openid profile email",
    redirect_uri: redirectUri,
    state
  });
  res.redirect(authUrl);
});

app.listen(PORT, () => {
  console.log(`\nCareer Compass AI server running at http://localhost:${PORT}`);
  console.log(`Serving HTML: ${htmlFile || "(not found — rename your file to career-compass.html)"}`);
  console.log(`Health check: http://localhost:${PORT}/api/health\n`);
  if (!apiKey) {
    console.log("Add GEMINI_API_KEY to .env, then stop the server (Ctrl+C) and run npm start again.\n");
  }
});
