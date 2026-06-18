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

const WEAKNESS_MAP = {
  fire:     "wind",
  wind:     "iron",
  iron:     "electric",
  electric: "water",
  water:    "fire",
};

const ELEMENT_COLORS = {
  fire:     "#D3361E",
  wind:     "#86C67C",
  iron:     "#F0B27A",
  electric: "#8C79C5",
  water:    "#74B4E7",
};

const ELEMENT_KEYWORDS = {
  fire:     ["fire", "flame", "blaze"],
  wind:     ["wind", "air", "breeze"],
  iron:     ["iron", "steel", "metal"],
  electric: ["electric", "elec", "thunder", "lightning", "zeus"],
  water:    ["water", "aqua", "ice"],
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

// Safe dispatch click — works on ANY element including SVG, img, div
function safeDispatchClick(el) {
  el.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true }));
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
  const pages = await browser.pages();
  const page = pages[0];
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

function detectElement(src, alt, cls) {
  const hay = `${src} ${alt} ${cls}`.toLowerCase();
  for (const [elem, kws] of Object.entries(ELEMENT_KEYWORDS)) {
    if (kws.some(kw => hay.includes(kw))) return elem;
  }
  return null;
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
  // The tab contains BOTH "HARD" badge text AND "Day 2" text inside it.
  // We find the SMALLEST element that contains "Day 2" — that's the tab itself,
  // not a parent container. We also skip elements that contain "Day 1" to avoid
  // accidentally matching a parent that wraps both tabs.
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

    // Find all visible elements whose text includes "Day 2"
    const candidates = all.filter(el =>
      el.innerText?.includes("Day 2") &&
      el.offsetParent !== null
    );

    if (!candidates.length) return false;

    // Pick the one with the SHORTEST innerText — that's the actual tab button,
    // not a container wrapping multiple tabs
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
  await sleep(3000);

  // ---- Step 4: Scroll and collect all members ----
  console.log(`📋 Step 4: Collecting member list via scroll...`);

  // Debug: identify all scrollable containers on the page
  const containerInfo = await tp.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));
    return all
      .filter(el => el.scrollHeight > el.clientHeight + 10)
      .map(el => ({
        tag: el.tagName,
        cls: el.className?.toString().slice(0, 60),
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
        overflow: getComputedStyle(el).overflowY,
      }))
      .filter(el => el.overflow === "auto" || el.overflow === "scroll")
      .slice(0, 5);
  });
  console.log(`   🔎 Scrollable containers found:`);
  containerInfo.forEach((c, i) => console.log(`      [${i}] <${c.tag}> class="${c.cls}" scrollH=${c.scrollH} clientH=${c.clientH} overflow=${c.overflow}`));

  const members = await tp.evaluate(async () => {
    const map = new Map();
    let stale = 0;
    let last = 0;

    // Find the scrollable container that wraps the member table
    // Try multiple strategies in order of specificity
    const findContainer = () => {
      const table = document.querySelector("table");
      if (!table) return null;

      // Walk up from the table and find the first scrollable ancestor
      let el = table.parentElement;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 10) {
          return el;
        }
        el = el.parentElement;
      }
      return null; // fall back to window
    };

    const container = findContainer();

    for (let i = 0; i < 60; i++) {
      // Collect all visible rows
      const rows = Array.from(document.querySelectorAll("tr"));
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll("td")).map(td => td.innerText?.trim()).filter(Boolean);
        if (cells.length < 3) continue;
        const nameIdx = cells.findIndex(c => /^[A-Z][A-Z0-9_]{2,15}$/.test(c));
        const dmgIdx  = cells.findIndex(c => /^\d+\.?\d*[BbMmKk]$/.test(c));
        const cntIdx  = cells.findIndex(c => /^\d$/.test(c));
        if (nameIdx >= 0 && dmgIdx >= 0 && !map.has(cells[nameIdx])) {
          map.set(cells[nameIdx], {
            name: cells[nameIdx],
            participationCount: cntIdx >= 0 ? cells[cntIdx] : "?",
            totalDamage: cells[dmgIdx],
          });
        }
      }

      // Stale check — stop if no new members after 5 consecutive scrolls
      if (map.size === last) {
        if (++stale >= 5) break;
      } else {
        stale = 0;
        last = map.size;
      }

      // Scroll — try container first, fall back to window
      if (container) {
        container.scrollTop += 250;
      } else {
        window.scrollBy(0, 250);
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // Reset scroll position
    if (container) container.scrollTop = 0; else window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 500));

    return Array.from(map.values());
  });

  console.log(`   ✅ Found ${members.length} unique members`);

  // ---- Step 5: Click magnifier for each member ----
  console.log(`📋 Step 5: Extracting per-attempt data...`);
  const results = [];

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    console.log(`   🔍 [${i+1}/${members.length}] ${m.name}`);

    // Scroll member row into view
    await tp.evaluate(name => {
      const row = Array.from(document.querySelectorAll("tr")).find(r => r.innerText?.includes(name));
      row?.scrollIntoView({ block: "center", behavior: "instant" });
    }, m.name);
    await sleep(400);

    // Click the magnifier — the last <td> in the row usually contains it
    // Use dispatchEvent on whatever element is found (safe for SVG/img/button/div)
    const found = await tp.evaluate(name => {
      const rows = Array.from(document.querySelectorAll("tr"));
      for (const row of rows) {
        if (!row.innerText?.includes(name)) continue;

        const tds = Array.from(row.querySelectorAll("td"));
        if (!tds.length) continue;

        // Try last TD first (magnifier is usually at the end)
        const searchTds = [...tds].reverse();
        for (const td of searchTds) {
          // Find any clickable child inside this TD
          const clickable =
            td.querySelector("button") ||
            td.querySelector("[role='button']") ||
            td.querySelector("svg") ||
            td.querySelector("img") ||
            td.querySelector("a") ||
            td; // fallback: click the TD itself

          if (clickable) {
            clickable.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true }));
            return true;
          }
        }
      }
      return false;
    }, m.name);

    if (!found) {
      console.log(`   ⚠ Could not find magnifier for ${m.name}`);
      results.push({ ...m, attempts: [] });
      continue;
    }

    await sleep(2500);

    // Read attempt blocks from the detail panel
    const rawAttempts = await tp.evaluate(() => {
      const container =
        document.querySelector("[class*='modal']") ||
        document.querySelector("[class*='popup']") ||
        document.querySelector("[class*='detail']") ||
        document.querySelector("[class*='overlay']") ||
        document.body;

      const out = [];
      // Each attempt is a card with boss icon, name, level, damage
      const blocks = Array.from(container.querySelectorAll(
        "[class*='battle'], [class*='attempt'], [class*='record'], [class*='boss'], [class*='round'], [class*='stage']"
      ));

      for (const block of blocks) {
        const leafs = Array.from(block.querySelectorAll("*"))
          .filter(e => e.children.length === 0)
          .map(e => e.innerText?.trim())
          .filter(t => t);

        const icon    = block.querySelector("img");
        const iconSrc = icon?.src || "";
        const iconAlt = icon?.alt || "";
        const iconCls = icon?.className || "";

        // Boss name: medium-length text, not starting with digit, not a label
        const bossName  = leafs.find(t => t.length > 4 && !/^\d/.test(t) && !/(HARD|Level|Damage|Ultra|Nihilister|Rebuild)/.test(t));
        const fullName  = leafs.find(t => /(Ultra|Nihilister|Rebuild|H\.S\.T\.A|Z\.E\.U\.S|P\.S\.I\.D)/.test(t));
        const levelText = leafs.find(t => /Level\s*\d/.test(t));
        // Damage: large integer with commas (e.g. 54,346,671,149)
        const damage    = leafs.find(t => /^\d{1,3}(,\d{3}){3,}$/.test(t));

        if (damage) {
          out.push({
            bossName: fullName || bossName || "?",
            level: levelText || "?",
            damage,
            iconSrc, iconAlt, iconCls,
          });
        }
      }
      return out;
    });

    const processed = rawAttempts.map(a => {
      const bossElem = detectElement(a.iconSrc, a.iconAlt, a.iconCls);
      const weakness = bossElem ? WEAKNESS_MAP[bossElem] : null;
      const color    = weakness ? ELEMENT_COLORS[weakness] : null;
      return { bossName: a.bossName, level: a.level, damage: a.damage, bossElement: bossElem, weakness, color };
    });

    console.log(`      ↳ ${processed.length} attempt(s) found`);
    processed.forEach((a, idx) => {
      console.log(`         #${idx+1} ${a.bossName} | Boss: ${a.bossElement||"?"} → Weakness: ${a.weakness||"?"} | ${a.damage}`);
    });

    results.push({ ...m, attempts: processed });

    // Close the detail panel
    await tp.keyboard.press("Escape");
    await sleep(500);
    await tp.evaluate(() => {
      const close = document.querySelector(
        "[class*='close'], [class*='back'], [aria-label*='close'], [aria-label*='back'], button[class*='close']"
      );
      if (close) close.dispatchEvent(new MouseEvent("click", { view: window, bubbles: true, cancelable: true }));
    });
    await sleep(800);
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
    cols.push({ key: `a${i}_boss`,     header: `Attempt ${i} Boss` });
    cols.push({ key: `a${i}_level`,    header: `Attempt ${i} Level` });
    cols.push({ key: `a${i}_bossElem`, header: `Attempt ${i} Boss Element` });
    cols.push({ key: `a${i}_weakness`, header: `Attempt ${i} Weakness` });
    cols.push({ key: `a${i}_damage`,   header: `Attempt ${i} Damage` });
  }
  const rows = results.map(r => {
    const row = { member: r.name, participation: r.participationCount, total_damage: r.totalDamage };
    for (let i = 0; i < maxA; i++) {
      const a = r.attempts?.[i];
      row[`a${i+1}_boss`]     = a?.bossName    || "-";
      row[`a${i+1}_level`]    = a?.level        || "-";
      row[`a${i+1}_bossElem`] = a?.bossElement  || "-";
      row[`a${i+1}_weakness`] = a?.weakness     || "-";
      row[`a${i+1}_damage`]   = a?.damage       || "-";
    }
    return row;
  });
  return stringify(rows, { header: true, columns: cols });
}

function buildHTML(results) {
  const maxA = Math.max(...results.map(r => r.attempts?.length || 0), 3);
  const badge = elem => {
    if (!elem) return "—";
    const c = ELEMENT_COLORS[elem] || "#ccc";
    return `<span style="padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;background:${c};color:#fff;letter-spacing:.5px">${elem.toUpperCase()}</span>`;
  };
  let hdr = `<tr><th rowspan="2">Member</th><th rowspan="2">Count</th><th rowspan="2">Total DMG</th>`;
  for (let i = 1; i <= maxA; i++) hdr += `<th colspan="3">Attempt ${i}</th>`;
  hdr += `</tr><tr>`;
  for (let i = 1; i <= maxA; i++) hdr += `<th>Boss</th><th>Weakness</th><th>Damage</th>`;
  hdr += `</tr>`;

  let body = "";
  for (const r of results) {
    body += `<tr><td class="name">${r.name}</td><td class="c">${r.participationCount}</td><td class="dmg">${r.totalDamage}</td>`;
    for (let i = 0; i < maxA; i++) {
      const a = r.attempts?.[i];
      if (!a) { body += `<td class="dash">—</td><td class="dash">—</td><td class="dash">—</td>`; continue; }
      const bg = a.color ? a.color + "22" : "transparent";
      const fg = a.color || "#333";
      body += `<td style="font-size:11px;line-height:1.4">${a.bossName}<br><span style="color:#999;font-size:10px">${a.level}</span></td>`;
      body += `<td class="c">${badge(a.weakness)}</td>`;
      body += `<td class="dmg" style="background:${bg};color:${fg}">${a.damage}</td>`;
    }
    body += `</tr>`;
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Union Raid Day 2</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#f5f5f5;padding:2rem}
h1{font-size:18px;font-weight:500;margin-bottom:1rem;color:#1a1a1a}
.legend{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:1rem;font-size:12px;color:#666;align-items:center}
.dot{width:10px;height:10px;border-radius:2px;display:inline-block;margin-right:3px}
.wrap{overflow-x:auto;background:#fff;border-radius:10px;border:0.5px solid #eee}
table{border-collapse:collapse;font-size:12px;white-space:nowrap;width:100%}
th{background:#f0f0f0;color:#555;font-size:11px;padding:7px 10px;border:0.5px solid #eee;text-align:center}
td{padding:6px 10px;border:0.5px solid #eee;color:#1a1a1a}
td.name{font-weight:600;position:sticky;left:0;background:#fff;z-index:1}
td.c{text-align:center}
td.dmg{text-align:right;font-weight:500;font-variant-numeric:tabular-nums}
td.dash{text-align:center;color:#ccc}
tr:hover td{filter:brightness(0.97)}
</style></head><body>
<h1>🛡 Union Raid — Day 2 (Hard)</h1>
<div class="legend">
  <span style="font-weight:500;color:#333">Weakness:</span>
  <span><span class="dot" style="background:#D3361E"></span>Fire</span>
  <span><span class="dot" style="background:#86C67C"></span>Wind</span>
  <span><span class="dot" style="background:#F0B27A"></span>Iron</span>
  <span><span class="dot" style="background:#8C79C5"></span>Electric</span>
  <span><span class="dot" style="background:#74B4E7"></span>Water</span>
</div>
<div class="wrap"><table><thead>${hdr}</thead><tbody>${body}</tbody></table></div>
</body></html>`;
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

  fs.writeFileSync(OUTPUT_FILE, buildCSV(results), "utf-8");
  console.log(`\n📄 CSV saved: ${OUTPUT_FILE}`);

  const htmlFile = OUTPUT_FILE.replace(".csv", ".html");
  fs.writeFileSync(htmlFile, buildHTML(results), "utf-8");
  console.log(`🌐 HTML saved: ${htmlFile}`);

  console.log(`\n📊 Done: ${results.length} members | ${results.filter(r => r.attempts?.length > 0).length} with attempt data`);
}

if (isLoginMode) runLoginMode().catch(console.error);
else runScrapeMode().catch(console.error);