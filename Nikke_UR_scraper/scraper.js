const puppeteer = require("puppeteer");
const fs = require("fs");
const { stringify } = require("csv-stringify/sync");

// ============================================================
//  CONFIG BOUNDARY
// ============================================================
const CONFIG_FILE  = "config.json";
const COOKIES_FILE = "cookies.json";
const OUTPUT_FILE  = "union_raid_day2.csv";
const LOGIN_URL    = "https://www.blablalink.com";

const isLoginMode = process.argv.includes("--login");

// Step 2 Rule Matrix: Circular Weakness Rule System Lookup
const WEAKNESS_MAP = {
  fire:     "wind",     // Fire boss is weak against Wind squads
  wind:     "iron",     // Wind boss is weak against Iron squads
  iron:     "electric", // Iron boss is weak against Electric squads
  electric: "water",    // Electric boss is weak against Water squads
  water:    "fire",     // Water boss is weak against Fire squads
};

const ELEMENT_COLORS = {
  fire:     "#D3361E",
  wind:     "#86C67C",
  iron:     "#F0B27A",
  electric: "#8C79C5",
  water:    "#74B4E7",
};
// ============================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    const template = { union_page_url: "https://www.blablalink.com/shiftyspad", season_label: "S41" };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(template, null, 2));
    console.error(`\n❌ config.json not found — created a template. Fill it in then re-run.\n`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
}

async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    const lsData = await page.evaluate(() => {
      const d = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        d[k] = window.localStorage.getItem(k);
      }
      return d;
    });
    fs.writeFileSync(COOKIES_FILE, JSON.stringify({ cookies, localStorage: lsData }, null, 2));
    console.log(`🍪 Session saved successfully (${cookies.length} cookies + localStorage)`);
  } catch (err) {
    console.error(`⚠ Warning during saving session: ${err.message}`);
  }
}

async function loadCookies(page) {
  if (!fs.existsSync(COOKIES_FILE)) {
    console.error(`\n❌ No session cookies found. Run: node scraper.js --login\n`);
    process.exit(1);
  }
  const { cookies, localStorage: lsData } = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf-8"));
  if (cookies?.length) await page.setCookie(...cookies);
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
  if (lsData && Object.keys(lsData).length > 0) {
    await page.evaluate(d => {
      for (const [k, v] of Object.entries(d)) window.localStorage.setItem(k, v);
    }, lsData);
  }
  console.log(`🍪 Loaded ${cookies?.length ?? 0} cookies onto target context.`);
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(1500);
}

async function runLoginMode() {
  console.log(`\n🔐 [LOGIN MODE] — Browser will open. Log in then CLOSE the browser to save session.\n`);
  const browser = await puppeteer.launch({
    headless: false, defaultViewport: null,
    args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"]
  });
  const pages = await browser.browserContexts();
  const page = (await browser.pages())[0];
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });

  let connected = true;
  browser.on("disconnected", () => { connected = false; });
  console.log("⏳ Waiting for you to log in and close the browser...");
  while (connected) {
    try {
      const currentPages = await browser.pages();
      if (currentPages.length === 0) break;
      const target = currentPages.find(p => p.url().includes("blablalink.com"));
      if (target) await saveCookies(target);
    } catch { break; }
    await sleep(2000);
  }
  console.log(`\n✅ Session captured! Now run: node scraper.js\n`);
}




function interceptAPI(page) {
  const log = {};
  page.on("response", async res => {
    const ct = res.headers()["content-type"] || "";
    if (!ct.includes("json")) return;
    try {
      const json = await res.json();
      const path = new URL(res.url()).pathname;
      log[path] = json;
    } catch {}
  });
  return log;
}

async function clickText(page, text, timeout = 8000) {
  await page.waitForFunction(
    t => Array.from(document.querySelectorAll("*")).some(el => el.innerText?.trim() === t && el.offsetParent !== null),
    { timeout }, text
  );
  await page.evaluate(t => {
    const el = Array.from(document.querySelectorAll("*"))
      .find(e => e.innerText?.trim() === t && e.offsetParent !== null);
    if (el) el.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true }));
  }, text);
}

async function scrapeUnionRaid(page, config) {
  interceptAPI(page);

  console.log(`🌐 Navigating to URL: ${config.union_page_url}`);
  await page.goto(config.union_page_url, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(2000);

  console.log(`📋 Step 1: Clicking Union Raid tab...`);
  await clickText(page, "Union Raid");
  await sleep(2000);

  console.log(`📋 Step 2: Clicking Details...`);
  await clickText(page, "Details");
  await sleep(3000);

  const pages = await page.browser().pages();
  const tp = pages.length > 1 ? pages[pages.length - 1] : page;
  if (pages.length > 1) {
    interceptAPI(tp);
    await tp.bringToFront();
    await sleep(2000);
  }

  // ---- Step 3: Click Day 2 (Hard) tab ----
  console.log(`📋 Step 3: Switching to Day 2 (Hard) tab...`);
  try {
    await tp.waitForFunction(
      () => Array.from(document.querySelectorAll("*"))
        .some(el => el.innerText?.includes("Day 2") && el.offsetParent !== null),
      { timeout: 15000 }
    );
  } catch { console.log("⚠ Day 2 wait timed out, proceeding anyway..."); }

  const day2Clicked = await tp.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));
    const candidates = all.filter(el => el.innerText?.includes("Day 2") && el.offsetParent !== null);
    if (!candidates.length) return false;

    candidates.sort((a, b) => a.innerText.length - b.innerText.length);
    const tab = candidates[0];
    tab.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true }));
    return tab.innerText?.trim();
  });

  if (!day2Clicked) {
    console.error("❌ Could not find Day 2 tab");
    process.exit(1);
  }
  console.log(`   ✅ Clicked tab: "${day2Clicked.replace(/\n/g, ' ')}"`);
  await sleep(4000);

  // ---- Step 4: Robust Index-based Matrix Scraping ----
  console.log(`📋 Step 4: Collecting member list via multi-container scroll tactics...`);

  const members = await tp.evaluate(async () => {
    const map = new Map();
    let stale = 0;
    let lastSize = 0;

    const getScrollTargets = () => {
      const targets = [window];
      const table = document.querySelector("table");
      if (table) {
        if (table.parentElement) targets.push(table.parentElement);
        if (table.closest("div")) targets.push(table.closest("div"));
      }
      return targets;
    };

    const scrollTargets = getScrollTargets();

    for (let i = 0; i < 80; i++) {
      const rows = Array.from(document.querySelectorAll("tr"));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td")).map(td => td.innerText?.trim());
        if (cells.length < 4) continue;

        const memberName = cells[1]; 
        const partCount  = cells[2]; 
        const totalDmg   = cells[3]; 

        if (!memberName || memberName === "Member" || !totalDmg.match(/\d/)) continue;

        if (!map.has(memberName)) {
          map.set(memberName, {
            name: memberName,
            participationCount: partCount || "?",
            totalDamage: totalDmg || "0",
          });
        }
      }

      if (map.size === lastSize) {
        if (++stale >= 7) break;
      } else {
        stale = 0;
        lastSize = map.size;
      }

      scrollTargets.forEach(target => {
        if (target === window) window.scrollBy(0, 300);
        else if (target) target.scrollTop += 300;
      });
      await new Promise(r => setTimeout(r, 600));
    }

    scrollTargets.forEach(target => {
      if (target === window) window.scrollTo(0, 0);
      else if (target) target.scrollTop = 0;
    });
    await new Promise(r => setTimeout(r, 600));

    return Array.from(map.values());
  });

  console.log(`   ✅ Found ${members.length} unique members`);

  // ---- Step 5: Advanced Visual Processing & Extraction Matrix ----
  console.log(`📋 Step 5: Processing layout frames and conducting local image comparisons...`);
  const results = [];

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    console.log(`   🔍 [${i+1}/${members.length}] Scraping: ${m.name}`);

    await tp.evaluate(name => {
      const rows = Array.from(document.querySelectorAll("tr"));
      const row = rows.find(r => {
        const tds = r.querySelectorAll("td");
        return tds.length >= 2 && tds[1].innerText?.trim() === name;
      });
      row?.scrollIntoView({ block: "center", behavior: "instant" });
    }, m.name);
    await sleep(600);

    const found = await tp.evaluate(name => {
      const rows = Array.from(document.querySelectorAll("tr"));
      const row = rows.find(r => {
        const tds = r.querySelectorAll("td");
        return tds.length >= 2 && tds[1].innerText?.trim() === name;
      });
      if (!row) return false;

      const interactiveElement = 
        row.querySelector("svg") || 
        row.querySelector("img") || 
        row.querySelector("button") || 
        row.querySelector("[class*='search']") ||
        row.querySelector("[class*='icon']") ||
        row.querySelectorAll("td")[row.querySelectorAll("td").length - 1];

      if (interactiveElement) {
        interactiveElement.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true }));
        return true;
      }
      return false;
    }, m.name);

    if (!found) {
      console.log(`   ⚠ Could not find trigger component for ${m.name}`);
      results.push({ ...m, attempts: [] });
      continue;
    }

    await sleep(3500); 

    // Find bounding box coordinates of the damage numbers first
    const rawAttemptsData = await tp.evaluate(() => {
      const container = document.body;
      const allElements = Array.from(container.querySelectorAll("*"));
      const matchedData = [];

      const candidates = allElements.filter(el => {
        const txt = (el.innerText || "").replace(/\s/g, "");
        return /^\d{1,3}(,\d{3}){1,}$/.test(txt);
      });

      const uniqueLeafs = candidates.filter(el => {
        return !Array.from(el.querySelectorAll("*")).some(child => candidates.includes(child));
      });

      for (const dmgEl of uniqueLeafs) {
        const dmgValue = dmgEl.innerText.trim();

        if (parseInt(dmgValue.replace(/,/g, ""), 10) <= 1000000) continue;

        // Each attempt card has class containing "bg-[#f4f4f4]" — this is the
        // confirmed, reliable boundary for one attempt block (header + avatars + damage)
        let currentParent = dmgEl.parentElement;
        let attemptCard = null;

        for (let depth = 0; depth < 12; depth++) {
          if (!currentParent || currentParent === container) break;
          const cls = currentParent.className || "";
          if (typeof cls === "string" && cls.includes("bg-[#f4f4f4]")) {
            attemptCard = currentParent;
            break;
          }
          currentParent = currentParent.parentElement;
        }

        if (!attemptCard) attemptCard = dmgEl.parentElement?.parentElement || dmgEl.parentElement;

        const allCardImgs = Array.from(attemptCard.querySelectorAll("img"));
        const targetImg = allCardImgs.find(img => (img.src || "").toLowerCase().includes("icon-code-"));

        matchedData.push({
          damage: dmgValue,
          srcUrl: targetImg ? targetImg.src : "",
        });
      }

      return matchedData;
    });

    // Detect element directly from the icon filename (e.g. "icon-code-electronic.png")
    // No screenshot/pixel-matching needed — the filename tells us everything.
    const processedAttempts = rawAttemptsData.map(raw => {
      let detectedElement = "unknown";
      const srcLower = (raw.srcUrl || "").toLowerCase();

      if (srcLower.includes("icon-code-electronic") || srcLower.includes("icon-code-electric")) detectedElement = "electric";
      else if (srcLower.includes("icon-code-fire"))    detectedElement = "fire";
      else if (srcLower.includes("icon-code-water"))   detectedElement = "water";
      else if (srcLower.includes("icon-code-wind"))    detectedElement = "wind";
      else if (srcLower.includes("icon-code-iron"))    detectedElement = "iron";

      const weakness = detectedElement !== "unknown" ? WEAKNESS_MAP[detectedElement] : "-";
      return { damage: raw.damage, bossElement: detectedElement, weakness };
    });

    console.log(`      ↳ Scraped successfully: ${processedAttempts.length} row(s)`);
    processedAttempts.forEach((a, idx) => {
      console.log(`         [Attempt ${idx+1}] Match: ${a.bossElement.toUpperCase()} ➔ Weakness Target: ${a.weakness.toUpperCase()} | Damage: ${a.damage}`);
    });

    results.push({ ...m, attempts: processedAttempts });

    await tp.keyboard.press("Escape");
    await sleep(500);
    await tp.evaluate(() => {
      const closeButtons = Array.from(document.querySelectorAll("[class*='close'], [class*='back'], button"));
      const actualClose = closeButtons.find(b => {
        const txt = b.innerText?.toLowerCase() || "";
        return txt === "" || txt.includes("close") || txt.includes("x");
      });
      if (actualClose) actualClose.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true }));
    });
    await sleep(1000);
  }

  return results;
}

function buildCSV(results) {
  const maxA = Math.max(...results.map(r => r.attempts?.length || 0), 3);
  const cols = [
    { key: "member",        header: "Member" },
    { key: "participation", header: "Participation" },
    { key: "total_damage",  header: "Total Damage" },
  ];
  
  for (let i = 1; i <= maxA; i++) {
    cols.push({ key: `a${i}_weakness`, header: `Attempt ${i} Weakness` });
    cols.push({ key: `a${i}_damage`,   header: `Attempt ${i} Damage` });
  }
  
  const rows = results.map(r => {
    const row = { member: r.name, participation: r.participationCount, total_damage: r.totalDamage };
    for (let i = 0; i < maxA; i++) {
      const a = r.attempts?.[i];
      row[`a${i+1}_weakness`] = a?.weakness ? a.weakness.charAt(0).toUpperCase() + a.weakness.slice(1) : "-";
      row[`a${i+1}_damage`]   = a?.damage || "-";
    }
    return row;
  });
  return stringify(rows, { header: true, columns: cols });
}

async function runScrapeMode() {
  const config = readConfig();
  console.log(`\n🚀 Union Raid Scraper Active — Day 2 (Hard)`);
  console.log(`   Target Hub: ${config.union_page_url}\n`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  await loadCookies(page);

  let results = [];
  try {
    results = await scrapeUnionRaid(page, config);
  } catch (err) {
    console.error(`\n❌ Execution Error: ${err.message}`);
    console.error(err.stack);
  }

  await browser.close();

  if (!results.length) { console.error("❌ No data scraped."); process.exit(1); }

  fs.writeFileSync("element_debug_log.json", JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n📂 [Snapshot] Detailed asset trace map saved to: element_debug_log.json`);

  fs.writeFileSync(OUTPUT_FILE, buildCSV(results), "utf-8");
  console.log(`📄 Spreadsheet Report Saved Successfully: ${OUTPUT_FILE}`);
}

if (isLoginMode) runLoginMode().catch(console.error);
else runScrapeMode().catch(console.error);