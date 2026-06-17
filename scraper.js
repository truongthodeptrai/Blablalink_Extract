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
    // The page shows a lock icon, "private", or redirects to a generic profile page
    const privateKeywords = ["private", "this profile is private", "프라이빗", "비공개"];
    for (const kw of privateKeywords) {
      if (bodyText.toLowerCase().includes(kw)) return "private";
    }

    // If the page has no "Equipment" tab at all, it's likely private or failed to load
    const hasEquipmentTab = bodyText.includes("Equipment");
    if (!hasEquipmentTab) {
      // Check if there's a login prompt instead
      const loginKeywords = ["sign in", "log in", "login", "로그인"];
      for (const kw of loginKeywords) {
        if (bodyText.toLowerCase().includes(kw)) return "private";
      }
      return "not_loaded";
    }

    // --- Equipment Effects section present? ---
    const hasEquipmentEffects = bodyText.includes("Equipment Effects");
    if (!hasEquipmentEffects) return "not_loaded";

    // --- Check if the correct Nikke is shown ---
    // BlablaLink embeds the nikke ID in the page URL or data attributes
    // We check if any element references the expected nikke ID
    const hasCorrectNikke =
      bodyHTML.includes(`"nikke":${nikkeId}`) ||
      bodyHTML.includes(`"nikke":"${nikkeId}"`) ||
      bodyHTML.includes(`nikke=${nikkeId}`) ||
      // Fallback: if Equipment Effects loaded at all, assume correct nikke
      hasEquipmentEffects;

    if (!hasCorrectNikke) return "not_owned";

    // --- Does the member actually own this nikke? ---
    // If "No Effects" appears in ALL equipment slots, they either don't own it
    // or have zero gear — we handle this as valid 0% data, not an error
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

  // Wait for Equipment Effects to render
  try {
    await page.waitForFunction(
      () => {
        const el = Array.from(document.querySelectorAll("div, span, p, h1, h2, h3, h4"))
                        .find(x => x.innerText?.trim() === "Equipment Effects");
        if (!el) return false;
        return el.parentElement?.innerText?.includes("%") || document.body.innerText.includes("No Effects");
      },
      { timeout: 8000 }
    );
  } catch {
    console.log(`   ⚠ Waiting longer for render...`);
    await sleep(3000);
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
    let nikkeNotOwned = false;

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

      // If "No Effects" appears for everything, member owns nikke but has no gear
      // We count how many % values appear — if none, it's likely not owned
      const percentMatches = containerText.match(/\d+\.?\d*%/g) || [];
      if (percentMatches.length === 0 && !containerText.includes("No Effects")) {
        nikkeNotOwned = true;
      }

      const childElements = Array.from(topContainer.querySelectorAll("div, span, td, p"));
      for (let i = 0; i < childElements.length; i++) {
        const text = childElements[i].innerText?.trim() || "";
        if (text.toLowerCase() === "increase atk") {
          const contextText = childElements[i].parentElement?.innerText || "";
          const match = contextText.match(/(\d+\.?\d*%)/);
          if (match) increaseATK = match[1];
        }
        if (text.toLowerCase() === "increase element damage dealt") {
          const contextText = childElements[i].parentElement?.innerText || "";
          const match = contextText.match(/(\d+\.?\d*%)/);
          if (match) increaseElementDamageDealt = match[1];
        }
      }
    }

    // Sync level — exact "LV###" standalone label only
    const allTextEls = Array.from(document.querySelectorAll("div, span, p, td, label"));
    for (const el of allTextEls) {
      if (el.children.length > 0) continue;
      const text = el.innerText?.trim() || "";
      if (/^LV\d{1,4}$/i.test(text)) {
        const num = parseInt(text.replace(/^LV/i, ""), 10);
        if (num >= 10) { syncLevel = num; break; }
      }
    }
    // Fallback sync level
    if (!syncLevel) {
      for (const el of allTextEls) {
        const text = el.innerText?.trim() || "";
        if (text.length > 10) continue;
        const match = text.match(/^LV\s*(\d+)$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num >= 10) { syncLevel = num; break; }
        }
      }
    }

    return { increaseATK, increaseElementDamageDealt, syncLevel, nikkeNotOwned };
  });

  // ---- Determine status ----
  // not_owned from DOM check OR no data at all with no "No Effects" either
  if (extractedData.nikkeNotOwned || pageState === "not_owned") {
    console.log(`   ❌ Member does not own this Nikke`);
    return { status: "NOT OWNED", nikkeName: nikkeNameFromCsv, syncLevel: "-", increaseATK: "-", increaseElementDamageDealt: "-" };
  }

  // Owns nikke but gear not upgraded — 0% is correct, not an error
  const atk  = extractedData.increaseATK ?? "0%";
  const elem = extractedData.increaseElementDamageDealt ?? "0%";
  const hasNoGearUpgrades = atk === "0%" && elem === "0%";

  return {
    status:                      hasNoGearUpgrades ? "NO GEAR" : "OK",
    nikkeName:                   nikkeNameFromCsv,
    syncLevel:                   extractedData.syncLevel ?? 0,
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

    try {
      const stats = await scrapeNikkePage(page, chosenNikke.nikke_id, member.uid, chosenNikke.nikke_name);

      // Status emoji for console
      const statusEmoji = {
        "OK":         "✅",
        "NO GEAR":    "⚙️ ",
        "PRIVATE":    "🔒",
        "NOT OWNED":  "❌",
        "NOT LOADED": "⏳",
      }[stats.status] ?? "❓";

      console.log(`   ${statusEmoji} Status                        : ${stats.status}`);
      if (stats.status === "OK" || stats.status === "NO GEAR") {
        console.log(`   ✅ Sync Level                   : ${stats.syncLevel}`);
        console.log(`   ✅ Increase ATK                 : ${stats.increaseATK}`);
        console.log(`   ✅ Increase Element Damage Dealt: ${stats.increaseElementDamageDealt}`);
      }

      results.push({
        member_name:                    member.name,
        sync_level:                     stats.syncLevel,
        nikke_id:                       chosenNikke.nikke_id,
        nikke_name:                     stats.nikkeName,
        increase_atk:                   stats.increaseATK,
        increase_element_damage_dealt:  stats.increaseElementDamageDealt,
        status:                         stats.status,
      });
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      results.push({
        member_name:                    member.name,
        sync_level:                     "-",
        nikke_id:                       chosenNikke.nikke_id,
        nikke_name:                     chosenNikke.nikke_name,
        increase_atk:                   "-",
        increase_element_damage_dealt:  "-",
        status:                         "ERROR",
      });
    }

    if (i < members.length - 1) await sleep(DELAY_MS);
  }

  await browser.close();

  const csv = stringify(results, {
    header: true,
    columns: [
      { key: "member_name",                   header: "Member Name" },
      { key: "sync_level",                    header: "Sync Level" },
      { key: "nikke_id",                      header: "Nikke ID" },
      { key: "nikke_name",                    header: "Nikke Name" },
      { key: "increase_atk",                  header: "Increase ATK" },
      { key: "increase_element_damage_dealt", header: "Increase Element Damage Dealt" },
      { key: "status",                        header: "Status" },
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
