const puppeteer = require("puppeteer");
const fs = require("fs");
const readline = require("readline");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");

// ============================================================
//  FILES & CONFIG
// ============================================================
const INPUT_FILE   = "input.csv";
const COOKIES_FILE = "cookies.json";
const BASE_URL     = "https://www.blablalink.com/shiftyspad/nikke";
const LOGIN_URL    = "https://www.blablalink.com";
const DELAY_MS     = 2000;

function sanitizeFileName(name) {
  return name.replace(/[\/\\?%*:|"<>\s]+/g, "_");
}
function getOutputFilePath(nikkeName) {
  return `${sanitizeFileName(nikkeName)}.csv`;
}
// ============================================================

const isLoginMode = process.argv.includes("--login");

function buildUrl(nikkeId, uid) {
  return `${BASE_URL}?from=list&nikke=${nikkeId}&uid=${uid}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- READ INPUT CSV ----
function readInput() {
  if (!fs.existsSync(INPUT_FILE)) {
    const template = [
      "# MEMBERS",
      "name,uid",
      "Alice,PASTE_UID_HERE",
      "",
      "# NIKKES",
      "nikke_id,nikke_name",
      "16,Rapi: Red Hood",
    ].join("\n");
    fs.writeFileSync(INPUT_FILE, template, "utf-8");
    console.error(`\n❌ input.csv not found — created a template for you.\n`);
    process.exit(1);
  }

  const raw = fs.readFileSync(INPUT_FILE, "utf-8");
  const lines = raw.split("\n").map((l) => l.trimEnd());
  const blankIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "");
  if (blankIdx === -1) {
    console.error("❌ input.csv must have two sections separated by a blank line.");
    process.exit(1);
  }

  const membersLines = lines.slice(0, blankIdx).filter((l) => !l.startsWith("#"));
  const nikkesLines  = lines.slice(blankIdx + 1).filter((l) => !l.startsWith("#") && l.trim() !== "");

  const members = parse(membersLines.join("\n"), { columns: true, skip_empty_lines: true });
  const nikkes  = parse(nikkesLines.join("\n"),  { columns: true, skip_empty_lines: true });

  if (members.length === 0) { console.error("❌ No members in input.csv"); process.exit(1); }
  if (nikkes.length  === 0) { console.error("❌ No Nikkes in input.csv");  process.exit(1); }

  return { members, nikkes };
}

// ---- INTERACTIVE NIKKE PICKER ----
function pickNikke(nikkes) {
  return new Promise((resolve) => {
    console.log("\n📋 Available Nikkes:");
    nikkes.forEach((n, i) => console.log(`   ${i + 1}. [ID: ${n.nikke_id}] ${n.nikke_name}`));
    console.log("");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("👉 Enter the number of the Nikke to scrape: ", (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= nikkes.length) {
        console.error("❌ Invalid selection."); process.exit(1);
      }
      const chosen = nikkes[idx];
      console.log(`\n✅ Selected: [ID: ${chosen.nikke_id}] ${chosen.nikke_name}\n`);
      resolve(chosen);
    });
  });
}

// ---- COOKIE HELPERS ----
async function saveCookies(page) {
  const cookies = await page.cookies();
  const localStorageData = await page.evaluate(() => {
    const data = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      data[key] = window.localStorage.getItem(key);
    }
    return data;
  });
  fs.writeFileSync(COOKIES_FILE, JSON.stringify({ cookies, localStorage: localStorageData }, null, 2), "utf-8");
  console.log(`🍪 Session saved (${cookies.length} cookies + localStorage)`);
}

async function loadCookies(page) {
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error(`\n❌ No session file. Run: node scraper.js --login\n`);
    process.exit(1);
  }
  const { cookies, localStorage: lsData } = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf-8"));
  if (cookies?.length) await page.setCookie(...cookies);
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
  if (lsData && Object.keys(lsData).length > 0) {
    await page.evaluate((data) => {
      for (const [k, v] of Object.entries(data)) window.localStorage.setItem(k, v);
    }, lsData);
  }
  console.log(`🍪 Loaded ${cookies?.length ?? 0} cookies + ${Object.keys(lsData ?? {}).length} localStorage keys`);
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(1000);
}

// ---- LOGIN MODE ----
async function runLoginMode() {
  console.log(`\n🔐 LOGIN MODE — a browser window will open.`);
  console.log(`   Log in, then come back here and press ENTER.\n`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized", "--no-sandbox"],
    executablePath:
      process.platform === "win32"
        ? (fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
            ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
            : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")
        : undefined
  });

  const page = await browser.newPage();
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("👉 Press ENTER once logged in... ", () => { rl.close(); resolve(); });
  });
  await saveCookies(page);
  await browser.close();
  console.log(`\n✅ Session saved! Now you can run Scrape Mode.\n`);
}

// ============================================================
//  PAGE STATE DETECTION
//  Returns one of: "ok" | "private" | "not_owned" | "not_loaded"
// ============================================================
async function detectPageState(page, expectedNikkeId) {
  return await page.evaluate((nikkeId) => {
    const bodyText = document.body.innerText || "";
    const bodyHTML = document.body.innerHTML || "";

    // --- Private profile signals ---
    const privateKeywords = ["private", "this profile is private", "프라이빗", "비공개"];
    for (const kw of privateKeywords) {
      if (bodyText.toLowerCase().includes(kw)) return "private";
    }

    // If the page has no "Equipment" tab at all, it's likely private or failed to load
    const hasEquipmentTab = bodyText.includes("Equipment");
    if (!hasEquipmentTab) {
      const loginKeywords = ["sign in", "log in", "login", "로그인"];
      for (const kw of loginKeywords) {
        if (bodyText.toLowerCase().includes(kw)) return "private";
      }
      return "not_loaded";
    }

    // --- Equipment Effects section present? ---
    const hasEquipmentEffects = bodyText.includes("Equipment Effects");
    if (!hasEquipmentEffects) return "not_loaded";

    const hasCorrectNikke =
      bodyHTML.includes(`"nikke":${nikkeId}`) ||
      bodyHTML.includes(`"nikke":"${nikkeId}"`) ||
      bodyHTML.includes(`nikke=${nikkeId}`) ||
      hasEquipmentEffects;

    if (!hasCorrectNikke) return "not_owned";

    return "ok";
  }, expectedNikkeId);
}

// ============================================================
//  SCRAPE ONE NIKKE PAGE
// ============================================================
async function scrapeNikkePage(page, nikkeId, uid, nikkeNameFromCsv) {
  const url = buildUrl(nikkeId, uid);
  console.log(`   ${url}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (gotoError) {
    console.log(`   ⚠ Navigation warning: ${gotoError.message}`);
  }

  // Wait for Equipment Effects to render — up to 15s
  try {
    await page.waitForFunction(
      () => {
        const el = Array.from(document.querySelectorAll("div, span, p, h1, h2, h3, h4"))
                        .find(x => x.innerText?.trim() === "Equipment Effects");
        if (!el) return false;
        return el.parentElement?.innerText?.includes("%") || document.body.innerText.includes("No Effects");
      },
      { timeout: 15000 }
    );
  } catch {
    console.log(`   ⚠ Slow render, waiting extra 5s...`);
    await sleep(5000);
  }

  // Also wait specifically for the LV### sync level element to appear
  try {
    await page.waitForFunction(
      () => {
        const els = Array.from(document.querySelectorAll("div, span, p, td, label"))
          .filter(el => el.children.length === 0);
        return els.some(el => /^LV\d{1,4}$/i.test(el.innerText?.trim() || ""));
      },
      { timeout: 8000 }
    );
  } catch {
    // LV element not found in time — extraction will still try all fallback strategies
  }

  await sleep(500);

  // ---- Detect page state before extracting ----
  const pageState = await detectPageState(page, nikkeId);

  if (pageState === "private") {
    console.log(`   🔒 Profile is private`);
    return { status: "PRIVATE", nikkeName: nikkeNameFromCsv, syncLevel: "-", increaseATK: "-", increaseElementDamageDealt: "-" };
  }

  if (pageState === "not_loaded") {
    console.log(`   ⏳ Page did not load properly`);
    return { status: "NOT LOADED", nikkeName: nikkeNameFromCsv, syncLevel: "-", increaseATK: "-", increaseElementDamageDealt: "-" };
  }

  // ---- Extract stats ----
  const extractedData = await page.evaluate(() => {
    let increaseATK = null;
    let increaseElementDamageDealt = null;
    let syncLevel = null;
    let allSlotsNoEffects = false;

    // Equipment Effects stats
    const allEls = Array.from(document.querySelectorAll("div, span, p, h1, h2, h3, h4"));
    let topContainer = null;
    for (const el of allEls) {
      if (el.innerText?.trim() === "Equipment Effects") {
        topContainer = el.parentElement;
        break;
      }
    }

    if (topContainer) {
      const containerText = topContainer.innerText || "";

      const noEffectsCount = (containerText.match(/No Effects/g) || []).length;
      const percentMatches = containerText.match(/\d+\.?\d*%/g) || [];
      allSlotsNoEffects = noEffectsCount >= 4 && percentMatches.length === 0;

      const childElements = Array.from(topContainer.querySelectorAll("div, span, td, p"));

      for (let i = 0; i < childElements.length; i++) {
        const text = childElements[i].innerText?.trim() || "";
        const lower = text.toLowerCase();

        const isATKLabel  = (lower === "increase atk") && childElements[i].children.length === 0;
        const isElemLabel = (lower === "increase element damage dealt") && childElements[i].children.length === 0;

        if (isATKLabel || isElemLabel) {
          let value = null;

          for (let j = i + 1; j < Math.min(i + 4, childElements.length); j++) {
            const sibText = childElements[j].innerText?.trim() || "";
            const match = sibText.match(/^(\d+\.?\d*%)$/);
            if (match) { value = match[1]; break; }
          }

          if (!value) {
            const parentText = childElements[i].parentElement?.innerText || "";
            const labelRemoved = parentText.replace(text, "").trim();
            const match = labelRemoved.match(/(\d+\.?\d*%)/);
            if (match) value = match[1];
          }

          if (isATKLabel  && value) increaseATK = value;
          if (isElemLabel && value) increaseElementDamageDealt = value;
        }
      }
    }

    // Sync level — Strategy 1: exact "LV###" standalone leaf element
    const allTextEls = Array.from(document.querySelectorAll("div, span, p, td, label, h1, h2, h3, h4"));
    for (const el of allTextEls) {
      if (el.children.length > 0) continue;
      const text = el.innerText?.trim() || "";
      if (/^LV\d{1,4}$/i.test(text)) {
        const num = parseInt(text.replace(/^LV/i, ""), 10);
        if (num >= 1) { syncLevel = num; break; }
      }
    }

    // Strategy 2: short text with optional space "LV 699"
    if (!syncLevel) {
      for (const el of allTextEls) {
        const text = el.innerText?.trim() || "";
        if (text.length > 10) continue;
        const match = text.match(/^LV\s*(\d{1,4})$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num >= 1) { syncLevel = num; break; }
        }
      }
    }

    // Strategy 3: range/number input element (the actual slider)
    if (!syncLevel) {
      const inputs = Array.from(document.querySelectorAll("input[type='range'], input[type='number']"));
      for (const inp of inputs) {
        const val = parseInt(inp.value, 10);
        if (!isNaN(val) && val >= 1 && val <= 800) { syncLevel = val; break; }
      }
    }

    // Strategy 4: scan all page text for any LV + digits (last resort)
    if (!syncLevel) {
      const fullText = document.body.innerText || "";
      const matches = [...fullText.matchAll(/\bLV\s*(\d{1,4})\b/gi)];
      for (const m of matches) {
        const num = parseInt(m[1], 10);
        if (num >= 1 && num <= 800) { syncLevel = num; break; }
      }
    }

    return { increaseATK, increaseElementDamageDealt, syncLevel, allSlotsNoEffects };
  });

  // ---- Determine status ----
  const atk  = extractedData.increaseATK ?? "0%";
  const elem = extractedData.increaseElementDamageDealt ?? "0%";

  if (pageState === "not_owned") {
    console.log(`   ❌ Member does not own this Nikke`);
    return { status: "NOT OWNED", nikkeName: nikkeNameFromCsv, syncLevel: "-", increaseATK: "-", increaseElementDamageDealt: "-" };
  }

  const hasNoGearUpgrades = extractedData.allSlotsNoEffects && atk === "0%" && elem === "0%";
  const syncLevel = extractedData.syncLevel ?? null;

  return {
    status:                      hasNoGearUpgrades ? "NO GEAR" : "OK",
    nikkeName:                   nikkeNameFromCsv,
    syncLevel:                   syncLevel !== null ? syncLevel : "N/A",
    syncLevelNote:               syncLevel === null ? "* Could not detect sync level" : "",
    increaseATK:                 atk,
    increaseElementDamageDealt:  elem,
  };
}

// ============================================================
//  SCRAPE MODE
// ============================================================
async function runScrapeMode() {
  const { members, nikkes } = readInput();
  const chosenNikke = await pickNikke(nikkes);

  console.log(`🚀 BlablaLink Scraper`);
  console.log(`   Nikke   : [ID: ${chosenNikke.nikke_id}] ${chosenNikke.nikke_name}`);
  console.log(`   Total   : ${members.length} member(s)\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath:
      process.platform === "win32"
        ? (fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
            ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
            : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")
        : undefined
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  await loadCookies(page);

  const results = [];

  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    console.log(`\n🔗 [${member.name} × ${chosenNikke.nikke_name}]`);

      // Only retry technical failures — definitive statuses never need retrying
      const RETRYABLE = ["NOT LOADED", "ERROR"];
      const MAX_ATTEMPTS = 3;
      const RETRY_DELAYS = [0, 4000, 6000];

      let stats = null;
      let lastError = null;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          console.log(`   🔄 Retry attempt ${attempt}/${MAX_ATTEMPTS} (waiting ${RETRY_DELAYS[attempt-1]/1000}s)...`);
          await sleep(RETRY_DELAYS[attempt - 1]);
        }

        try {
          stats = await scrapeNikkePage(page, chosenNikke.nikke_id, member.uid, chosenNikke.nikke_name);
        } catch (err) {
          lastError = err;
          stats = { status: "ERROR", nikkeName: chosenNikke.nikke_name, syncLevel: "-", syncLevelNote: "", increaseATK: "-", increaseElementDamageDealt: "-" };
        }

        if (!RETRYABLE.includes(stats.status)) break;
        if (stats.status === "NOT OWNED" || stats.status === "PRIVATE") break;
        if (attempt < MAX_ATTEMPTS) console.log(`   ⚠ Got "${stats.status}" — will retry...`);
      }

      const statusEmoji = {
        "OK":         "✅",
        "NO GEAR":    "⚙️ ",
        "PRIVATE":    "🔒",
        "NOT OWNED":  "❌",
        "NOT LOADED": "⏳",
        "ERROR":      "💥",
      }[stats.status] ?? "❓";

      console.log(`   ${statusEmoji} Status                        : ${stats.status}`);
      if (stats.status === "OK" || stats.status === "NO GEAR") {
        console.log(`   ✅ Sync Level                   : ${stats.syncLevel}`);
        console.log(`   ✅ Increase Element Damage Dealt: ${stats.increaseElementDamageDealt}`);
        console.log(`   ✅ Increase ATK                 : ${stats.increaseATK}`);
      }

      results.push({
        member_name:                    member.name,
        sync_level:                     stats.syncLevel,
        nikke_id:                       chosenNikke.nikke_id,
        nikke_name:                     stats.nikkeName,
        increase_element_damage_dealt:  stats.increaseElementDamageDealt,
        increase_atk:                   stats.increaseATK,
        status:                         stats.status,
        notes:                          stats.syncLevelNote ?? "",
      });

    if (i < members.length - 1) await sleep(DELAY_MS);
  }

  // ---- Post-run re-scrape for NOT LOADED members ----
  const failedMembers = members.filter((m, i) =>
    results[i] && (results[i].status === "NOT LOADED" || results[i].status === "ERROR")
  );

  if (failedMembers.length > 0) {
    console.log(`\n🔁 Post-run recovery: ${failedMembers.length} member(s) to retry...`);

    const browser2 = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      executablePath:
        process.platform === "win32"
          ? (fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe")
              ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
              : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe")
          : undefined
    });

    const page2 = await browser2.newPage();
    await page2.setViewport({ width: 1200, height: 900 });
    await page2.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await loadCookies(page2);

    for (const member of failedMembers) {
      const resultIdx = results.findIndex(r => r.member_name === member.name);
      console.log(`\n🔄 Recovering [${member.name} × ${chosenNikke.nikke_name}]`);

      await sleep(5000);

      let recovered = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) {
          console.log(`   ↪ Recovery attempt ${attempt}/3...`);
          await sleep(6000);
        }
        try {
          recovered = await scrapeNikkePage(page2, chosenNikke.nikke_id, member.uid, chosenNikke.nikke_name);
        } catch (err) {
          recovered = { status: "ERROR", nikkeName: chosenNikke.nikke_name, syncLevel: "-", syncLevelNote: "", increaseATK: "-", increaseElementDamageDealt: "-" };
        }
        if (recovered.status !== "NOT LOADED" && recovered.status !== "ERROR") break;
        if (attempt < 3) console.log(`   ⚠ Still "${recovered.status}" — retrying...`);
      }

      const statusEmoji = { "OK": "✅", "NO GEAR": "⚙️ ", "PRIVATE": "🔒", "NOT OWNED": "❌", "NOT LOADED": "⏳", "ERROR": "💥" }[recovered.status] ?? "❓";
      console.log(`   ${statusEmoji} Recovery result: ${recovered.status}`);
      if (recovered.status === "OK" || recovered.status === "NO GEAR") {
        console.log(`   ✅ Sync Level                   : ${recovered.syncLevel}`);
        console.log(`   ✅ Increase Element Damage Dealt: ${recovered.increaseElementDamageDealt}`);
        console.log(`   ✅ Increase ATK                 : ${recovered.increaseATK}`);
      }

      if (resultIdx !== -1) {
        results[resultIdx] = {
          member_name:                    member.name,
          sync_level:                     recovered.syncLevel,
          nikke_id:                       chosenNikke.nikke_id,
          nikke_name:                     recovered.nikkeName,
          increase_element_damage_dealt:  recovered.increaseElementDamageDealt,
          increase_atk:                   recovered.increaseATK,
          status:                         recovered.status,
          notes:                          recovered.syncLevelNote ?? "",
        };
      }
    }

    await browser2.close();
  } else {
    console.log(`\n✅ No failed members to recover.`);
  }

  await browser.close();

  const csv = stringify(results, {
    header: true,
    columns: [
      { key: "member_name",                   header: "Member Name" },
      { key: "sync_level",                    header: "Sync Level" },
      { key: "nikke_id",                      header: "Nikke ID" },
      { key: "nikke_name",                    header: "Nikke Name" },
      { key: "increase_element_damage_dealt", header: "Increase Element Damage Dealt" },
      { key: "increase_atk",                  header: "Increase ATK" },
      { key: "status",                        header: "Status" },
      { key: "notes",                         header: "Notes" },
    ],
  });

  const finalCsvPath = getOutputFilePath(chosenNikke.nikke_name);
  fs.writeFileSync(finalCsvPath, csv, "utf-8");

  // ---- Summary ----
  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log(`\n📄 Saved to ${finalCsvPath} — ${results.length} row(s)`);
  console.log(`📊 Summary:`);
  for (const [status, count] of Object.entries(summary)) {
    const emoji = { "OK": "✅", "NO GEAR": "⚙️ ", "PRIVATE": "🔒", "NOT OWNED": "❌", "NOT LOADED": "⏳", "ERROR": "💥" }[status] ?? "❓";
    console.log(`   ${emoji} ${status}: ${count}`);
  }
}

// ---- ENTRY POINT ----
if (isLoginMode) {
  runLoginMode().catch(console.error);
} else {
  runScrapeMode().catch(console.error);
}
