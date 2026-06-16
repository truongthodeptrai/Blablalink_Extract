const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");

// ============================================================
//  FILES & CONFIG
// ============================================================
const INPUT_FILE   = "input.csv";
const OUTPUT_FILE  = "output.csv";
const COOKIES_FILE = "cookies.json";
const BASE_URL     = "https://www.blablalink.com/shiftyspad/nikke";
const LOGIN_URL    = "https://www.blablalink.com";
const DELAY_MS     = 1500; // Giảm delay xuống vì quét DOM rất nhanh
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
  await sleep(2000);
}

// ---- LOGIN MODE ----
async function runLoginMode() {
  console.log(`\n🔐 LOGIN MODE — a browser window will open.`);
  console.log(`   Log in, then come back here and press ENTER.\n`);
  const browser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ["--start-maximized"] });
  const page = await browser.newPage();
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("👉 Press ENTER once logged in... ", () => { rl.close(); resolve(); });
  });
  await saveCookies(page);
  await browser.close();
  console.log(`\n✅ Session saved! Now run: node scraper.js\n`);
}

// ---- SCRAPE ONE NIKKE PAGE (TARGETED TOP CONTAINER MODE) ----
async function scrapeNikkePage(page, nikkeId, uid, nikkeNameFromCsv) {
  const url = buildUrl(nikkeId, uid);
  console.log(`   ${url}`);

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

  // Đợi tiêu đề xuất hiện để chắc chắn trang đã load xong khung cơ bản
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes("Equipment Effects"),
      { timeout: 12000 }
    );
  } catch (e) {
    console.log(`   ⚠ Timed out waiting for Equipment Effects container`);
  }

  // Chờ thêm một chút ngắn để các con số render xong hoàn toàn vào DOM
  await sleep(800);

  // Kỹ thuật Hộp xám chuyên biệt: Chỉ tìm và quét trong "Khối tổng thể đầu tiên"
  const extractedData = await page.evaluate(() => {
    let increaseATK = "NOT FOUND";
    let increaseElementDamageDealt = "NOT FOUND";

    // Tìm tất cả các khối bao quanh chữ "Equipment Effects" trên cùng
    const headings = Array.from(document.querySelectorAll("div, span, p, h1, h2, h3, h4"));
    let topContainer = null;

    for (const el of headings) {
      if (el.innerText?.trim() === "Equipment Effects") {
        // Lấy thẻ cha lớn chứa toàn bộ cái bảng tổng hợp trên cùng này
        topContainer = el.parentElement;
        break;
      }
    }

    // Nếu tìm thấy khối tổng thể, ta chỉ bóc tách các thẻ con bên trong khối này thôi
    if (topContainer) {
      const childElements = Array.from(topContainer.querySelectorAll("div, span, td, p"));
      
      for (let i = 0; i < childElements.length; i++) {
        const text = childElements[i].innerText?.trim() || "";

        if (text.toLowerCase() === "increase atk") {
          // Lấy text của thẻ cha hoặc thẻ bao quanh để tìm giá trị % đi kèm
          const contextText = childElements[i].parentElement?.innerText || "";
          const match = contextText.match(/(\d+\.\d+\%)/);
          if (match) increaseATK = match[1];
        }
        
        if (text.toLowerCase() === "increase element damage dealt") {
          const contextText = childElements[i].parentElement?.innerText || "";
          const match = contextText.match(/(\d+\.\d+\%)/);
          if (match) increaseElementDamageDealt = match[1];
        }
      }
    }

    // Lấy tên nhân vật hiển thị trên cùng
    let nikkeName = "";
    for (const h of document.querySelectorAll("h1, h2, h3, [class*='title'], [class*='name']")) {
      const t = h.innerText?.trim();
      if (t && t.length > 1 && t.length < 40 && !t.startsWith("CV:")) {
        nikkeName = t;
        break;
      }
    }

    return { nikkeName, increaseATK, increaseElementDamageDealt };
  });

  // Trả ra kết quả biên (Nếu không tìm thấy tức là bằng 0% hoặc chưa nâng cấp)
  return {
    nikkeName: nikkeNameFromCsv,
    increaseATK: extractedData.increaseATK === "NOT FOUND" ? "0%" : extractedData.increaseATK,
    increaseElementDamageDealt: extractedData.increaseElementDamageDealt === "NOT FOUND" ? "0%" : extractedData.increaseElementDamageDealt
  };
}

// ---- SCRAPE MODE ----
async function runScrapeMode() {
  const { members, nikkes } = readInput();
  const chosenNikke = await pickNikke(nikkes);

  console.log(`🚀 BlablaLink Scraper (Targeted Top-Table Mode)`);
  console.log(`   Nikke   : [ID: ${chosenNikke.nikke_id}] ${chosenNikke.nikke_name}`);
  console.log(`   Total   : ${members.length} member(s)\n`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  // Giữ kích thước màn hình chuẩn để bảng hiển thị trực quan
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

      console.log(`   ✅ Increase ATK                 : ${stats.increaseATK}`);
      console.log(`   ✅ Increase Element Damage Dealt: ${stats.increaseElementDamageDealt}`);

      results.push({
        member_name:                    member.name,
        nikke_id:                       chosenNikke.nikke_id,
        nikke_name:                     stats.nikkeName,
        increase_atk:                   stats.increaseATK,
        increase_element_damage_dealt:  stats.increaseElementDamageDealt,
        error: "",
      });
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      results.push({
        member_name:                    member.name,
        nikke_id:                       chosenNikke.nikke_id,
        nikke_name:                     chosenNikke.nikke_name,
        increase_atk:                   "ERROR",
        increase_element_damage_dealt:  "ERROR",
        error:                          err.message,
      });
    }

    if (i < members.length - 1) await sleep(DELAY_MS);
  }

  await browser.close();

  const csv = stringify(results, {
    header: true,
    columns: [
      { key: "member_name",                   header: "Member Name" },
      { key: "nikke_id",                      header: "Nikke ID" },
      { key: "nikke_name",                    header: "Nikke Name" },
      { key: "increase_atk",                  header: "Increase ATK" },
      { key: "increase_element_damage_dealt", header: "Increase Element Damage Dealt" },
      { key: "error",                         header: "Error" },
    ],
  });

  fs.writeFileSync(OUTPUT_FILE, csv, "utf-8");
  console.log(`\n📄 Saved to ${OUTPUT_FILE} — ${results.length} row(s)`);
}

// ---- ENTRY POINT ----
if (isLoginMode) {
  runLoginMode().catch(console.error);
} else {
  runScrapeMode().catch(console.error);
}