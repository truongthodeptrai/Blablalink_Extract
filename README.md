# BlablaLink NIKKE Scraper

Scrapes **Increase ATK** and **Increase Elemental Damage Dealt** for any combination of members × nikkees, and saves results to `output.csv`.

---

## Setup

- Download an IDE you want (recommend Visual Studio Code)
- After finishing the download, open VS Code and then open the "Blablalink_Extract" folder
- Go to the official Node.js online and follow its instructions to download it
- After finishing the Node.js download, go back to VS Code and do Ctrl + ` to open the terminal and type:

```bash
npm install
```
- For Windows users, if it shows something like "running scripts is disable on this system", run
```bash
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```
if it works, type
```bash
npm install
```
if it gives an error of "Could not read package.json" (because you accidentally have a Blablalink_Extract folder inside the BLABLALINK_EXTRACT project, try using this
```bash
cd Blablalink_Extract
```
then do
```bash
npm install
```

---

## Step 1 — Fill in input.csv

Edit `input.csv` with your members and the Nikke IDs you want:

```
# MEMBERS
name,uid
Alice,UIDHere
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

Choose the nikke that you want to extract the data based on the list order, for example
```
:clipboard: Available Nikkes:
   1. [ID: 16] Rapi: Red Hood
   2. [ID: 470] Red Hood
   3. [ID: 851] Raven
   4. [ID: 162]  Mihara: Bonding Chain
   5. [ID: 75]  Diesel: Winter Sweets
   6. [ID: 471]  Snow White: Heavy Arms
   7. [ID: 234]  Dorothy: Serendipity
   8. [ID: 502]  Elegg: Boom and Shock
   9. [ID: 170]  Privaty
   10. [ID: 262]  Liberalio
   11. [ID: 225]  Scarlet: Black Shadow
   12. [ID: 223]  Nayuta
   13. [ID: 513]  Little Mermaid
   14. [ID: 835]  Asuka: Wille
   15. [ID: 511]  Cinderella
   16. [ID: 15]  Anis: Sparkling Summer
   17. [ID: 183]  Maiden: Ice Rose
   18. [ID: 281]  Moran
   19. [ID: 17]  Anis: Star
   20. [ID: 18]  Neon: Vision Eye
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


## WAWRNING: This project is mostly coded by AI so the result isn't 100% accurate. But from my tests, the accuracy is above 90%
