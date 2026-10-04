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

    const prompt = `You are an educational career guidance assistant for Indian school students (CBSE, ICSE, IB, State boards).

Analyze the following student's Career Compass results.

Student data:
${JSON.stringify(studentData, null, 2)}

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
- Base advice only on the data provided; do not invent marks or answers.`;

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

app.listen(PORT, () => {
  console.log(`\nCareer Compass AI server running at http://localhost:${PORT}`);
  console.log(`Serving HTML: ${htmlFile || "(not found — rename your file to career-compass.html)"}`);
  console.log(`Health check: http://localhost:${PORT}/api/health\n`);
  if (!apiKey) {
    console.log("Add GEMINI_API_KEY to .env, then stop the server (Ctrl+C) and run npm start again.\n");
  }
});
