# BlablaLink NIKKE Scraper

Scrapes **Increase Attack** and **Increase Elemental Damage Dealt** for any combination of members × Nikkes, and saves results to `output.csv`.

---

## Setup

```bash
npm install
```

---

## Step 1 — Fill in input.csv

Edit `input.csv` with your members and the Nikke IDs you want:

```
# MEMBERS
name,uid
Alice,MjkwODAtNzU0NjExMTU3NzcyNjczNjM1
Bob,AnotherUIDHere

# NIKKES
nikke_id,nikke_name
16,Rapi: Red Hood
1,Rapi
5,Anis
```

**Where to find a UID:**
Open any BlablaLink profile URL — the `uid=` parameter is the member's UID:
`https://www.blablalink.com/shiftyspad/nikke?from=list&nikke=16&uid=MjkwODAtNzU0NjExMTU3NzcyNjczNjM1`

---

## Step 2 — Log in (first time only)

```bash
node scraper.js --login
# or: npm run login
```

A browser opens → log in → press ENTER → session saved to `cookies.json`.

> Redo this step if your session expires and you start getting empty results.

---

## Step 3 — Run the scraper

```bash
node scraper.js
# or: npm start
```

Results are saved to `output.csv`.

---

## Output format

| Member Name | Member UID | Nikke ID | Nikke Name | Increase Attack | Increase Elemental Damage Dealt | Error |
|---|---|---|---|---|---|---|
| Alice | Mjkw... | 16 | Rapi: Red Hood | 45.5% | 12.3% | |
| Bob | XYZ... | 16 | Rapi: Red Hood | 38.2% | 9.1% | |

---

## Adding new members or Nikkes

Just edit `input.csv` — no code changes needed.

- New member → add a row under `# MEMBERS`
- New Nikke → add a row under `# NIKKES`

---

## Files

| File | Purpose |
|---|---|
| `input.csv` | Your roster (members + Nikke IDs) |
| `output.csv` | Scraped results |
| `cookies.json` | Your login session — **do not share this** |
| `debug-*.png` | Screenshots saved when stats aren't found |
